import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { DesktopSession } from './desktop-session'
import { prepareDocument, preparedDocumentEncoding, takePreparedDocument, forkPreparedDocument, ensurePreparedDocument, preparedDocumentAdoptionOwner } from './prepared-document'
import type { DesktopBridge } from './desktop'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import * as picking from './kernel/picking'
const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function fixture(known: boolean | null = true, encoder = (d: unknown) => JSON.stringify(d)) {
  vi.useFakeTimers()
  const target = blank('Saved original'), editor = new Editor(blank()), encode = vi.fn(async (d: unknown) => encoder(d)), submitted: string[] = []
  let revision = 1
  const bridge = { version: 1, ...(known === null ? {} : { documentCodec: Object.freeze({ ...(known ? { encoding: 'json-stringify-v1' as const } : {}), encode, decode: async (s: string) => JSON.parse(s) }) }),
    workspace: { list: async () => ({ ...ok, documents: [] }), open: async () => ({ ...ok, id: target.id, name: target.name, revision, hash: 'head', deleted: false, updatedAt: 1, documentJson: JSON.stringify(target) }), commit: async ({ documentJson }: { documentJson: string }) => { submitted.push(documentJson); const d = JSON.parse(documentJson); return { ...ok, id: d.id, name: d.name, revision: ++revision, hash: 'saved', deleted: false, updatedAt: 2 } } },
    readRecovery: async () => ({ status: 'cancelled' }), clearRecovery: vi.fn(async () => ok), writeRecovery: vi.fn(async () => ok), setDirty: async () => {} } as unknown as DesktopBridge
  const session = new DesktopSession(bridge, editor, async () => 'cancel'); sessions.push(session)
  await session.start(); expect(await session.openWorkspace(target.id)).toBe(true)
  const recover = () => (session as unknown as { updateRecovery(): Promise<void> }).updateRecovery()
  return { target, editor, encode, submitted, session, bridge, recover }
}
type SessionInternals = {
  baselineJson: string | null
  baselineGeneration: number | null
  baselineDocument?: DesignDocument
  generation: number
  load(document: unknown, persisted: boolean): boolean
}
const internals = (session: DesktopSession) => session as unknown as SessionInternals
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); vi.restoreAllMocks() })
test('known native codec reuses exact derived-validation bytes for the loaded baseline only', async () => {
  const prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  const f = await fixture(); const baseline = JSON.stringify(f.editor.state.doc)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(f.encode).not.toHaveBeenCalled()
  f.editor.change('edit', d => { d.name = 'Changed' }); await f.recover()
  expect(f.encode).toHaveBeenCalledTimes(1); expect(f.submitted).toHaveLength(1); expect(f.submitted[0]).not.toBe(baseline)
  expect(JSON.parse(f.submitted[0]).name).toBe('Changed'); expect(f.session.dirty).toBe(false)
})
test('unknown reordered custom codec must encode both its own baseline and current format', async () => {
  const custom = (input: unknown) => JSON.stringify(Object.fromEntries(Object.entries(input as Record<string, unknown>).reverse()))
  const f = await fixture(false, custom)
  f.editor.change('edit', d => { d.name = 'Changed' }); await f.recover()
  expect(f.encode).toHaveBeenCalledTimes(2); expect(f.submitted[0]).toBe(custom(f.editor.state.doc)); expect(f.session.dirty).toBe(false)
})
test('the local JSON.stringify fallback uses the same exact-byte certificate', async () => {
  const f = await fixture(null), baseline = JSON.stringify(f.editor.state.doc)
  expect(internals(f.session).baselineJson).toBe(baseline)
  expect(internals(f.session).baselineDocument).toBeUndefined()
  f.editor.change('edit', d => { d.name = 'Local fallback edit' }); await f.recover()
  expect(f.encode).not.toHaveBeenCalled(); expect(f.submitted).toEqual([JSON.stringify(f.editor.state.doc)])
  expect(f.session.dirty).toBe(false)
})
test('rejected adoption leaves the prior baseline and private certificate unconsumed', async () => {
  const f = await fixture(), state = internals(f.session), token = prepareDocument(blank('Not adopted'))
  const baseline = state.baselineJson, generation = state.generation, owner = f.editor.state.doc
  vi.spyOn(f.editor, 'load').mockReturnValueOnce(false)
  expect(state.load(token, true)).toBe(false)
  expect(f.editor.state.doc).toBe(owner); expect(state.baselineJson).toBe(baseline)
  expect(state.generation).toBe(generation); expect(state.baselineGeneration).toBe(generation)
  expect(preparedDocumentEncoding(token)).toBeDefined()
})
test('font rebind failure cannot publish or consume a prepared baseline certificate', async () => {
  const f = await fixture(), state = internals(f.session), token = prepareDocument({ ...blank('Font owner'), fonts: {} })
  prepareDocument({ ...blank('Other font owner'), fonts: {} })
  const baseline = state.baselineJson, generation = state.generation, owner = f.editor.state.doc
  const rebind = vi.spyOn(VectorEngine.prototype, 'load_document_fonts').mockImplementationOnce(() => { throw Error('rebind rejected') })
  expect(() => state.load(token, true)).toThrow('rebind rejected')
  expect(f.editor.state.doc).toBe(owner); expect(state.baselineJson).toBe(baseline)
  expect(state.generation).toBe(generation); expect(preparedDocumentEncoding(token)).toBeDefined()
  rebind.mockRestore()
  expect(state.load(token, true)).toBe(true)
  expect(state.baselineJson).toBe(JSON.stringify(f.editor.state.doc))
})
test('versioned mutation of the same document root cannot match the historical certified baseline', async () => {
  const f = await fixture(), original = f.editor.state.doc
  original.name = 'Versioned same root'; f.editor.set({ version: f.editor.state.version + 1 })
  await f.recover(); expect(f.encode).toHaveBeenCalledTimes(1); expect(f.submitted).toHaveLength(1)
  expect(JSON.parse(f.submitted[0]).name).toBe('Versioned same root')
})
test('revision change during current encoding requires a fresh encode and persists only the new snapshot', async () => {
  const f = await fixture(), pending = deferred<string>(); f.editor.change('first', d => { d.name = 'Revision three' })
  const older = JSON.stringify(f.editor.state.doc); f.encode.mockReturnValueOnce(pending.promise)
  const saving = f.recover(); await flush(); expect(f.encode).toHaveBeenCalledTimes(1)
  f.editor.change('second', d => { d.name = 'Revision four' }); pending.resolve(older); await saving
  expect(f.encode).toHaveBeenCalledTimes(2); expect(f.submitted).toHaveLength(1); expect(JSON.parse(f.submitted[0]).name).toBe('Revision four'); expect(f.session.dirty).toBe(false)
})
test('undo back to certified saved content still clears dirty state without an unnecessary write', async () => {
  const f = await fixture(); f.editor.change('edit', d => { d.name = 'Temporary' }); f.editor.undo(); await f.recover()
  expect(f.encode).toHaveBeenCalledTimes(1); expect(f.submitted).toHaveLength(0); expect(f.session.dirty).toBe(false)
})
test('a certificate is opaque, one-use, exact after font rebinding and invalidated by ID fork', () => {
  const input = { ...blank('Certified'), fonts: {} }, token = prepareDocument(input), certificate = preparedDocumentEncoding(token)!
  expect(certificate.adopted(input)).toBe(false); expect(preparedDocumentEncoding({ ...token })).toBeUndefined()
  prepareDocument({ ...blank('Another font owner'), fonts: {} }); const adopted = takePreparedDocument(token)!
  expect(certificate.adopted(adopted)).toBe(true); expect(certificate.json).toBe(JSON.stringify(adopted)); expect(preparedDocumentEncoding(token)).toBeUndefined()
  const beforeFork = prepareDocument(blank()), old = preparedDocumentEncoding(beforeFork)!, fork = forkPreparedDocument(beforeFork)
  expect(preparedDocumentEncoding(fork)).toBeUndefined(); const forked = takePreparedDocument(fork)!
  expect(old.adopted(forked)).toBe(false); expect(JSON.parse(old.json).id).not.toBe(forked.id)
})
test('codec structured-clone transport preserves the certified JSON.stringify bytes', () => {
  const source = blank('Transport'), token = prepareDocument(source), certificate = preparedDocumentEncoding(token)!, document = takePreparedDocument(token)!
  expect(certificate.json).toBe(JSON.stringify(structuredClone(structuredClone(document))))
})

