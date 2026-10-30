import test from 'node:test'
import assert from 'node:assert/strict'
import { SketchSessionHost } from '../../design-desktop/src/sketch-session.mjs'
import { SketchEditSession } from './sketch-edit-session.ts'
test('legacy resize host and controller fence identities and never replay uncertain mutations', async () => {
  const win = { isDestroyed: () => false }; let native, finish, writes = 0, failStatus = false
  const host = new SketchSessionHost(async (method, p) => {
    if (method === 'sketch.session.open') return native = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: p.documentId, session_epoch: p.sessionEpoch }, active: true, revision: 0, savedRevision: 0, saveUncertain: false, dirty: false, undoCount: 0, redoCount: 0, layers: [], layersTruncated: false, persistence: 'memory-only-unsaved' }
    if (method === 'sketch.session.status') { if (failStatus) throw new Error('offline'); return native }
    assert.equal(method, 'sketch.session.resizeLegacyContainer'); assert.match(p.requestId, /^[a-f\d-]{36}$/)
    assert.deepEqual(Object.keys(p).sort(), ['expectedRevision', 'height', 'layerId', 'owner', 'requestId', 'width'])
    writes++; return new Promise((resolve, reject) => { finish = { resolve, reject } })
  }, { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }) }, () => win)
  const bridge = { open: () => host.open(), status: p => host.status(p), resizeLegacyContainer: p => host.resizeLegacyContainer(p) }
  const c = new SketchEditSession(bridge); await c.open()
  const valid = { owner: native.owner, expectedRevision: 0, layerId: 'G', width: 200, height: 200 }
  for (const patch of [{ width: NaN }, { height: 0 }, { width: Infinity }, { path: '/injected.sketch' }, { expectedRevision: 1 }, { owner: { ...native.owner, session_epoch: 2 } }]) await assert.rejects(host.resizeLegacyContainer({ ...valid, ...patch }))
  assert.equal(writes, 0)
  const pending = c.resizeLegacyContainer('G', 200, 200); await c.resizeLegacyContainer('G', 300, 300); assert.equal(writes, 1)
  finish.reject(new Error('unsupported nested child')); await pending; assert.equal(c.getSnapshot().session.revision, 0); assert.equal(c.getSnapshot().session.dirty, false)
  const lost = c.resizeLegacyContainer('G', 200, 200)
  native = { ...native, revision: 1, dirty: true, undoCount: 1 }; finish.reject(new Error('lost reply')); await lost
  assert.equal(writes, 2); assert.equal(c.getSnapshot().session.revision, 1); assert.equal(c.getSnapshot().uncertain, false)
  await assert.rejects(host.resizeLegacyContainer(valid))
  const unknown = c.resizeLegacyContainer('G', 300, 300); failStatus = true; finish.reject(new Error('unknown')); await unknown
  assert.equal(c.getSnapshot().uncertain, true); await c.resizeLegacyContainer('G', 400, 400); assert.equal(writes, 3)
})
