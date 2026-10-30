import test from 'node:test'
import assert from 'node:assert/strict'
import { SketchSessionHost } from '../src/sketch-session.mjs'
test('native session bridge fences ownership and confirms discard after a lost rename reply', async () => {
  const window = { isDestroyed: () => false }, calls = []
  let native, confirmations = 0, confirm = 0, loseReply = true
  const host = new SketchSessionHost(async (method, p) => {
    calls.push({ method, p })
    if (method === 'sketch.session.open') return native = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: p.documentId, session_epoch: p.sessionEpoch }, active: true, revision: 0, savedRevision: 0, saveUncertain: false, undoCount: 0, redoCount: 0, layers: [{ id: 'P', name: 'Page', pageId: 'P', depth: 0 }], layersTruncated: false, dirty: false, persistence: 'memory-only-unsaved' }
    if (method === 'sketch.session.rename') { native = { ...native, revision: 1, dirty: true, undoCount: 1 }; if (loseReply) throw new Error('Reply lost'); return native }
    if (method === 'sketch.session.status') return native
    if (method === 'sketch.session.undo') { native = { ...native, revision: 2, undoCount: 0, redoCount: 1 }; return native }
    if (method === 'sketch.session.redo') { native = { ...native, revision: 3, undoCount: 1, redoCount: 0 }; return native }
    if (method === 'sketch.session.saveAs') { assert.equal(p.path, '/tmp/saved.sketch'); return { ...native, saveWarning: 'Simulated durability warning', saveUncertain: true } }
    if (method === 'sketch.session.close') { assert.equal(p.expectedRevision, 3); assert.equal(p.discard, true); native = undefined; return {} }
    assert.fail(method)
  }, {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }),
    showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/saved.sketch' }),
    showMessageBox: async () => { confirmations++; return { response: confirm } },
  }, () => window)
  await assert.rejects(host.open({ path: '/untrusted/file.sketch' }))
  const opened = await host.open()
  assert.equal(opened.path, undefined); assert.equal(opened.handle, undefined)
  assert.deepEqual((await host.open()).owner, opened.owner)
  await assert.rejects(host.rename({ owner: { ...opened.owner, session_epoch: 999 }, expectedRevision: 0, layerId: 'P', name: 'x' }))
  assert.equal(calls.filter(c => c.method.endsWith('rename')).length, 0)
  await assert.rejects(host.rename({ owner: opened.owner, expectedRevision: 0, layerId: 'P', name: 'Renamed' }))
  await assert.rejects(host.close({ owner: opened.owner, expectedRevision: 0, discard: false }))
  const reconciled = await host.status({ owner: opened.owner }); assert.equal(reconciled.revision, 1)
  await host.undo({ owner: opened.owner, expectedRevision: 1 })
  await host.redo({ owner: opened.owner, expectedRevision: 2 })
  await assert.rejects(host.saveAs({ owner: opened.owner, expectedRevision: 3, path: '/renderer/chosen.sketch' }))
  const saved = await host.saveAs({ owner: opened.owner, expectedRevision: 3 }); assert.equal(saved.dirty, true); assert.ok(saved.saveWarning)
  assert.equal(confirmations, 0)
  assert.equal((await host.close({ owner: opened.owner, expectedRevision: 3, discard: true })).status, 'cancelled')
  assert.equal(native.revision, 3)
  confirm = 1
  assert.equal(await host.beforeWindowClose(), true)
  assert.equal(native, undefined)
  assert.equal(confirmations, 2)
  assert.equal(calls.filter(c => c.method.endsWith('rename')).length, 1, 'never replay ambiguous writes')
  await assert.rejects(host.rename({ owner: opened.owner, expectedRevision: 1, layerId: 'P', name: 'Late' }))
})
