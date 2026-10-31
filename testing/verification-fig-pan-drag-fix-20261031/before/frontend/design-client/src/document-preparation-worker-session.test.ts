import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopSession } from './desktop-session'
import { blank } from './model'
import { takePreparedDocument } from './prepared-document'
import * as picking from './kernel/picking'
import { documentPreparationBuild, documentPreparationRuntime, sameDocumentPreparationBuild, sameDocumentPreparationRuntime } from './document-preparation-identity'
import { pinDocumentCapacity } from './document-capacity'
import type { DesktopBridge } from './desktop'
import type { DocumentPreparationRequest } from './document-preparation-worker-client'
import { producerIdentityFields } from '../../design-desktop/src/render-diagnostic-identity.mjs'
vi.mock('../../design-desktop/src/render-diagnostic-identity.mjs', () => ({ producerIdentityFields: vi.fn(() => ({ producerIdentityStatus: 2, producerBuildMode: 1, producerSourceSha256: 'a'.repeat(64), producerWasmInputSha256: 'b'.repeat(64) })) }))
vi.mock('./kernel/picking', () => ({ activateDocumentFonts: vi.fn(), pickingPreparationResources: vi.fn(() => ({ wasmSha256: 'b'.repeat(64), fontSha256: 'c'.repeat(64), bundled: true })),
  prepareDocumentForEditing: vi.fn((value: unknown, capture: (json: string) => void) => { const json = JSON.stringify(value); capture?.(json); return JSON.parse(json) }),
  prepareDocumentJsonForEditing: vi.fn((source: string, capture: (json: string) => void) => { const doc = JSON.parse(source); capture?.(JSON.stringify(doc)); return doc }) }))
vi.mock('./editor-action-route', () => ({ beginEditorAction: () => ({ result() {}, finish() {} }) }))
pinDocumentCapacity(1024 * 1024)
class ControlledWorker {
  static instances: ControlledWorker[] = []
  request!: DocumentPreparationRequest
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: unknown; onmessageerror: unknown; terminated = false
  constructor() { ControlledWorker.instances.push(this) }
  postMessage(request: DocumentPreparationRequest) { this.request = structuredClone(request) }
  terminate() { this.terminated = true }
  reply(extra = {}) { const document = JSON.parse(this.request.source); this.onmessage?.({ data: { ...this.request, document, validatedJson: JSON.stringify(document), ...extra } }) }
}
const sessions: DesktopSession[] = []
const turn = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture(custom = false) {
  const target = blank('worker target'), original = blank('current'), listeners = new Set<() => void>()
  const editor = { state: { doc: original, version: 0, busy: false }, sessionGeneration: 3, notify: vi.fn(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    load: vi.fn((token: unknown) => { editor.state = { ...editor.state, doc: takePreparedDocument(token)!, version: editor.state.version + 1 }; editor.sessionGeneration++; listeners.forEach(fn => fn()); return true }) }
  const codec = Object.freeze({ encoding: 'json-stringify-v1', ...(custom ? {} : { decoding: 'json-parse-v1' }),
    encode: vi.fn(async (doc: unknown) => JSON.stringify(doc)), decode: vi.fn(async (source: string) => ({ ...JSON.parse(source), ...(custom ? { name: 'custom transform' } : {}) })) })
  const bridge = Object.freeze({ version: 1, documentCodec: codec,
    openDocument: vi.fn(async () => ({ status: 'ok', documentJson: JSON.stringify(target), handle: 'file', displayName: 'design.fd' })),
    acceptDocument: vi.fn(async () => ({ status: 'ok' })), setDirty: vi.fn(async () => {}),
    clearRecovery: vi.fn(async () => ({ status: 'ok' })), writeRecovery: vi.fn(async () => ({ status: 'ok' })) })
  vi.stubGlobal('window', { coreDesktop: bridge })
  const confirm = vi.fn(async () => 'discard' as const)
  const session = new DesktopSession(bridge as unknown as DesktopBridge, editor as never, confirm); sessions.push(session)
  const edit = () => { editor.state = { ...editor.state, doc: { ...original, name: 'new edit' }, version: 1 }; listeners.forEach(fn => fn()) }
  return { session, editor, target, original, bridge, codec, confirm, edit }
}
beforeEach(() => { ControlledWorker.instances = []; vi.stubGlobal('Worker', ControlledWorker); vi.clearAllMocks() })
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.unstubAllGlobals(); vi.useRealTimers() })