test('actual installed native codec worker produces exactly the certified bytes', async () => {
  vi.useRealTimers()
  const modulePath = new URL('../../design-desktop/src/preparation.mjs', import.meta.url).href
  const { NativePreparation } = await import(modulePath)
  const codec = new NativePreparation(undefined, undefined, true)
  try {
    const rich = blank('Native transport 中文🌈\n"quoted"'), rectangle = node('rectangle', -0, 1e-7, 17.125, 23.5)
    rich.nodes[rectangle.id] = rectangle; rich.pages[0].children.push(rectangle.id)
    rich.fdCompatibility = { contractVersion: 1, requiredCapabilities: [], extensions: {
      'org.example/bytes': { z: [null, true, false, 1e21, 1e-7, -0, '中文🌈'], a: { '20': 'twenty', '3': 'three', tail: 'last' } },
    } }
    for (const source of [blank('Native transport'), rich]) {
      const token = prepareDocument(source), certificate = preparedDocumentEncoding(token)!, document = takePreparedDocument(token)!
      const reply = await codec.request({ lane: 'canvas', method: 'serialize', args: [structuredClone(document)] })
      expect(reply.error).toBeUndefined(); expect(reply.value).toBe(certificate.json)
      expect(certificate.json).toBe(JSON.stringify(document))
    }
  } finally { await codec.close() }
})
test('the installed preload publishes a frozen marker for its native codec route', async () => {
  let bridge!: DesktopBridge
  const invoke = vi.fn(async () => 'encoded')
  runInNewContext(readFileSync(new URL('../../design-desktop/src/preload.cjs', import.meta.url), 'utf8'), {
    process: { argv: [] },
    require: (name: string) => {
      expect(name).toBe('electron')
      return { contextBridge: { exposeInMainWorld: (name: string, value: DesktopBridge) => { expect(name).toBe('coreDesktop'); bridge = value } },
        ipcRenderer: { invoke } }
    },
  })
  expect(Object.isFrozen(bridge.documentCodec)).toBe(true)
  expect(bridge.documentCodec?.encoding).toBe('json-stringify-v1')
  const source = { document: 'native route' }
  expect(await bridge.documentCodec!.encode(source)).toBe('encoded')
  expect(invoke).toHaveBeenCalledExactlyOnceWith('native-document:encode', source)
})


