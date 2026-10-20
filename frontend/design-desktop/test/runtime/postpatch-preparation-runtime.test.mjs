import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { NativePreparation } from '../../src/preparation.mjs'
import { connectNativePreparation } from '../../../design-client/src/kernel/native-preparation.ts'
const binary = process.env.DESIGN_PREPARE_BINARY
assert.ok(binary, 'DESIGN_PREPARE_BINARY must name the same-cohort guarded-CAS sidecar; do not use an older binary')
const font = fileURLToPath(new URL('../../../design-client/public/fonts/NotoSansSC.ttf', import.meta.url))
const document = { schemaVersion: 2, rasterProfile: 'analytic', id: 'postpatch-native', name: 'Authored source',
  extension: { absent: null, unknown: ['preserved'] }, pages: [{ id: 'p', name: 'Page', children: ['r'], background: '#ffffff' }],
  nodes: { r: { id: 'r', name: 'Rectangle', kind: 'rectangle', width: 18, height: 13, transform: [1, 0, 0, 1, 4, 6], opacity: 1,
    fills: [{ kind: 'solid', color: '#2277bb' }], extension: { unknownNode: true } } } }
const options = JSON.stringify({ pageId: 'p', width: 40, height: 40, view: { x: .125, y: -.375, zoom: 1 }, grid: false })
function connected(host) {
  const pair = new MessageChannel(), pending = new Map(), failures = []
  let id = 0, retired = false, uncertain = false, connection
  const fail = error => {
    failures.push(error); retired = true
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear(); connection?.close()
  }
  connection = connectNativePreparation({ open: async () => 'verified-owner', close: async () => host.close(),
    request: async (owner, request) => {
      assert.equal(owner, 'verified-owner')
      if (uncertain) { await host.request(request); throw Error('Simulated uncertain IPC rejection after native mutation') }
      return host.request(request)
    } }, pair.port1, fail)
  pair.port2.onmessage = event => {
    if (event.data.fatal) { if (!retired) fail(Error(event.data.fatal)); return }
    const waiter = pending.get(event.data.id)
    if (!waiter) return
    pending.delete(event.data.id)
    if (event.data.error) waiter.reject(Error(event.data.error)); else waiter.resolve(event.data)
  }
  pair.port2.start()
  const call = (method, args = [], lane = 'canvas') => {
    if (retired) return Promise.reject(Error('Renderer native session retired'))
    const key = ++id
    return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); pair.port2.postMessage({ id: key, lane, method, args }) })
  }
  return { call, failures, makeUncertain: () => { uncertain = true }, close: async () => { connection.close(); pair.port2.close(); await host.close() } }
}
test('real renderer adapter→host→Rust preserves definitive CAS rejection and matches full-load packet/pixel/PNG after edit/undo/redo', async () => {
  const host = new NativePreparation(binary, font), oracle = new NativePreparation(binary, font), client = connected(host)
  const oracleCall = (method, args = []) => oracle.request({ lane: 'canvas', method, args })
  try {
    assert.equal((await client.call('preparation_capabilities_v1')).value.guardedPatchReceiptV1, true)
    await client.call('initialize', [false]); await client.call('initialize', [false], 'interaction'); await oracleCall('initialize', [false])
    let sourceReceipt = (await client.call('load_document', [JSON.stringify(document)])).stateReceipt
    let targetReceipt = null, operationId = 0
    const moved = { ...document, nodes: { ...document.nodes, r: { ...document.nodes.r, transform: [1, 0, 0, 1, 11.375, 8], opacity: .6 } } }
    for (const target of [moved, document, moved]) {
      const patch = JSON.stringify({ nodes: { r: target.nodes.r }, fields: {} })
      const ack = await client.call('apply_document_patch_with_damage', [patch, { expectedBaseReceipt: sourceReceipt }])
      assert.ok(ack.stateReceipt); assert.notDeepEqual(ack.stateReceipt, sourceReceipt); sourceReceipt = ack.stateReceipt
      const derive = await client.call('derive_document_v1', [{ operationId: ++operationId, baseReceipt: sourceReceipt, target: 'interaction', expectedTarget: targetReceipt, delta: [] }], 'interaction')
      targetReceipt = derive.stateReceipt; assert.equal(derive.documentFork, true)
      await oracleCall('load_document', [JSON.stringify(target)])
      for (const method of ['compile_gpu_packet', 'render_cpu_frame', 'render_png']) {
        const actual = await client.call(method, [options], 'interaction'), expected = await oracleCall(method, [options])
        assert.equal(expected.error, undefined); assert.deepEqual(actual.value, expected.value)
      }
    }
    const before = (await client.call('compile_gpu_packet', [options])).value
    const stale = { ...sourceReceipt, nonce: 'stale' }
    await assert.rejects(client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: stale }]), /STALE_BASE/)
    await assert.rejects(client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: sourceReceipt, extra: true }]), /PATCH_GUARD_SCHEMA/)
    assert.equal(host.closed, false); assert.equal(client.failures.length, 0)
    assert.deepEqual((await client.call('compile_gpu_packet', [options])).value, before)
    // Both rejected operations preserved the actual old receipt, not just pixels.
    sourceReceipt = (await client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: sourceReceipt }])).stateReceipt
    const resourceAck = await client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: { fonts: {} } })])
    await assert.rejects(client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: sourceReceipt }]), /STALE_BASE/)
    assert.equal(host.closed, false); assert.equal(client.failures.length, 0)
    assert.ok(resourceAck.stateReceipt)
    assert.deepEqual(document.extension, { absent: null, unknown: ['preserved'] })
    assert.deepEqual(document.nodes.r.extension, { unknownNode: true })
  } finally { await client.close(); await oracle.close() }
})
test('uncertain mutation IPC rejection still retires renderer native session without replay', async () => {
  const host = new NativePreparation(binary, font), client = connected(host)
  try {
    await client.call('initialize', [false]); const loaded = await client.call('load_document', [JSON.stringify(document)])
    client.makeUncertain()
    await assert.rejects(client.call('apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: loaded.stateReceipt }]), /uncertain IPC/)
    assert.equal(client.failures.length, 1)
    await assert.rejects(client.call('stats'), /retired/)
    assert.equal(host.closed, true)
  } finally { await client.close() }
})
