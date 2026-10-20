import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DesktopSession } from './desktop-session'
import { Editor } from './engine'
import { blank, type DesignDocument } from './model'
import type { DesktopBridge } from './desktop'
import { prepareDocumentJson, takePreparedDocument } from './prepared-document'
import { admitDocumentJsonSync, consumeDocumentJsonSyntaxFailure } from './document-admission'
import * as picking from './kernel/picking'
const sessions: DesktopSession[] = []
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const ok = { status: 'ok' } as const
function fixture(options: { known?: boolean; frozenCodec?: boolean; frozenBridge?: boolean; installed?: boolean; version?: number; mutateDecode?: boolean; accessorMarker?: boolean } = {}) {
  vi.useFakeTimers()
  const target = blank('Stored target'), original = blank('Original'), editor = new Editor(original)
  let source = JSON.stringify(target), deleted = false, revision = 1
  const encode = vi.fn(async (d: unknown) => JSON.stringify(d))
  const decode = vi.fn(async (s: string) => ({ ...JSON.parse(s), ...(options.mutateDecode ? { name: 'Custom decoded' } : {}) }))
  const codec = { encoding: 'json-stringify-v1' as const, ...(options.known !== false ? { decoding: 'json-parse-v1' as const } : {}), encode, decode }
  if (options.accessorMarker) Object.defineProperty(codec, 'decoding', { get() { throw new Error('Untrusted marker getter must not run') } })
  const opened = () => ({ ...ok, id: target.id, name: target.name, revision, hash: 'same', deleted, updatedAt: 1, documentJson: source })
  const open = vi.fn(async () => opened()), commits: string[] = []
  const bridge = { version: options.version ?? 1, documentCodec: options.frozenCodec === false ? codec : Object.freeze(codec),
    workspace: { list: async () => ({ ...ok, documents: [] }), open, commit: async ({ documentJson }: { documentJson: string }) => { commits.push(documentJson); const d = JSON.parse(documentJson); return { ...ok, id: d.id, name: d.name, revision: ++revision, hash: 'saved', deleted: false, updatedAt: 2 } } },
    readRecovery: async () => ({ status: 'cancelled' }), clearRecovery: async () => ok, writeRecovery: async () => ok, setDirty: async () => {},
  } as unknown as DesktopBridge
  if (options.frozenBridge !== false) Object.freeze(bridge)
  vi.stubGlobal('window', { coreDesktop: options.installed === false ? Object.freeze({ ...bridge }) : bridge })
  const confirm = vi.fn(async () => 'discard' as const), session = new DesktopSession(bridge, editor, confirm)
  sessions.push(session)
  return { session, editor, target, original, codec, bridge, decode, encode, open, commits, confirm, opened,
    setSource: (s: string) => { source = s }, setDeleted: () => { deleted = true } }
}

test('installed frozen version1 JSON codec takes one private parse/admission and preserves exact baseline bytes', async () => {
  const f = fixture(), jsonPrepare = vi.spyOn(picking, 'prepareDocumentJsonForEditing'), objectPrepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  const expected = JSON.stringify(picking.prepareDocumentForEditing(JSON.parse(JSON.stringify(f.target))))
  objectPrepare.mockClear()
  expect(await f.session.openWorkspace(f.target.id)).toBe(true)
  expect(f.open).toHaveBeenCalledTimes(2); expect(f.decode).not.toHaveBeenCalled()
  expect(jsonPrepare).toHaveBeenCalledTimes(1); expect(objectPrepare).not.toHaveBeenCalled()
  expect(JSON.stringify(f.editor.state.doc)).toBe(expected); expect(f.session.dirty).toBe(false)
  expect(f.encode).not.toHaveBeenCalled()
  expect((f.session as any).baselineJson).toBe(expected)
})