test.each([true, false])('saveCopy plain-object adoption fences replacement owners without duplicate preparation (known codec: %s)', async known => {
  const custom = (input: unknown) => JSON.stringify(Object.fromEntries(Object.entries(input as Record<string, unknown>).reverse()))
  const f = await fixture(known, known ? JSON.stringify : custom), previousId = f.editor.state.doc.id
  const prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  let replaced = false
  const unsubscribe = f.editor.subscribe(() => {
    if (replaced || f.editor.state.doc.id === previousId) return
    replaced = true
    // Keep the public revision and session unchanged: only the private owner
    // witness can detect this synchronous replacement during saveCopy adoption.
    f.editor.set({ doc: { ...f.editor.state.doc, name: 'Changed copy during adoption' } })
  })
  try {
    expect(await f.session.saveCopy()).toBe(true)
    expect(replaced).toBe(true); expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.editor.state.doc.name).toBe('Changed copy during adoption')
    expect(f.submitted).toHaveLength(1)
    expect(JSON.parse(f.submitted[0]).name).toBe('Saved original 副本')
    expect(f.session.dirty).toBe(true)
    const state = internals(f.session)
    expect(state.baselineGeneration).toBeNull(); expect(state.baselineJson).toBeNull(); expect(state.baselineDocument).toBeUndefined()
    expect(f.encode).toHaveBeenCalledTimes(1)
    await f.recover()
    expect(f.encode).toHaveBeenCalledTimes(2); expect(f.submitted).toHaveLength(2)
    expect(JSON.parse(f.submitted[1]).name).toBe('Changed copy during adoption')
    expect(f.submitted[1]).toBe(known ? JSON.stringify(f.editor.state.doc) : custom(f.editor.state.doc))
    expect(f.session.dirty).toBe(false); expect(prepare).toHaveBeenCalledTimes(1)
  } finally { unsubscribe() }
})


test('ensurePreparedDocument preserves only live private tokens without re-preparing them', () => {
  const prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  const token = ensurePreparedDocument(blank('Owned'))
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(ensurePreparedDocument(token)).toBe(token); expect(prepare).toHaveBeenCalledTimes(1)
  expect(() => ensurePreparedDocument({ ...token })).toThrow()
  const owner = preparedDocumentAdoptionOwner(token)!, adopted = takePreparedDocument(token)!
  expect(owner(adopted)).toBe(true); expect(owner({ ...adopted })).toBe(false)
  expect(() => ensurePreparedDocument(token)).toThrow()
})

test('a nonpersisted fork without encoded bytes still fences its actual owner and pristine state', async () => {
  const f = await fixture(), fork = forkPreparedDocument(prepareDocument(blank()))
  expect(preparedDocumentEncoding(fork)).toBeUndefined()
  const prepare = vi.spyOn(picking, 'prepareDocumentForEditing')
  let replaced = false
  const unsubscribe = f.editor.subscribe(() => {
    if (replaced || f.editor.state.doc.id !== fork.id) return
    replaced = true
    f.editor.set({ doc: { ...f.editor.state.doc } })
  })
  try {
    const state = internals(f.session) as SessionInternals & { pristineBlankGeneration: number | null }
    expect(state.load(fork, false)).toBe(true)
    expect(replaced).toBe(true); expect(prepare).not.toHaveBeenCalled()
    expect(state.pristineBlankGeneration).toBeNull(); expect(state.baselineGeneration).toBeNull()
    expect(state.baselineJson).toBeNull(); expect(state.baselineDocument).toBeUndefined()
    expect(f.session.dirty).toBe(true)
  } finally { unsubscribe() }
})