test('production installed-codec open yields with old document/history untouched until the controlled worker reply', async () => {
  const f = fixture(), pending = f.session.open(); await turn()
  expect(ControlledWorker.instances).toHaveLength(1)
  expect(f.session.status.transitioning).toBe(true)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(f.editor.state.doc).toBe(f.original); expect(f.editor.load).not.toHaveBeenCalled()
  expect(picking.prepareDocumentJsonForEditing).not.toHaveBeenCalled(); expect(picking.prepareDocumentForEditing).not.toHaveBeenCalled()
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled(); expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  ControlledWorker.instances[0].reply()
  expect(await pending).toBe(true)
  expect(f.editor.state.doc).toEqual(f.target); expect(f.editor.load).toHaveBeenCalledTimes(1)
  expect(f.codec.decode).not.toHaveBeenCalled(); expect(f.codec.encode).not.toHaveBeenCalled()
  expect((f.session as any).baselineJson).toBe(JSON.stringify(f.target)); expect(f.session.dirty).toBe(false)
})

test.each(['edit', 'dispose'])('production %s cancels preparation, rejects late replies and preserves current document', async mode => {
  const f = fixture(), pending = f.session.open(); await turn()
  const worker = ControlledWorker.instances[0], late = worker.onmessage!, request = worker.request
  if (mode === 'edit') f.edit(); else f.session.dispose()
  const current = f.editor.state.doc
  expect(await pending).toBe(false); expect(worker.terminated).toBe(true)
  late({ data: { ...request, document: f.target, validatedJson: JSON.stringify(f.target) } }); await turn()
  expect(f.editor.state.doc).toBe(current); expect(f.editor.sessionGeneration).toBe(3)
  expect(f.editor.load).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled()
  expect(f.bridge.acceptDocument).not.toHaveBeenCalled(); expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
})

test('custom codecs retain transformed decode semantics and do not enter the worker', async () => {
  const f = fixture(true)
  expect(await f.session.open()).toBe(true)
  expect(f.codec.decode).toHaveBeenCalledTimes(1); expect(ControlledWorker.instances).toHaveLength(0)
  expect(f.editor.state.doc.name).toBe('custom transform')
})

test('modified host prototype retains old preparation contract instead of crossing realms', async () => {
  const f = fixture()
  Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { return this } })
  try { expect(await f.session.open()).toBe(true) }
  finally { delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON }
  expect(ControlledWorker.instances).toHaveLength(0)
  expect(picking.prepareDocumentJsonForEditing).toHaveBeenCalledTimes(1)
})

test('only source syntax failure invokes installed native error transport; kernel failure cannot retry', async () => {
  const f = fixture(), native = new Error('native syntax transport')
  f.codec.decode.mockRejectedValueOnce(native)
  const syntax = (f.session as any).parse('{') as Promise<unknown>
  let worker = ControlledWorker.instances.at(-1)!
  worker.onmessage!({ data: { ...worker.request, error: 'syntax', errorName: 'SyntaxError', sourceFailure: true } })
  await expect(syntax).rejects.toBe(native)
  f.codec.decode.mockClear()
  const kernel = (f.session as any).parse(JSON.stringify(f.target)) as Promise<unknown>
  worker = ControlledWorker.instances.at(-1)!
  worker.reply({ error: 'kernel allocation', errorName: 'RangeError', sourceFailure: false })
  await expect(kernel).rejects.toThrow('kernel allocation')
  expect(f.codec.decode).not.toHaveBeenCalled(); expect(f.editor.load).not.toHaveBeenCalled()
})


test.each(['custom', 'unavailable'])('a %s main resource identity retains the old path even if a Worker stub exists', async mode => {
  const f = fixture()
  vi.mocked(picking.pickingPreparationResources).mockReturnValueOnce(mode === 'custom'
    ? { wasmSha256: 'b'.repeat(64), fontSha256: 'c'.repeat(64), bundled: false } : undefined)
  expect(await f.session.open()).toBe(true)
  expect(ControlledWorker.instances).toHaveLength(0)
  expect(picking.prepareDocumentJsonForEditing).toHaveBeenCalledTimes(1)
})


test.each(['unknown', 'dev'])('a %s source build never certifies an isolated worker as same-build', async mode => {
  const f = fixture()
  vi.mocked(producerIdentityFields).mockReturnValueOnce(mode === 'unknown'
    ? { producerIdentityStatus: 0, producerBuildMode: 1 }
    : { producerIdentityStatus: 2, producerBuildMode: 2, producerSourceSha256: 'a'.repeat(64), producerWasmInputSha256: 'b'.repeat(64) })
  expect(await f.session.open()).toBe(true)
  expect(ControlledWorker.instances).toHaveLength(0)
  expect(picking.prepareDocumentJsonForEditing).toHaveBeenCalledTimes(1)
})
