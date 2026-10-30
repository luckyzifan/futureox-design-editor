import test from 'node:test'
import assert from 'node:assert/strict'
import { SketchEditSession } from './sketch-edit-session.ts'
const owner = { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: 'native', session_epoch: 4 }
const snapshot = revision => ({ status: 'ok', owner, active: true, revision, savedRevision: 0, saveUncertain: false, dirty: revision !== 0,
  undoCount: revision ? 1 : 0, redoCount: 0, persistence: 'memory-only-unsaved', layers: [{ id: 'P', name: 'Page', pageId: 'P', depth: 0 }], layersTruncated: false })
test('UI owner blocks duplicate writes, reconciles failed mutation without replay, and ignores retired results', async () => {
  let resolve, calls = 0, native = snapshot(0), wrongOwner = false
  const bridge = {
    open: async () => ({ ...native, displayName: 'native.sketch' }),
    rename: async request => { assert.equal(request.expectedRevision, native.revision); calls++; return new Promise(done => { resolve = done }) },
    status: async () => wrongOwner ? { ...native, owner: { ...owner, session_epoch: 5 } } : native,
    undo: async request => { assert.equal(request.expectedRevision, 1); native = snapshot(2); return native },
    redo: async () => { native = snapshot(3); return native },
    close: async () => ({ status: 'cancelled' }),
  }
  const controller = new SketchEditSession(bridge)
  await controller.open()
  const pending = controller.rename('P', 'Rename')
  await controller.rename('P', 'Duplicate'); assert.equal(calls, 1)
  native = snapshot(1); resolve({ status: 'error', message: 'Reply lost' }); await pending
  assert.equal(controller.getSnapshot().session.revision, 1)
  assert.equal(controller.getSnapshot().uncertain, false)
  assert.match(controller.getSnapshot().error, /未重试/)
  await controller.undo(); await controller.redo(); assert.equal(controller.getSnapshot().session.revision, 3)
  wrongOwner = true; await controller.refresh(); assert.equal(controller.getSnapshot().uncertain, true)
  await controller.rename('P', 'Blocked'); assert.equal(calls, 1)
  wrongOwner = false; await controller.refresh()
  assert.equal(await controller.close(), false); assert.ok(controller.getSnapshot().session)
  const late = controller.rename('P', 'Late'); controller.dispose()
  resolve(snapshot(4)); await late
  assert.equal(controller.getSnapshot().session.revision, 3)
})
