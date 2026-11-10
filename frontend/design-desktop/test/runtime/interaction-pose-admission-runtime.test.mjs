import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NativePreparation } from '../../src/preparation.mjs'

const root = new URL('../../../../', import.meta.url)
const binary = process.env.DESIGN_PREPARE_BINARY || fileURLToPath(new URL('../../dist/bin/design-prepare', import.meta.url))
const font = fileURLToPath(new URL('frontend/design-client/public/fonts/NotoSansSC.ttf', root))
const docId = '00000000-0000-4000-8000-000000000001'
const pageId = '00000000-0000-4000-8000-000000000002'
const nodeId = '00000000-0000-4000-8000-000000000003'
const document = {
  schemaVersion: 2, id: docId, name: 'Native pose admission', rasterProfile: 'analytic',
  pages: [{ id: pageId, name: 'Page', background: '#ffffff', children: [nodeId] }],
  nodes: { [nodeId]: { id: nodeId, name: 'Rectangle', kind: 'rectangle', width: 160, height: 96, transform: [1, 0, 0, 1, 10, 20], fills: [{ kind: 'solid', color: '#f4c542' }] } },
}
const pose = JSON.stringify({ [nodeId]: [1, 0, 0, 1, 22, 28] })
const options = JSON.stringify({ pageId, width: 64, height: 64, view: { x: 0, y: 0, zoom: 1 }, rasterProfile: 'analytic', grid: false })

test('native preparation admits readonly interaction pose damage and still rejects unknown methods and lanes', async () => {
  const host = new NativePreparation(binary, font)
  const call = (method, args = [], lane = 'interaction') => host.request({ lane, method, args })
  try {
    assert.equal((await call('initialize', [false])).error, undefined)
    assert.equal((await call('load_document', [JSON.stringify(document)])).error, undefined)
    const beforePixels = await call('render_cpu_frame', [options])
    assert.equal(beforePixels.error, undefined)
    assert.ok(beforePixels.value instanceof Uint8Array)
    assert.ok(beforePixels.value.byteLength > 0)
    const before = host.sequence
    const reply = await call('interaction_pose_damage', [pose])
    assert.equal(reply.error, undefined)
    assert.equal(host.sequence, before + 1)
    const damage = JSON.parse(reply.value)
    assert.equal(damage.full, false)
    assert.equal(damage.translationOnly, true)
    const afterPixels = await call('render_cpu_frame', [options])
    assert.deepEqual(afterPixels.value, beforePixels.value)
    const wrongLane = await call('interaction_pose_damage', [pose], 'canvas')
    assert.match(wrongLane.error, /Invalid interaction transforms/)
    assert.equal(host.closed, false)
    const rejectedAt = host.sequence
    await assert.rejects(call('not-a-method'), /Invalid native preparation request/)
    await assert.rejects(call('interaction_pose_damage', ['{}'], 'untrusted-lane'), /Invalid native preparation request/)
    await assert.rejects(call('load_source_snapshot', ['{}'], 'canvas'), /Invalid native preparation request/)
    assert.equal(host.sequence, rejectedAt)
    assert.equal((await call('stats')).error, undefined)
  } finally {
    await host.close()
    assert.equal(host.pending.size, 0)
    assert.equal(host.reservations.size, 0)
  }
})