for (const options of [{ known: false }, { frozenCodec: false }, { frozenBridge: false }, { installed: false }, { version: 2 }, { accessorMarker: true }])
  test(`unknown or detached codec preserves its original transformation: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ ...options, mutateDecode: true }), jsonPrepare = vi.spyOn(picking, 'prepareDocumentJsonForEditing')
    expect(await f.session.openWorkspace(f.target.id)).toBe(true)
    expect(f.decode).toHaveBeenCalledTimes(1); expect(jsonPrepare).not.toHaveBeenCalled()
    expect(f.editor.state.doc.name).toBe('Custom decoded')
  })

test('changed fresh bytes with identical metadata are prepared again, not reused', async () => {
  const f = fixture(), prepare = vi.spyOn(picking, 'prepareDocumentJsonForEditing')
  f.open.mockImplementationOnce(async () => f.opened()).mockImplementationOnce(async () => ({ ...f.opened(), documentJson: JSON.stringify({ ...f.target, name: 'Fresh changed bytes' }) }))
  expect(await f.session.openWorkspace(f.target.id)).toBe(true)
  expect(prepare).toHaveBeenCalledTimes(2); expect(f.editor.state.doc.name).toBe('Fresh changed bytes')
})

test('cancelled leave and deleted fresh targets keep the current document and history', async () => {
  const f = fixture()
  f.editor.change('dirty', d => { d.name = 'Dirty original' })
  const before = f.editor.state.doc, canUndo = f.editor.canUndo
  f.confirm.mockResolvedValueOnce('cancel' as never)
  expect(await f.session.openWorkspace(f.target.id)).toBe(false)
  expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(canUndo)
  f.open.mockImplementationOnce(async () => f.opened()).mockImplementationOnce(async () => ({ ...f.opened(), deleted: true }))
  expect(await f.session.openWorkspace(f.target.id)).toBe(false)
  expect(f.editor.state.doc).toBe(before)
})

test('invalid source, font and raw size failures do not publish; the next valid request still works', async () => {
  const f = fixture(), before = f.editor.state.doc, generation = f.editor.sessionGeneration
  for (const source of ['{invalid', JSON.stringify({ ...f.target, fonts: { broken: { family: 'Broken', data: 'bad-font', index: 0 } } })]) {
    f.setSource(source); expect(await f.session.openWorkspace(f.target.id)).toBe(false)
    expect(f.editor.state.doc).toBe(before); expect(f.editor.sessionGeneration).toBe(generation); expect(f.editor.canUndo).toBe(false)
  }
  f.decode.mockRejectedValueOnce(new Error('Invalid document JSON size'))
  await expect((f.session as any).parse(' '.repeat(32 * 1024 * 1024 + 1))).rejects.toThrow('Invalid document JSON size')
  f.setSource(JSON.stringify(f.target)); expect(await f.session.openWorkspace(f.target.id)).toBe(true)
})

for (const mutation of ['versioned-same-root', 'replacement-root', 'session-replaced'])
  test(`publication changes remain dirty after private raw-source adoption: ${mutation}`, async () => {
    const f = fixture(); let changed = false
    const unsubscribe = f.editor.subscribe(() => {
      if (changed || f.editor.state.doc.id !== f.target.id) return
      changed = true
      if (mutation === 'versioned-same-root') { f.editor.state.doc.name = 'New edit'; f.editor.set({ version: f.editor.state.version + 1 }) }
      else if (mutation === 'replacement-root') f.editor.set({ doc: { ...f.editor.state.doc, name: 'New owner' } })
      else f.editor.load(blank('Nested load'))
    })
    try {
      expect(await f.session.openWorkspace(f.target.id)).toBe(true); expect(changed).toBe(true)
      expect(f.session.dirty).toBe(true); expect((f.session as any).baselineJson).toBeNull(); expect((f.session as any).baselineDocument).toBeUndefined()
    } finally { unsubscribe() }
  })

test('the primitive source owner remains private and one-use', () => {
  const source = JSON.stringify(blank()), owner = prepareDocumentJson(source), copy = owner.snapshot()
  copy.name = 'Untrusted independent copy'
  expect(takePreparedDocument(owner)?.name).not.toBe(copy.name)
  expect(() => takePreparedDocument(owner)).toThrow('已被接收')
  expect(takePreparedDocument({ ...owner })).toBeUndefined()
})

test('actual preload exports only a frozen explicit JSON decoding contract', () => {
  let bridge: any
  runInNewContext(readFileSync(new URL('../../design-desktop/src/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_: string, value: unknown) => { bridge = value } }, ipcRenderer: { invoke: vi.fn(async () => ({})), on: vi.fn(), removeListener: vi.fn() } }), process: { argv: [] },
  })
  expect(bridge.version).toBe(1); expect(Object.isFrozen(bridge)).toBe(true)
  expect(Object.isFrozen(bridge.documentCodec)).toBe(true); expect(bridge.documentCodec.decoding).toBe('json-parse-v1')
})

test('fallback custom documentCodec accessors retain the original evaluation count and decoder', async () => {
  vi.useFakeTimers()
  const target = blank(), editor = new Editor(blank()), decode = vi.fn(async () => target)
  let reads = 0
  const selected = Object.freeze({ encode: async (d: unknown) => JSON.stringify(d), decode })
  const bridge = Object.freeze({ version: 1, get documentCodec() { reads++; if (reads > 2) throw new Error('Extra getter read'); return selected }, setDirty: async () => {} }) as unknown as DesktopBridge
  vi.stubGlobal('window', { coreDesktop: bridge })
  const session = new DesktopSession(bridge, editor, async () => 'discard'); sessions.push(session)
  const token = await (session as any).parse(JSON.stringify(target))
  expect(reads).toBe(2); expect(decode).toHaveBeenCalledTimes(1)
  expect(takePreparedDocument(token)?.id).toBe(target.id)
})

test('invalid raw JSON preserves the exact installed decoder error, without using its returned graph', async () => {
  const f = fixture(), nativeFailure = new Error("Error invoking remote method 'native-document:decode': Syntax failure")
  f.decode.mockRejectedValueOnce(nativeFailure)
  await expect((f.session as any).parse('{')).rejects.toBe(nativeFailure)
  expect(f.decode).toHaveBeenCalledTimes(1); expect(f.editor.state.doc).toBe(f.original)
  f.decode.mockResolvedValueOnce(f.target)
  await expect((f.session as any).parse('{')).rejects.toBeInstanceOf(SyntaxError)
  expect(f.editor.state.doc).toBe(f.original)
})

test('kernel and allocation errors are never mistaken for a retryable JSON syntax failure', async () => {
  const f = fixture(), prepare = vi.spyOn(picking, 'prepareDocumentJsonForEditing')
  for (const failure of [new SyntaxError('Derived kernel JSON failed'), new RangeError('Allocation failed'), new Error('Validation failed')]) {
    prepare.mockImplementationOnce(() => { throw failure })
    await expect((f.session as any).parse(JSON.stringify(f.target))).rejects.toBe(failure)
    expect(f.decode).not.toHaveBeenCalled(); expect(f.editor.state.doc).toBe(f.original)
  }
})

test('historical parse errors cannot authorize later-attempt transport, even for identical source', async () => {
  const f = fixture(), source = '{', prepare = vi.spyOn(picking, 'prepareDocumentJsonForEditing')
  let previouslyConsumed: unknown
  f.decode.mockResolvedValueOnce(f.target)
  try { await (f.session as any).parse(source) } catch (error) { previouslyConsumed = error }
  expect(previouslyConsumed).toBeInstanceOf(SyntaxError)
  expect(f.decode).toHaveBeenCalledTimes(1); f.decode.mockClear()

  let previouslyUnconsumed: unknown
  try { admitDocumentJsonSync(source, {}) } catch (error) { previouslyUnconsumed = error }
  expect(previouslyUnconsumed).toBeInstanceOf(SyntaxError)
  for (const error of [previouslyConsumed, previouslyUnconsumed]) {
    prepare.mockImplementationOnce(() => { throw error })
    await expect((f.session as any).parse(source)).rejects.toBe(error)
    expect(f.decode).not.toHaveBeenCalled(); expect(f.editor.state.doc).toBe(f.original)
  }
})

test('parse-error witness is bound to one attempt and consumed only once', () => {
  const attempt = {}, otherAttempt = {}
  let failure: unknown
  try { admitDocumentJsonSync('{', attempt) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(SyntaxError)
  expect(consumeDocumentJsonSyntaxFailure(failure, otherAttempt)).toBe(false)
  expect(consumeDocumentJsonSyntaxFailure(failure, attempt)).toBe(true)
  expect(consumeDocumentJsonSyntaxFailure(failure, attempt)).toBe(false)
})

test('edits during native syntax-error transport remain dirty in the original session', async () => {
  const f = fixture(); f.setSource('{')
  let reject!: (e: unknown) => void
  f.decode.mockImplementationOnce(() => new Promise((_, r) => { reject = r }))
  const opening = f.session.openWorkspace(f.target.id)
  for (let i = 0; i < 40 && !reject; i++) await Promise.resolve()
  expect(reject).toBeDefined()
  f.editor.change('new edit', d => { d.name = 'Edited during failed decode' })
  const current = f.editor.state.doc, generation = f.editor.sessionGeneration
  reject(new Error('Native syntax failure'))
  expect(await opening).toBe(false); expect(f.editor.state.doc).toBe(current)
  expect(f.editor.sessionGeneration).toBe(generation); expect(f.session.dirty).toBe(true); expect(f.editor.canUndo).toBe(true)
})

test('a newer edit during fresh-head await vetoes the already prepared raw-source owner', async () => {
  const f = fixture(); let resolve!: (value: ReturnType<typeof f.opened>) => void
  f.open.mockImplementationOnce(async () => f.opened()).mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const opening = f.session.openWorkspace(f.target.id)
  for (let i = 0; i < 60 && !resolve; i++) await Promise.resolve()
  expect(resolve).toBeDefined()
  f.editor.change('new edit', d => { d.name = 'Edited during fresh head' })
  const current = f.editor.state.doc
  resolve(f.opened())
  expect(await opening).toBe(false); expect(f.editor.state.doc).toBe(current); expect(f.session.dirty).toBe(true)
})
