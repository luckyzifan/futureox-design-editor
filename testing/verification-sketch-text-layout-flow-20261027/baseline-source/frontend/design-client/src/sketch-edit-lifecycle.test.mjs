import test from 'node:test'
import assert from 'node:assert/strict'
import { SketchEditSession } from './sketch-edit-session.ts'
import { SketchSessionHost } from '../../design-desktop/src/sketch-session.mjs'
test('real host and UI recover lost open/close replies by owner status without replay or false network success', async () => {
  let native, failStatus = true, openCalls = 0, closeCalls = 0
  const host = new SketchSessionHost(async (method, params) => {
    if (method === 'sketch.session.open') {
      openCalls++
      native = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: params.documentId, session_epoch: params.sessionEpoch }, active: true, revision: 0, savedRevision: 0, saveUncertain: false,
        dirty: false, undoCount: 0, redoCount: 0, layers: [], layersTruncated: false, persistence: 'memory-only-unsaved' }
      throw new Error('Open response lost')
    }
    if (method === 'sketch.session.status') { if (failStatus) throw new Error('Transport unavailable'); return native }
    if (method === 'sketch.session.close') { closeCalls++; native = { ...native, active: false }; throw new Error('Close response lost') }
    assert.fail(method)
  }, { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }) }, () => window)
  const window = { isDestroyed: () => false }
  const invoke = async f => { try { return await f() } catch (error) { return { status: 'error', code: error.code || 'BACKEND_UNAVAILABLE', message: error.message } } }
  const controller = new SketchEditSession({ open: () => invoke(() => host.open()), status: p => invoke(() => host.status(p)), close: p => invoke(() => host.close(p)) })
  await controller.open(); assert.equal(controller.getSnapshot().uncertain, true)
  assert.equal(await controller.close(), false, 'unknown open cannot be silently dismissed')
  await controller.open(); assert.equal(openCalls, 1); assert.equal(controller.getSnapshot().uncertain, true)
  failStatus = false
  await controller.open(); assert.equal(openCalls, 1); assert.equal(controller.getSnapshot().session.active, true)
  failStatus = true
  assert.equal(await controller.close(), false); assert.equal(closeCalls, 0, 'network failure is not typed closed')
  failStatus = false
  assert.equal(await controller.close(), true); assert.equal(closeCalls, 1); assert.equal(controller.getSnapshot().session, null)
  assert.equal(await host.beforeWindowClose(), true)
})
