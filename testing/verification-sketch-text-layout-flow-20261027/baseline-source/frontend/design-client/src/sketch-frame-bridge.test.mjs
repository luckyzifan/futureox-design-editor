import test from 'node:test'
import assert from 'node:assert/strict'
import { SketchEditSession } from './sketch-edit-session.ts'
import { parseSketchFrameDraft } from './sketch-frame-draft.ts'
import { SketchSessionHost } from '../../design-desktop/src/sketch-session.mjs'
test('frame-only host/UI route fences numbers and revision; failed input is retained without replay or dirty success', async () => {
  const window = { isDestroyed: () => false }, calls = []
  let native, pending, rejectFrame = true
  const host = new SketchSessionHost(async (method, p) => {
    calls.push({ method, p })
    if (method === 'sketch.session.open') return native = { owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: p.documentId, session_epoch: p.sessionEpoch }, active: true, revision: 0, savedRevision: 0, saveUncertain: false, dirty: false,
      undoCount: 0, redoCount: 0, layers: [{ id: 'R', pageId: 'P', depth: 1, name: 'Rectangle' }], layersTruncated: false, persistence: 'memory-only-unsaved' }
    if (method === 'sketch.session.status') return native
    if (method === 'sketch.session.leafFrame') return { owner: native.owner, revision: native.revision, layerId: 'R', frame: { x: 2, y: 3, width: 10, height: 12 }, reason: null }
    if (method === 'sketch.session.setLeafFrame') return new Promise((resolve, reject) => { pending = () => { if (rejectFrame) reject(new Error('Unsupported locked ancestry')); else { native = { ...native, revision: 1, dirty: true, undoCount: 1 }; resolve(native) } } })
    assert.fail(method)
  }, { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }) }, () => window)
  const invoke = async work => { try { return await work() } catch (e) { return { status: 'error', code: 'TEST', message: e.message } } }
  const controller = new SketchEditSession({ open: () => invoke(() => host.open()), status: p => invoke(() => host.status(p)), setLeafFrame: p => invoke(() => host.setLeafFrame(p)) })
  await controller.open(); const s = controller.getSnapshot().session
  assert.equal((await host.leafFrame({ owner: s.owner, expectedRevision: 0, layerId: 'R' })).frame.x, 2)
  await assert.rejects(host.setLeafFrame({ owner: s.owner, expectedRevision: 0, layerId: 'R', x: NaN, y: 0, width: 10, height: 10 }))
  await assert.rejects(host.setLeafFrame({ owner: s.owner, expectedRevision: 0, layerId: 'R', x: 0, y: 0, width: 10, height: 10, rawJson: '{}' }))
  const draft = { x: '-4', y: '7', width: '30', height: '20' }, copy = { ...draft }
  assert.equal(parseSketchFrameDraft({ ...draft, x: '' }), null)
  assert.equal(parseSketchFrameDraft({ ...draft, width: '0.1' }), null)
  const frame = parseSketchFrameDraft(draft)
  const first = controller.setLeafFrame('R', frame)
  await controller.setLeafFrame('R', frame); assert.equal(calls.filter(c => c.method.endsWith('setLeafFrame')).length, 1)
  pending(); await first
  assert.equal(controller.getSnapshot().session.revision, 0); assert.equal(controller.getSnapshot().session.dirty, false)
  assert.deepEqual(draft, copy); assert.match(controller.getSnapshot().error, /未重试/)
  rejectFrame = false; const second = controller.setLeafFrame('R', frame); pending(); await second
  assert.equal(controller.getSnapshot().session.revision, 1); assert.equal(controller.getSnapshot().session.dirty, true)
  assert.equal(calls.filter(c => c.method.endsWith('setLeafFrame')).length, 2)
})
