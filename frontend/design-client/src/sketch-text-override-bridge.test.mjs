import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { SketchSessionHost } from '../../design-desktop/src/sketch-session.mjs'
import { validSketchTextOverride } from '../../design-desktop/src/sketch-session-contract.mjs'
import { SketchEditSession } from './sketch-edit-session.ts'
import { parseSketchTextOverrideDraft } from './sketch-text-override-draft.ts'

const snapshot = (owner, revision = 0) => ({ owner, active: true, revision, savedRevision: 0, saveUncertain: false, dirty: revision !== 0,
  undoCount: revision ? 1 : 0, redoCount: 0, layers: [{ id: 'I', name: 'Instance', pageId: 'P', depth: 1 }], layersTruncated: false, persistence: 'memory-only-unsaved' })
test('text override fixed preload/host route admits only fenced native ID paths and UTF-16 text', async () => {
  const calls = [], window = { isDestroyed: () => false }
  let native, api
  const host = new SketchSessionHost(async (method, p) => {
    calls.push({ method, p })
    if (method === 'sketch.session.open') return native = snapshot({ kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: p.documentId, session_epoch: p.sessionEpoch })
    assert.equal(method, 'sketch.session.setTextOverride')
    assert.match(p.requestId, /^[a-f\d-]{36}$/)
    assert.deepEqual(Object.keys(p).sort(), ['expectedRevision', 'instanceId', 'owner', 'requestId', 'targetPath', 'text'])
    native = { ...native, revision: native.revision + 1, dirty: true, undoCount: 1 }; return native
  }, { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/native.sketch'] }) }, () => window)
  const ipcCalls = [], ipcRenderer = { invoke: async (channel, value) => {
    ipcCalls.push(channel)
    if (channel === 'design-desktop:sketch-session-open') return host.open(value)
    assert.equal(channel, 'design-desktop:sketch-session-set-text-override'); return host.setTextOverride(value)
  } }
  const preload = await readFile(new URL('../../design-desktop/src/preload.cjs', import.meta.url), 'utf8')
  vm.runInNewContext(preload, { process: { argv: [] }, require: name => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (_, value) => { api = value } } } } })
  assert.equal(Object.isFrozen(api.sketchSession), true)
  const opened = await api.sketchSession.open(), valid = { owner: opened.owner, expectedRevision: 0, instanceId: 'I', targetPath: 'NESTED/TEXT', text: ' 中文 😀\n ' }
  for (const patch of [
    { owner: { ...opened.owner, kernel_id: 'figma' } }, { owner: { ...opened.owner, document_schema: 'other' } },
    { owner: { ...opened.owner, document_id: 'other' } }, { owner: { ...opened.owner, session_epoch: 2 } },
    { expectedRevision: 1 }, { targetPath: '/tmp/file' }, { targetPath: 'NESTED//TEXT' }, { targetPath: Array(65).fill('T').join('/') },
    { instanceId: '😀'.repeat(33) }, { targetPath: 'NESTED/\u0000' }, { text: '😀'.repeat(50000) + 'x' },
    { path: '/renderer/file.sketch' }, { requestId: 'renderer-controlled' }, { command: { kind: 'rename_layer' } },
  ]) await assert.rejects(api.sketchSession.setTextOverride({ ...valid, ...patch }))
  assert.equal(calls.length, 1, 'invalid requests never reach the native transport')
  assert.equal(validSketchTextOverride({ instanceId: 'I', targetPath: 'T', text: '😀'.repeat(50000) }), true)
  assert.equal((await api.sketchSession.setTextOverride(valid)).revision, 1)
  assert.equal(calls.at(-1).p.text, valid.text, 'authored whitespace, newline and surrogate pair remain exact')
  await assert.rejects(api.sketchSession.setTextOverride(valid))
  assert.equal((await api.sketchSession.setTextOverride({ ...valid, expectedRevision: 1, text: '' })).revision, 2)
  assert.equal(calls.length, 3)
  assert.equal(ipcCalls.at(-1), 'design-desktop:sketch-session-set-text-override')
})

test('text override UI preserves failed drafts, requires explicit clear and never replays pending or uncertain writes', async () => {
  const owner = { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: 'native', session_epoch: 1 }
  let native = snapshot(owner), finish, attempts = 0, wrongOwner = false
  const bridge = {
    open: async () => ({ status: 'ok', ...native, displayName: 'native.sketch' }),
    status: async () => ({ status: 'ok', ...native, owner: wrongOwner ? { ...owner, session_epoch: 2 } : owner }),
    setTextOverride: p => { assert.deepEqual(p.owner, owner); assert.equal(p.expectedRevision, native.revision); attempts++; return new Promise(resolve => { finish = resolve }) },
    undo: async p => { assert.equal(p.expectedRevision, 1); native = { ...native, revision: 2, undoCount: 0, redoCount: 1 }; return { status: 'ok', ...native } },
    redo: async p => { assert.equal(p.expectedRevision, 2); native = { ...native, revision: 3, undoCount: 1, redoCount: 0 }; return { status: 'ok', ...native } },
  }
  const controller = new SketchEditSession(bridge); await controller.open()
  const draft = { targetPath: 'NESTED/TEXT', text: ' 😀\n ', clearText: false }, unchanged = { ...draft }
  assert.equal(parseSketchTextOverrideDraft('I', { ...draft, text: '' }), null)
  assert.deepEqual(parseSketchTextOverrideDraft('I', { ...draft, text: '', clearText: true }), { instanceId: 'I', targetPath: draft.targetPath, text: '' })
  assert.equal(parseSketchTextOverrideDraft('I', { ...draft, targetPath: 'NESTED//TEXT' }), null)
  const value = parseSketchTextOverrideDraft('I', draft)
  const submit = () => controller.setTextOverride(value.instanceId, value.targetPath, value.text)
  const failed = submit(); await submit(); assert.equal(attempts, 1); assert.equal(controller.getSnapshot().pending, true)
  finish({ status: 'error', message: 'Unsupported external master' }); await failed
  assert.deepEqual(draft, unchanged); assert.equal(controller.getSnapshot().session.revision, 0)
  assert.equal(controller.getSnapshot().session.dirty, false); assert.match(controller.getSnapshot().error, /未重试/)
  const lost = submit(); native = snapshot(owner, 1); finish({ status: 'error', message: 'Reply lost after commit' }); await lost
  assert.equal(controller.getSnapshot().session.revision, 1); assert.equal(controller.getSnapshot().uncertain, false); assert.equal(attempts, 2)
  await controller.undo(); await controller.redo(); assert.equal(controller.getSnapshot().session.revision, 3)
  const unverified = submit(); wrongOwner = true; finish({ status: 'error', message: 'Unknown outcome' }); await unverified
  assert.equal(controller.getSnapshot().uncertain, true); await submit(); assert.equal(attempts, 3)
  wrongOwner = false; await controller.refresh()
  const retired = submit(); controller.dispose(); finish({ status: 'ok', ...snapshot(owner, 4) }); await retired
  assert.equal(controller.getSnapshot().session.revision, 3, 'retired UI cannot accept a late result')
})
