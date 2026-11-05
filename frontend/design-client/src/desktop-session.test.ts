import { afterEach, describe, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { desktopBridge, type DesktopBridge, type DesktopFile, type DesktopResult } from './desktop'
import { DesktopSession, type LeaveDecision } from './desktop-session'
import { Backend } from './persistence'
import { registerPendingEdit } from './pending-edits'
import type { CodecDelta } from './resident-document-encoder'
// @ts-expect-error The actual host codec is an ESM module.
import { ResidentDocumentCodec } from '../../design-desktop/src/resident-document-codec.mjs'

const ok = { status: 'ok' } as const
const cancelled = { status: 'cancelled' } as const
const savedFile = { status: 'ok', handle: 'opaque:1', displayName: 'design.fd' } as const
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const sessions: DesktopSession[] = []
function fixture(decision: LeaveDecision = 'discard', initial = blank('Original')) {
  const editor = new Editor(initial)
  const bridge = {
    version: 1,
    renderPolicy: Object.freeze({ cpuOnly: true }),
    listCatalog: vi.fn<DesktopBridge['listCatalog']>().mockResolvedValue({ ...ok, projects: [], directories: [], files: [] }),
    selectCatalogDirectory: vi.fn<DesktopBridge['selectCatalogDirectory']>().mockResolvedValue(cancelled),
    scanCatalogDirectory: vi.fn<DesktopBridge['scanCatalogDirectory']>().mockResolvedValue({ ...ok, directoryId: 'directory', files: [], truncated: false }),
    openCatalogFile: vi.fn<DesktopBridge['openCatalogFile']>().mockResolvedValue(cancelled),
    openDocument: vi.fn<DesktopBridge['openDocument']>().mockResolvedValue(cancelled),
    acceptDocument: vi.fn<DesktopBridge['acceptDocument']>().mockResolvedValue(ok),
    saveDocument: vi.fn<DesktopBridge['saveDocument']>().mockResolvedValue(savedFile),
    readRecovery: vi.fn<DesktopBridge['readRecovery']>().mockResolvedValue(cancelled),
    acceptRecovery: vi.fn<DesktopBridge['acceptRecovery']>().mockResolvedValue(ok),
    writeRecovery: vi.fn<DesktopBridge['writeRecovery']>().mockResolvedValue(ok),
    clearRecovery: vi.fn<DesktopBridge['clearRecovery']>().mockResolvedValue(ok),
    setDirty: vi.fn<DesktopBridge['setDirty']>().mockResolvedValue(undefined),
    onCommand: vi.fn<DesktopBridge['onCommand']>().mockReturnValue(() => {}),
    onCloseRequested: vi.fn<DesktopBridge['onCloseRequested']>().mockReturnValue(() => {}),
    respondToClose: vi.fn<DesktopBridge['respondToClose']>().mockResolvedValue({ accepted: true }),
  } satisfies DesktopBridge
  const confirm = vi.fn<(reason: string) => Promise<LeaveDecision>>().mockResolvedValue(decision)
  const session = new DesktopSession(bridge, editor, confirm)
  sessions.push(session)
  const edit = (name: string) => editor.change('Rename', (doc) => { doc.name = name })
  const opening = (name = 'Opened') => ({ ...savedFile, documentJson: JSON.stringify(blank(name)) })
  const recovery = (name = 'Recovered') => ({ status: 'ok' as const, documentJson: JSON.stringify(blank(name)), displayName: name, recoveryHandle: 'recovery:opaque' })
  return { editor, bridge, confirm, session, edit, opening, recovery }
}
afterEach(() => {
  sessions.splice(0).forEach((session) => { session.dispose() })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('import adoption ownership', () => {
  test('a retired import is rejected before preparation or a discard prompt', async () => {
    const f = fixture(); await f.session.start()
    const before = f.editor.state.doc, message = f.editor.state.message
    expect(await f.session.replace({} as never, () => false)).toBe(false)
    expect(f.editor.state.doc).toBe(before)
    expect(f.editor.state.message).toBe(message)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  test.each(['save', 'discard'] as const)('invalidating a pending %s prompt cannot adopt its old import', async decision => {
    const f = fixture(); await f.session.start(); f.edit('Keep current')
    const before = f.editor.state.doc, prompt = deferred<LeaveDecision>()
    let current = true
    f.confirm.mockReturnValueOnce(prompt.promise)
    const pending = f.session.replace(blank('Obsolete import'), () => current)
    await turn()
    expect(f.confirm).toHaveBeenCalledTimes(1)
    current = false
    prompt.resolve(decision)
    expect(await pending).toBe(false)
    expect(f.editor.state.doc).toBe(before)
  })
  test('invalidating during the requested save preserves that acknowledgement without adopting the import', async () => {
    const f = fixture('save'); await f.session.start(); f.edit('Save current')
    const before = f.editor.state.doc, saving = deferred<DesktopResult<DesktopFile>>()
    let current = true
    f.bridge.saveDocument.mockReturnValueOnce(saving.promise)
    const pending = f.session.replace(blank('Obsolete import'), () => current)
    await turn()
    expect(f.bridge.saveDocument).toHaveBeenCalledTimes(1)
    current = false
    saving.resolve(savedFile)
    expect(await pending).toBe(false)
    expect(f.editor.state.doc).toBe(before)
    expect(f.session.dirty).toBe(false)
  })
  test('a current import still adopts normally and Cancel still preserves the current document', async () => {
    const f = fixture(); await f.session.start()
    expect(await f.session.replace(blank('Current import'), () => true)).toBe(true)
    expect(f.editor.state.doc.name).toBe('Current import')
    const before = f.editor.state.doc
    f.confirm.mockResolvedValueOnce('cancel')
    expect(await f.session.replace(blank('Cancelled import'), () => true)).toBe(false)
    expect(f.editor.state.doc).toBe(before)
  })
})

describe('native document lifecycle', () => {
  test('a new edit immediately releases stale encoded cache without dropping the exact saved baseline', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    const session = f.session as any, baseline = session.baselineJson
    expect(session.serializedJson).toBe(baseline)
    f.edit('Unsaved edit')
    expect(session.serializedJson).toBe('')
    expect(session.serializedGeneration).toBe(-1)
    expect(session.baselineJson).toBe(baseline)
    await session.captureSnapshot()
    expect(session.serializedJson).toContain('Unsaved edit')
    f.editor.undo()
    expect(session.serializedJson).toBe('')
    await session.reconcileBaseline()
    expect(f.session.dirty).toBe(false)
    expect(session.baselineJson).toBe(baseline)
  })
  test('navigation without an encoding certificate cannot retain the previous document JSON cache', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    Object.assign(f.bridge, { documentCodec: { encode: async (document: unknown) => JSON.stringify(document), decode: async (json: string) => JSON.parse(json) } })
    expect((f.session as any).serializedJson).not.toBe('')
    f.bridge.openDocument.mockResolvedValue(f.opening('Custom codec document'))
    expect(await f.session.open()).toBe(true)
    expect((f.session as any).serializedJson).toBe('')
    expect((f.session as any).serializedGeneration).toBe(-1)
    expect(f.session.dirty).toBe(false)
  })
  test('invalidating the cache preserves an uncertain workspace mutation payload and identity', async () => {
    const f = fixture(); await f.session.start()
    const session = f.session as any, snapshot = await session.captureSnapshot()
    const pending = { documentJson: snapshot.json, expectedRevision: 7, mutationId: 'same-request', generation: snapshot.generation, id: snapshot.document.id }
    session.workspacePending = pending
    f.edit('Edit while acknowledgement is uncertain')
    expect(session.serializedJson).toBe('')
    expect(session.workspacePending).toBe(pending)
    expect(session.workspacePending.documentJson).toBe(snapshot.json)
  })
  test('an old-generation encode cannot repopulate the invalidated current cache', async () => {
    const f = fixture(); await f.session.start(); f.edit('Old encoded snapshot')
    const session = f.session as any, encoded = JSON.stringify(f.editor.state.doc), pending = deferred<string>()
    Object.assign(f.bridge, { documentCodec: { encode: () => pending.promise, decode: async (json: string) => JSON.parse(json) } })
    const capture = session.captureSnapshot()
    f.edit('New edit before encoding resolves')
    pending.resolve(encoded)
    expect((await capture).json).toBe(encoded)
    expect(session.serializedJson).toBe('')
    expect(session.serializedGeneration).toBe(-1)
  })
  test('local document codec keeps delayed save acknowledgements scoped to the encoded snapshot', async () => {
    const f=fixture();await f.session.start();f.edit('Encoded snapshot')
    const encoded=JSON.stringify(f.editor.state.doc),pending=deferred<string>()
    const encode=vi.fn(async(document:unknown)=>JSON.stringify(document)).mockReturnValueOnce(pending.promise)
    Object.assign(f.bridge,{documentCodec:{encode,decode:async(json:string)=>JSON.parse(json)}})
    const saving=f.session.save();await turn();expect(encode).toHaveBeenCalledTimes(1)
    f.edit('Newer edit during native encoding');pending.resolve(encoded)
    expect(await saving).toBe(true)
    expect(f.bridge.saveDocument.mock.calls[0][0].documentJson).toBe(encoded)
    expect(f.editor.state.doc.name).toBe('Newer edit during native encoding')
    expect(f.session.status.dirty).toBe(true)
  })
  test('a native decode completing after an edit cannot replace the current canvas', async () => {
    const f=fixture();await f.session.start();await f.session.save()
    const pending=deferred<unknown>(),decode=vi.fn(()=>pending.promise)
    Object.assign(f.bridge,{documentCodec:{encode:async(document:unknown)=>JSON.stringify(document),decode}})
    f.bridge.openDocument.mockResolvedValue(f.opening())
    const opening=f.session.open();await turn();expect(decode).toHaveBeenCalledTimes(1)
    f.edit('Keep this edit');pending.resolve(blank('Stale native decode'))
    expect(await opening).toBe(false);expect(f.editor.state.doc.name).toBe('Keep this edit')
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  })
  test('opening over a pristine default blank does not ask to save an untouched canvas', async () => {
    const f = fixture('cancel', blank()); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    expect(await f.session.open()).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.editor.state.doc.name).toBe('Opened')
  })
  test('a newly created untouched blank can be left, but a later edit still prompts', async () => {
    const f = fixture('cancel'); await f.session.start(); await f.session.save()
    expect(await f.session.replace(blank())).toBe(true)
    f.bridge.openDocument.mockResolvedValue(f.opening())
    expect(await f.session.open()).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(await f.session.replace(blank())).toBe(true)
    f.edit('Edited blank')
    expect(await f.session.open()).toBe(false)
    expect(f.confirm).toHaveBeenCalledWith('open')
  })
  test('starts unsaved and never claims a disk acknowledgement or touches recovery on empty startup', async () => {
    const f = fixture()
    await f.session.start()
    expect(f.session.dirty).toBe(true)
    expect(f.bridge.setDirty).toHaveBeenLastCalledWith(true)
    expect(f.bridge.saveDocument).not.toHaveBeenCalled()
    expect(f.bridge.writeRecovery).not.toHaveBeenCalled()
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
  })
  test('cancelled native open preserves document, history and unsaved decision', async () => {
    const f = fixture(); await f.session.start(); f.edit('Keep me')
    const before = f.editor.state.doc
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc).toBe(before)
    expect(f.editor.canUndo).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
  })
  test.each(['{broken', JSON.stringify({ schemaVersion: 6, nodes: {} })])('invalid native input is rejected before any discard prompt: %s', async (documentJson) => {
    const f = fixture(); await f.session.start()
    const before = f.editor.state.doc
    f.bridge.openDocument.mockResolvedValue({ ...savedFile, documentJson })
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc).toBe(before)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
  })
  test('native open response without an opaque handle is rejected', async () => {
    const f = fixture(); await f.session.start()
    f.bridge.openDocument.mockResolvedValue({ ...f.opening(), handle: '' })
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc.name).toBe('Original')
  })
  test('valid file open adopts only the trusted handle, then saves that file', async () => {
    const f = fixture(); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    expect(await f.session.open()).toBe(true)
    expect(f.editor.state.doc.name).toBe('Opened')
    expect(f.session.dirty).toBe(false)
    f.edit('Changed'); expect(f.session.dirty).toBe(true)
    expect(await f.session.save()).toBe(true)
    expect(f.bridge.saveDocument.mock.calls[0][0].handle).toBe('opaque:1')
    expect(f.session.dirty).toBe(false)
  })
  test('cancelling the unsaved prompt keeps the current native file', async () => {
    const f = fixture('cancel'); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc.name).toBe('Original')
    expect(f.bridge.saveDocument).not.toHaveBeenCalled()
  })
  test('failed save preserves dirty state and can recover with an explicit retry', async () => {
    const f = fixture(); await f.session.start(); f.edit('Unsaved')
    f.bridge.saveDocument.mockResolvedValueOnce({ status: 'error', code: 'IO_ERROR', message: 'disk full' })
    expect(await f.session.save()).toBe(false)
    expect(f.session.dirty).toBe(true)
    expect(f.editor.state.doc.name).toBe('Unsaved')
    expect(await f.session.save()).toBe(true)
    expect(f.session.dirty).toBe(false)
  })
  test('a cancelled Save As does not replace the existing file handle', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    f.edit('Another')
    f.bridge.saveDocument.mockResolvedValueOnce(cancelled)
    expect(await f.session.save(true)).toBe(false)
    expect(f.session.dirty).toBe(true)
    await f.session.save()
    expect(f.bridge.saveDocument.mock.calls.at(-1)?.[0].handle).toBe('opaque:1')
    expect(f.bridge.saveDocument.mock.calls[1][0].saveAs).toBe(true)
  })
  test('an external conflict never overwrites, replaces or silently forks the current document', async () => {
    const f = fixture(); await f.session.start(); await f.session.save(); f.edit('Local edit')
    f.bridge.saveDocument.mockResolvedValueOnce({ status: 'conflict', code: 'CONFLICT', message: 'disk changed' })
    expect(await f.session.save()).toBe(false)
    expect(f.session.status.conflict).toBe(true)
    expect(f.session.dirty).toBe(true)
    expect(f.editor.state.doc.name).toBe('Local edit')
    expect(f.bridge.saveDocument).toHaveBeenCalledTimes(2)
    expect(f.bridge.saveDocument.mock.calls.at(-1)?.[0].saveAs).toBe(false)
  })
  test('dirty observation never serializes full documents during live drag previews', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      for (let i = 0; i < 50; i++) f.editor.set({ doc: { ...f.editor.state.doc, name: `Preview ${i}` } })
      expect(stringify).not.toHaveBeenCalled()
      expect(f.session.dirty).toBe(true)
    } finally { stringify.mockRestore() }
    await f.session.save()
    expect(JSON.parse(f.bridge.saveDocument.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('Preview 49')
    expect(f.session.dirty).toBe(false)
  })
  test('undo back to acknowledged bytes is recognized lazily before closing without a discard prompt', async () => {
    const f = fixture(); await f.session.start(); f.edit('Saved name'); await f.session.save()
    f.edit('Later name'); f.editor.undo()
    expect(f.editor.state.doc.name).toBe('Saved name')
    expect(await f.session.requestClose()).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.session.dirty).toBe(false)
  })
  test('actual preview/commit/undo paths preserve the saved snapshot and close safely after undo', async () => {
    const f = fixture(); await f.session.start()
    const document = blank('Geometry saved'), shape = node('rectangle')
    document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
    f.editor.load(document); await f.session.save()
    const saved = f.editor.state.doc
    f.editor.begin('Drag')
    f.editor.preview({ [shape.id]: { transform: [1, 0, 0, 1, 77, 88] } })
    expect(saved.nodes[shape.id].transform).not.toEqual([1, 0, 0, 1, 77, 88])
    f.editor.commit(); f.editor.undo()
    expect(f.editor.state.doc).toEqual(saved)
    expect(await f.session.requestClose()).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  test('a real rotation during a pending save retains the codec base and saves the committed pose', async () => {
    const doc = blank('Rotation'), shape = node('rectangle'), sibling = node('ellipse')
    doc.nodes = { [shape.id]: shape, [sibling.id]: sibling }
    doc.pages[0].children = [shape.id, sibling.id]
    const f = fixture('discard', doc), codec = new ResidentDocumentCodec(2 ** 20)
    const requests: CodecDelta[] = []
    Object.assign(f.bridge, { documentCodec: {
      encoding: 'json-stringify-v1', encode: async value => JSON.stringify(value),
      decode: async value => JSON.parse(value),
      encodeIncremental: async request => { requests.push(request); return codec.encode(request) },
    } satisfies NonNullable<DesktopBridge['documentCodec']> })
    await f.session.start(); await f.session.save()
    const before = f.editor.state.doc, originalVersion = f.editor.state.version
    f.editor.begin('Cancelled rotation')
    f.editor.preview({ [shape.id]: { transform: [0, 1, -1, 0, 1, 2] } })
    expect(f.session.dirty).toBe(true)
    f.editor.cancel()
    expect(f.session.dirty).toBe(false)
    expect(requests).toHaveLength(1)
    const gate = deferred<DesktopResult<DesktopFile>>()
    f.bridge.saveDocument.mockReturnValueOnce(gate.promise)
    const saving = f.session.save()
    await turn()
    f.editor.begin('Rotate')
    expect(f.editor.preview({ [shape.id]: { transform: [0, 1, -1, 0, 9, 12] } })).toBe(true)
    expect(f.editor.state.version).toBe(originalVersion)
    expect(f.session.dirty).toBe(true)
    f.editor.commit()
    gate.resolve(savedFile); await saving
    expect(f.session.dirty).toBe(true)
    await f.session.save()
    expect(requests.map(r => r.install)).toEqual([true, false])
    expect(requests[1].nodes.map(([id]) => id)).toEqual([shape.id])
    expect(JSON.parse(f.bridge.saveDocument.mock.calls.at(-1)![0].documentJson)).toEqual(JSON.parse(JSON.stringify(f.editor.state.doc)))
    f.editor.undo()
    expect(f.editor.state.doc).toEqual(before)
    // Raw versioned writes still lack a trustworthy immutable delta baseline.
    f.editor.state.doc.name = 'External change'
    f.editor.set({ version: f.editor.state.version + 1 })
    await f.session.save()
    expect(requests.at(-1)?.install).toBe(true)
    expect(JSON.parse(f.bridge.saveDocument.mock.calls.at(-1)![0].documentJson).name).toBe('External change')
  })
  test('redo after undo-to-saved remains dirty and requires confirmation', async () => {
    const f = fixture('cancel'); await f.session.start(); f.edit('Saved name'); await f.session.save()
    f.edit('Later name'); f.editor.undo(); f.editor.redo()
    expect(await f.session.requestClose()).toBe(false)
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.session.dirty).toBe(true)
  })
  test('a versioned same-root mutation cannot be cleared by an older save acknowledgement', async () => {
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult<DesktopFile>>(); f.bridge.saveDocument.mockReturnValueOnce(pending.promise)
    const saving = f.session.save(); await turn()
    // Defensive fallback: production engine paths create new roots; even a versioned in-place
    // mutation by a future integration must invalidate the lazy serialization/ack generation.
    f.editor.state.doc.name = 'Versioned mutation'
    f.editor.set({ version: f.editor.state.version + 1 })
    pending.resolve(savedFile); await saving
    expect(f.session.dirty).toBe(true)
    expect(JSON.parse(f.bridge.writeRecovery.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('Versioned mutation')
  })
  test('a save acknowledgement for an old snapshot never clears newer edits', async () => {
    const f = fixture(); await f.session.start(); f.edit('Before')
    const pending = deferred<DesktopResult<DesktopFile>>()
    f.bridge.saveDocument.mockReturnValueOnce(pending.promise)
    const saving = f.session.save(); await turn()
    expect(f.session.dirty).toBe(true)
    f.edit('After')
    pending.resolve(savedFile); expect(await saving).toBe(true)
    expect(f.session.dirty).toBe(true)
    expect(JSON.parse(f.bridge.saveDocument.mock.calls[0][0].documentJson).name).toBe('Before')
    expect(JSON.parse(f.bridge.writeRecovery.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('After')
    await f.session.save(); expect(f.session.dirty).toBe(false)
  })
  test('repeated same-tick save clicks use a synchronous single-operation gate', async () => {
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult<DesktopFile>>()
    f.bridge.saveDocument.mockReturnValueOnce(pending.promise)
    const first = f.session.save(), second = f.session.save(), third = f.session.save(true)
    expect(await second).toBe(false); expect(await third).toBe(false)
    await turn(); expect(f.bridge.saveDocument).toHaveBeenCalledTimes(1)
    pending.resolve(savedFile); await first
  })
  test('opening or closing during a pending save is declined without another dialog', async () => {
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult<DesktopFile>>()
    f.bridge.saveDocument.mockReturnValueOnce(pending.promise)
    const saving = f.session.save()
    expect(await f.session.open()).toBe(false)
    expect(await f.session.requestClose()).toBe(false)
    f.session.cancelClose()
    expect(f.session.status.operation).toBe('save')
    expect(f.bridge.openDocument).not.toHaveBeenCalled()
    pending.resolve(savedFile); await saving
  })
  test('a newer edit during a discard confirmation prevents navigation', async () => {
    const f = fixture(); await f.session.start()
    const choice = deferred<LeaveDecision>(); f.confirm.mockReturnValueOnce(choice.promise)
    f.bridge.openDocument.mockResolvedValue(f.opening())
    const opening = f.session.open(); await turn(); f.edit('Newer')
    choice.resolve('discard')
    expect(await opening).toBe(false)
    expect(f.editor.state.doc.name).toBe('Newer')
  })
  test.each(['close', 'open', 'new', 'recover'] as const)('an edit in the await-leave microtask gap vetoes %s', async (operation) => {
    const f = fixture(); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    f.bridge.readRecovery.mockResolvedValue(f.recovery())
    f.confirm.mockImplementation(() => {
      queueMicrotask(() => queueMicrotask(() => f.edit('Never confirmed')))
      return Promise.resolve('discard')
    })
    const result = await (operation === 'close' ? f.session.requestClose()
      : operation === 'open' ? f.session.open()
        : operation === 'new' ? f.session.replace(blank('Replacement')) : f.session.recover())
    expect(result).toBe(false)
    expect(f.editor.state.doc.name).toBe('Never confirmed')
    expect(f.session.closeReady).toBe(false)
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
    expect(f.bridge.acceptRecovery).not.toHaveBeenCalled()
  })
  test('startup recovery also carries the exact confirmed generation across await leave', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<DesktopBridge['readRecovery']>>>()
    f.bridge.readRecovery.mockReturnValueOnce(pending.promise)
    const starting = f.session.start(); await turn(); f.edit('Authored during startup')
    f.confirm.mockImplementation(() => {
      queueMicrotask(() => queueMicrotask(() => f.edit('Never confirmed startup')))
      return Promise.resolve('discard')
    })
    pending.resolve(f.recovery())
    expect(await starting).toBe(false)
    expect(f.editor.state.doc.name).toBe('Never confirmed startup')
    expect(f.bridge.acceptRecovery).not.toHaveBeenCalled()
  })
  test('a clean file still fences edits published between leave and open continuation', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    f.bridge.openDocument.mockImplementation(async () => {
      queueMicrotask(() => queueMicrotask(() => f.edit('Unprompted new edit')))
      return f.opening()
    })
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc.name).toBe('Unprompted new edit')
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  })
  test('a newer edit during save-before-open prevents replacement', async () => {
    const f = fixture('save'); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    const pending = deferred<DesktopResult<DesktopFile>>(); f.bridge.saveDocument.mockReturnValueOnce(pending.promise)
    const opening = f.session.open(); await turn(); f.edit('Still here')
    pending.resolve(savedFile)
    expect(await opening).toBe(false)
    expect(f.editor.state.doc.name).toBe('Still here')
    expect(f.session.dirty).toBe(true)
  })
  test('save-before-new failure keeps document and undo history', async () => {
    const f = fixture('save'); await f.session.start(); f.edit('Before new')
    f.bridge.saveDocument.mockResolvedValueOnce({ status: 'error', code: 'IO_ERROR', message: 'denied' })
    expect(await f.session.replace(blank('New'))).toBe(false)
    expect(f.editor.state.doc.name).toBe('Before new')
    expect(f.editor.canUndo).toBe(true)
  })
  test('close cancellation preserves recovery and current editing state', async () => {
    const f = fixture('cancel'); await f.session.start(); f.edit('Keep open')
    expect(await f.session.requestClose()).toBe(false)
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
    expect(f.editor.state.doc.name).toBe('Keep open')
  })
  test('explicit discard closes only after recovery cleanup acknowledgement', async () => {
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult>(); f.bridge.clearRecovery.mockReturnValueOnce(pending.promise)
    let completed = false
    const closing = f.session.requestClose().then((result) => { completed = true; return result })
    await turn(); expect(completed).toBe(false)
    pending.resolve(ok); expect(await closing).toBe(true)
  })
  test('successful close keeps editing blocked until the host closes or rejects its request ID', async () => {
    const f = fixture(); await f.session.start()
    expect(await f.session.requestClose()).toBe(true)
    expect(f.session.closeReady).toBe(true)
    expect(f.session.status.transitioning).toBe(true)
    expect(await f.session.save()).toBe(false)
    f.session.cancelClose()
    expect(f.session.status.transitioning).toBe(false)
    expect(await f.session.save()).toBe(true)
  })
  test('an already-running geometry operation prevents close authorization', async () => {
    const f = fixture(); await f.session.start(); f.editor.set({ busy: true })
    expect(await f.session.requestClose()).toBe(false)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.session.closeReady).toBe(false)
  })
  test('cancelled Save dialog during close leaves the window open', async () => {
    const f = fixture('save'); await f.session.start()
    f.bridge.saveDocument.mockResolvedValueOnce(cancelled)
    expect(await f.session.requestClose()).toBe(false)
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
  })
  test('new edits during final close cleanup veto close and get journaled', async () => {
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult>(); f.bridge.clearRecovery.mockReturnValueOnce(pending.promise)
    const closing = f.session.requestClose(); await turn(); f.edit('Last instant')
    pending.resolve(ok)
    expect(await closing).toBe(false)
    expect(f.session.dirty).toBe(true)
    expect(JSON.parse(f.bridge.writeRecovery.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('Last instant')
  })
  test('startup restores a validated unsaved copy and deletes source only after explicit save', async () => {
    const f = fixture(); f.bridge.readRecovery.mockResolvedValueOnce(f.recovery())
    await f.session.start()
    expect(f.editor.state.doc.name).toBe('Recovered')
    expect(f.session.dirty).toBe(true)
    expect(f.bridge.acceptRecovery).toHaveBeenCalledWith({ recoveryHandle: 'recovery:opaque' })
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
    await f.session.save()
    expect(f.bridge.saveDocument.mock.calls[0][0].handle).toBeUndefined()
    expect(f.bridge.clearRecovery).toHaveBeenCalledWith({ recoveryHandle: 'recovery:opaque' })
  })
  test('invalid recovery never adopts or destroys a candidate', async () => {
    const f = fixture(); f.bridge.readRecovery.mockResolvedValueOnce({ ...f.recovery(), documentJson: '{' })
    expect(await f.session.start()).toBe(false)
    expect(f.editor.state.doc.name).toBe('Original')
    expect(f.bridge.acceptRecovery).not.toHaveBeenCalled()
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
  })
  test('cancelled recovery navigation never adopts the selected source', async () => {
    const f = fixture('cancel'); await f.session.start()
    f.bridge.readRecovery.mockResolvedValueOnce(f.recovery())
    expect(await f.session.recover()).toBe(false)
    expect(f.bridge.acceptRecovery).not.toHaveBeenCalled()
    expect(f.editor.state.doc.name).toBe('Original')
  })
  test('an edit during recovery adoption preserves canvas and never authorizes deleting the source', async () => {
    const f = fixture(); await f.session.start(); f.bridge.readRecovery.mockResolvedValueOnce(f.recovery())
    const pending = deferred<DesktopResult>(); f.bridge.acceptRecovery.mockReturnValueOnce(pending.promise)
    const recovering = f.session.recover(); await turn(); f.edit('Newer during adoption')
    pending.resolve(ok)
    expect(await recovering).toBe(false)
    expect(f.editor.state.doc.name).toBe('Newer during adoption')
    await f.session.save()
    expect(f.bridge.clearRecovery.mock.calls.every(([request]) => !request?.recoveryHandle)).toBe(true)
  })
  test('edits made while startup recovery discovery is pending get a recovery snapshot', async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<DesktopBridge['readRecovery']>>>()
    f.bridge.readRecovery.mockReturnValueOnce(pending.promise)
    const starting = f.session.start(); await turn(); f.edit('Startup edit')
    pending.resolve(cancelled); await starting
    expect(JSON.parse(f.bridge.writeRecovery.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('Startup edit')
  })
  test('journal writes are serialized before a successful save clears them', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start()
    const pending = deferred<DesktopResult>(); f.bridge.writeRecovery.mockReturnValueOnce(pending.promise)
    f.edit('Journal'); await vi.advanceTimersByTimeAsync(650)
    expect(f.bridge.writeRecovery).toHaveBeenCalledTimes(1)
    const saving = f.session.save(); await turn()
    expect(f.bridge.clearRecovery).not.toHaveBeenCalled()
    pending.resolve(ok); await saving
    expect(f.bridge.clearRecovery).toHaveBeenCalledOnce()
    expect(f.session.dirty).toBe(false)
  })
  test('native dialogs defer recovery and cancelled dialogs reschedule the latest dirty snapshot', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start(); f.edit('Before cancelled dialog')
    const pending = deferred<DesktopResult<DesktopFile>>()
    f.bridge.openDocument.mockReturnValueOnce(pending.promise)
    const opening = f.session.open(); await turn()
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.bridge.writeRecovery).not.toHaveBeenCalled()
    pending.resolve(cancelled); await opening
    await vi.advanceTimersByTimeAsync(650)
    expect(JSON.parse(f.bridge.writeRecovery.mock.calls.at(-1)?.[0].documentJson || '{}').name).toBe('Before cancelled dialog')
  })
  test('document grant is accepted only after validation and confirmed replacement', async () => {
    const f = fixture('cancel'); await f.session.start()
    f.bridge.openDocument.mockResolvedValue(f.opening())
    expect(await f.session.open()).toBe(false)
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
    f.confirm.mockResolvedValue('discard')
    expect(await f.session.open()).toBe(true)
    expect(f.bridge.acceptDocument).toHaveBeenCalledWith({ handle: 'opaque:1' })
  })
  test('unexpected document grant rejection retains the valid canvas as an unsaved copy', async () => {
    const f = fixture(); await f.session.start(); f.bridge.openDocument.mockResolvedValue(f.opening())
    f.bridge.acceptDocument.mockResolvedValueOnce({ status: 'error', code: 'UNKNOWN_HANDLE', message: 'missing' })
    expect(await f.session.open()).toBe(false)
    expect(f.editor.state.doc.name).toBe('Opened')
    expect(f.session.dirty).toBe(true)
    await f.session.save()
    expect(f.bridge.saveDocument.mock.calls.at(-1)?.[0].handle).toBeUndefined()
  })
  test('recovery durability warnings stay visible without clearing unsaved edits', async () => {
    vi.useFakeTimers()
    const f = fixture(); await f.session.start()
    f.bridge.writeRecovery.mockResolvedValueOnce({ status: 'ok', warning: 'recovery directory sync unavailable' })
    f.edit('Warning'); await vi.advanceTimersByTimeAsync(650)
    expect(f.session.dirty).toBe(true)
    expect(f.session.status.recoveryWarning).toBe('recovery directory sync unavailable')
    expect(f.editor.state.message).toContain('recovery directory sync unavailable')
  })
  test('postcommit durability warnings remain visible', async () => {
    const f = fixture(); await f.session.start()
    f.bridge.saveDocument.mockResolvedValueOnce({ ...savedFile, warning: 'directory sync unavailable' })
    expect(await f.session.save()).toBe(true)
    expect(f.editor.state.message).toContain('directory sync unavailable')
  })
})

describe('browser/desktop separation', () => {
  test('plain browser and unsupported bridge versions keep browser mode', () => {
    expect(desktopBridge()).toBeUndefined()
    vi.stubGlobal('window', { coreDesktop: { version: 2 } })
    expect(desktopBridge()).toBeUndefined()
  })
  test('desktop mode refuses cloud requests before any fetch', async () => {
    const f = fixture(); vi.stubGlobal('window', { coreDesktop: f.bridge })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new Backend().list()).rejects.toThrow('桌面离线模式')
    expect(fetch).not.toHaveBeenCalled()
  })
  test('browser backend retains its explicit cloud request path', async () => {
    vi.stubGlobal('window', {})
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] })
    vi.stubGlobal('fetch', fetch)
    expect(await new Backend().list()).toEqual([])
    expect(fetch).toHaveBeenCalledWith('/api/design/documents', expect.anything())
  })
})

describe('catalog document lifecycle', () => {
  const request = { directoryHandle: 'directory:opaque', fileId: 'file:metadata' }
  test('catalog open uses the same validated replacement and grant acceptance workflow', async () => {
    const f = fixture(); await f.session.start()
    f.bridge.openCatalogFile.mockResolvedValue(f.opening('Catalog document'))
    expect(await f.session.openCatalogFile(request)).toBe(true)
    expect(f.bridge.openCatalogFile).toHaveBeenCalledWith(request)
    expect(f.bridge.openDocument).not.toHaveBeenCalled()
    expect(f.bridge.acceptDocument).toHaveBeenCalledWith({ handle: savedFile.handle })
    expect(f.editor.state.doc.name).toBe('Catalog document')
    expect(f.session.dirty).toBe(false)
  })
  test('catalog stale grant error preserves edits without a discard prompt', async () => {
    const f = fixture(); await f.session.start(); f.edit('Keep edits')
    const before = f.editor.state.doc
    f.bridge.openCatalogFile.mockResolvedValue({ status: 'error', code: 'INVALID_HANDLE', message: '请重新选择目录' })
    expect(await f.session.openCatalogFile(request)).toBe(false)
    expect(f.editor.state.doc).toBe(before)
    expect(f.session.status.error).toBe('请重新选择目录')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  })
  test('catalog invalid document never asks to discard or adopts its grant', async () => {
    const f = fixture(); await f.session.start()
    f.bridge.openCatalogFile.mockResolvedValue({ ...savedFile, documentJson: '{invalid' })
    expect(await f.session.openCatalogFile(request)).toBe(false)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
    expect(f.editor.state.doc.name).toBe('Original')
  })
  test('catalog cancellation and edits during confirmation retain the current canvas', async () => {
    const f = fixture('cancel'); await f.session.start(); f.edit('Original edits')
    f.bridge.openCatalogFile.mockResolvedValue(f.opening())
    expect(await f.session.openCatalogFile(request)).toBe(false)
    const approval = deferred<LeaveDecision>()
    f.confirm.mockReturnValueOnce(approval.promise)
    const pending = f.session.openCatalogFile(request); await turn()
    f.edit('Newer edits'); approval.resolve('discard')
    expect(await pending).toBe(false)
    expect(f.editor.state.doc.name).toBe('Newer edits')
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  })
  test('uncommittable input draft vetoes catalog replacement', async () => {
    const f = fixture(); await f.session.start(); await f.session.save()
    const unregister = registerPendingEdit(f.editor, { dirty: () => true, commit: () => false })
    try {
      f.bridge.openCatalogFile.mockResolvedValue(f.opening())
      expect(await f.session.openCatalogFile(request)).toBe(false)
      expect(f.editor.state.doc.name).toBe('Original')
      expect(f.session.dirty).toBe(true)
      expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
      expect(f.confirm).not.toHaveBeenCalled()
    } finally { unregister() }
  })
  test('catalog open shares the navigation gate and ignores completion after disposal', async () => {
    const f = fixture(); await f.session.start()
    const response = deferred<DesktopResult<DesktopFile>>()
    f.bridge.openCatalogFile.mockReturnValueOnce(response.promise)
    const pending = f.session.openCatalogFile(request); await turn()
    expect(await f.session.open()).toBe(false)
    expect(await f.session.replace(blank('New navigation'))).toBe(false)
    expect(f.bridge.openDocument).not.toHaveBeenCalled()
    f.session.dispose(); response.resolve(f.opening())
    expect(await pending).toBe(false)
    expect(f.editor.state.doc.name).toBe('Original')
    expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  })
})
