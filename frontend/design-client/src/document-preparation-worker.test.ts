import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { documentCapacity, pinDocumentCapacity } from './document-capacity'
import { requestDocumentPreparation, consumeDocumentPreparationSourceFailure, type DocumentPreparationRequest } from './document-preparation-worker-client'
import { prepareDocumentJsonInWorker, takePreparedDocument, preparedDocumentEncoding } from './prepared-document'
import { blank } from './model'
import * as picking from './kernel/picking'
import { documentPreparationBuild, documentPreparationRuntime, sameDocumentPreparationBuild, sameDocumentPreparationRuntime } from './document-preparation-identity'

vi.mock('../../design-desktop/src/render-diagnostic-identity.mjs', () => ({ producerIdentityFields: vi.fn(() => ({ producerIdentityStatus: 2, producerBuildMode: 1, producerSourceSha256: 'a'.repeat(64), producerWasmInputSha256: 'b'.repeat(64) })) }))
vi.mock('./kernel/picking', () => ({ activateDocumentFonts: vi.fn(), pickingPreparationResources: vi.fn(() => ({ wasmSha256: 'b'.repeat(64), fontSha256: 'c'.repeat(64), bundled: true })), prepareDocumentForEditing: vi.fn(), prepareDocumentJsonForEditing: vi.fn() }))
pinDocumentCapacity(1024 * 1024)
const identity = { documentId: 'current', version: 4, generation: 7, session: 2 }
class ControlledWorker {
  static instances: ControlledWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { preventDefault(): void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  request!: DocumentPreparationRequest
  terminated = false
  constructor(readonly url: URL, readonly options: unknown) { ControlledWorker.instances.push(this) }
  postMessage(value: DocumentPreparationRequest) { this.request = structuredClone(value) }
  terminate() { this.terminated = true }
  result(extra: Record<string, unknown> = {}) {
    const document = JSON.parse(this.request.source)
    this.onmessage?.({ data: { ...this.request, document, validatedJson: JSON.stringify(document), ...extra } })
  }
}
const controllers: AbortController[] = []
const controller = () => { const c = new AbortController(); controllers.push(c); return c }
beforeEach(() => { ControlledWorker.instances = []; vi.stubGlobal('Worker', ControlledWorker); vi.clearAllMocks() })
afterEach(() => { controllers.splice(0).forEach(c => c.abort()); vi.unstubAllGlobals() })

test('controlled worker result alone mints a one-use owner; main fonts change only on adoption', async () => {
  const doc = blank('worker'), source = JSON.stringify(doc), c = controller()
  const pending = prepareDocumentJsonInWorker(source, identity, c.signal, () => true)
  const worker = ControlledWorker.instances[0]
  expect(worker.url.pathname.endsWith('/document-preparation-worker.ts')).toBe(true)
  expect(worker.request.memoryBytes).toBe(documentCapacity().memoryBytes)
  expect(worker.request.source).toBe(source)
  doc.name = 'caller changed'
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
  expect(picking.prepareDocumentJsonForEditing).not.toHaveBeenCalled()
  worker.result()
  const token = await pending, copy = token.snapshot(), encoding = preparedDocumentEncoding(token)!
  copy.name = 'independent copy'
  expect(token.snapshot().name).toBe('worker')
  expect(worker.terminated).toBe(true)
  expect(takePreparedDocument({ ...token })).toBeUndefined()
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
  const adopted = takePreparedDocument(token)!
  expect(adopted.name).toBe('worker'); expect(encoding.adopted(adopted)).toBe(true)
  expect(picking.activateDocumentFonts).toHaveBeenCalledExactlyOnceWith(adopted)
  expect(() => takePreparedDocument(token)).toThrow('已被接收')
})

test('one global worker and bounded queue: queued cancellation never dispatches, active cancellation terminates', async () => {
  const a = controller(), b = controller(), c = controller(), source = JSON.stringify(blank())
  const first = requestDocumentPreparation(source, identity, a.signal).catch(e => e)
  const second = requestDocumentPreparation(source, identity, b.signal).catch(e => e)
  const third = requestDocumentPreparation(source, identity, c.signal)
  expect(ControlledWorker.instances).toHaveLength(1)
  const old = ControlledWorker.instances[0], late = old.onmessage!
  b.abort(); expect((await second).name).toBe('AbortError')
  a.abort(); expect((await first).name).toBe('AbortError')
  expect(old.terminated).toBe(true); expect(ControlledWorker.instances).toHaveLength(2)
  late({ data: { ...old.request, document: blank('late'), validatedJson: '{}' } })
  ControlledWorker.instances[1].result()
  expect((await third).document.name).not.toBe('late')
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
})

test.each(['abort', 'stale'])('a %s result cannot reach ownership mint even after reply is delivered', async kind => {
  const c = controller(); let current = true
  const pending = prepareDocumentJsonInWorker(JSON.stringify(blank()), identity, c.signal, () => current)
  ControlledWorker.instances[0].result()
  if (kind === 'abort') c.abort(); else current = false
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
})

for (const mutate of [
  { id: 'different request' }, { protocol: 2 }, { identity: { ...identity, generation: 8 } },
  { identity: { ...identity, documentId: 'different document' } }, { identity: { ...identity, session: 3 } },
  { identity: { ...identity, version: 5 } }, { validatedJson: undefined },
  { runtime: undefined }, { runtime: { build: { sourceSha256: 'wrong', wasmInputSha256: 'b'.repeat(64) }, wasmSha256: 'b'.repeat(64), fontSha256: 'c'.repeat(64) } },
  { runtime: { build: { sourceSha256: 'a'.repeat(64), wasmInputSha256: 'b'.repeat(64) }, wasmSha256: 'b'.repeat(64), fontSha256: 'different font' } },
]) test(`unmatched or malformed reply is rejected: ${JSON.stringify(mutate)}`, async () => {
  const c = controller(), pending = prepareDocumentJsonInWorker(JSON.stringify(blank()), identity, c.signal, () => true)
  ControlledWorker.instances[0].result(mutate)
  await expect(pending).rejects.toThrow(/响应|身份/)
  expect(ControlledWorker.instances[0].terminated).toBe(true)
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
})

test('worker source-failure witness is private and consumed once; ordinary kernel failure never qualifies', async () => {
  for (const sourceFailure of [true, false]) {
    const pending = requestDocumentPreparation('{', identity, controller().signal).catch(e => e)
    const worker = ControlledWorker.instances.at(-1)!
    worker.onmessage!({ data: { ...worker.request, error: 'bad JSON', errorName: 'SyntaxError', sourceFailure } })
    const error = await pending
    expect(error).toBeInstanceOf(SyntaxError)
    expect(consumeDocumentPreparationSourceFailure(new SyntaxError('bad JSON'))).toBe(false)
    expect(consumeDocumentPreparationSourceFailure(error)).toBe(sourceFailure)
    expect(consumeDocumentPreparationSourceFailure(error)).toBe(false)
  }
})

test('oversize or queued source bytes fail boundedly without extra workers', async () => {
  const size = documentCapacity().documentBytes
  const error = await requestDocumentPreparation(' '.repeat(size + 1), identity, controller().signal).catch(e => e)
  expect(consumeDocumentPreparationSourceFailure(error)).toBe(true)
  expect(ControlledWorker.instances).toHaveLength(0)
  const pending = requestDocumentPreparation(' '.repeat(size), identity, controller().signal).catch(e => e)
  await expect(requestDocumentPreparation('{}', identity, controller().signal)).rejects.toThrow('队列已满')
  expect(ControlledWorker.instances).toHaveLength(1)
  controllers.at(-2)!.abort(); await pending
})

test.each(['error', 'messageerror', 'timeout'])('worker %s rejects and frees its lane without main-thread fallback', async mode => {
  vi.useFakeTimers()
  try {
    const pending = requestDocumentPreparation('{}', identity, controller().signal).catch(e => e)
    const worker = ControlledWorker.instances[0]
    if (mode === 'error') worker.onerror!({ preventDefault() {} })
    else if (mode === 'messageerror') worker.onmessageerror!()
    else vi.advanceTimersByTime(120_000)
    expect(await pending).toBeInstanceOf(Error); expect(worker.terminated).toBe(true)
    expect(picking.prepareDocumentJsonForEditing).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

test('actual worker entry pins capacity before initialization and invokes the full existing preparation entry exactly once', async () => {
  const source = readFileSync(new URL('./document-preparation-worker.ts', import.meta.url), 'utf8')
  const js = stripTypeScriptTypes(source).replace(/^import .*$/gm, '')
  const calls: string[] = [], replies: any[] = [], self: any = {}, doc = blank('actual entry')
  const prepare = vi.fn((source: string, capture: (json: string) => void) => {
    calls.push('prepare'); const value = JSON.parse(JSON.stringify(JSON.parse(source))); capture(JSON.stringify(value)); return value
  })
  const pin = (bytes: number) => { expect(bytes).toBe(1024 * 1024); calls.push('pin') }
  const initialize = async () => { calls.push('initialize') }
  self.postMessage = (reply: unknown) => replies.push(reply)
  new Function('assertDocumentJson', 'pinDocumentCapacity', 'consumeDocumentJsonSyntaxFailure', 'initializePicking', 'prepareDocumentJsonForEditing', 'documentPreparationBuild', 'documentPreparationRuntime', 'sameDocumentPreparationBuild', 'sameDocumentPreparationRuntime', 'self', js)(
    () => calls.push('size'), pin, () => false, initialize, prepare, documentPreparationBuild, documentPreparationRuntime, sameDocumentPreparationBuild, sameDocumentPreparationRuntime, self)
  // Canonicalization edge cases are delegated to the existing entry, not
  // reimplemented in the protocol. This mock proves the exact source survives.
  const raw = JSON.stringify(doc).replace('"schemaVersion":', '"opaque":[-0,1e999],"schemaVersion":')
  const request = { protocol: 1, id: 'request', identity, source: raw, memoryBytes: 1024 * 1024, runtime: documentPreparationRuntime() }
  await self.onmessage({ data: request })
  await self.onmessage({ data: { ...request, id: 'second' } })
  expect(calls).toEqual(['pin', 'size', 'initialize', 'prepare'])
  expect(prepare).toHaveBeenCalledExactlyOnceWith(raw, expect.any(Function), expect.any(Object))
  expect(replies).toHaveLength(1); expect(replies[0].validatedJson).toBe(JSON.stringify(JSON.parse(raw)))
  expect(replies[0].identity).toBe(identity)
})


test.each(['build', 'font', 'hash-unavailable', 'initialization'])('actual worker rejects %s mismatch before document preparation', async mode => {
  const source = readFileSync(new URL('./document-preparation-worker.ts', import.meta.url), 'utf8')
  const js = stripTypeScriptTypes(source).replace(/^import .*$/gm, '')
  const replies: any[] = [], self: any = { postMessage: (reply: unknown) => replies.push(reply) }
  const prepare = vi.fn(), expected = documentPreparationRuntime()!
  const build = mode === 'build' ? () => ({ ...expected.build, sourceSha256: 'd'.repeat(64) }) : documentPreparationBuild
  const runtime = mode === 'hash-unavailable' ? () => undefined : mode === 'font' ? () => ({ ...expected, fontSha256: 'd'.repeat(64) }) : documentPreparationRuntime
  new Function('assertDocumentJson', 'pinDocumentCapacity', 'consumeDocumentJsonSyntaxFailure', 'initializePicking', 'prepareDocumentJsonForEditing', 'documentPreparationBuild', 'documentPreparationRuntime', 'sameDocumentPreparationBuild', 'sameDocumentPreparationRuntime', 'self', js)(
    () => {}, () => {}, () => false, async () => { if (mode === 'initialization') throw new Error('initialization failed') },
    prepare, build, runtime, sameDocumentPreparationBuild, sameDocumentPreparationRuntime, self)
  await self.onmessage({ data: { protocol: 1, id: 'request', identity, source: JSON.stringify(blank()), memoryBytes: 1024 * 1024, runtime: expected } })
  expect(prepare).not.toHaveBeenCalled(); expect(replies).toHaveLength(1)
  expect(replies[0].error).toMatch(/身份|initialization/); expect(replies[0].sourceFailure).toBe(false)
})


test('main font epoch may change while queued and before mint without contaminating or rejecting the prepared owner', async () => {
  const prior = blank('prior'), target = { ...blank('target'), fonts: {} }, exportDoc = { ...blank('export'), fonts: {} }
  let activeFonts = prior.fonts, epoch: object = {}
  vi.mocked(picking.activateDocumentFonts).mockImplementation(doc => { activeFonts = doc.fonts; epoch = {} })
  try {
    const blocker = requestDocumentPreparation(JSON.stringify(prior), identity, controller().signal)
    const pending = prepareDocumentJsonInWorker(JSON.stringify(target), identity, controller().signal, () => true)
    picking.activateDocumentFonts(exportDoc)
    const queuedEpoch = epoch
    ControlledWorker.instances[0].result(); await blocker
    expect(epoch).toBe(queuedEpoch); expect(activeFonts).toBe(exportDoc.fonts)
    ControlledWorker.instances[1].result()
    picking.activateDocumentFonts(prior)
    const mintEpoch = epoch
    const token = await pending
    expect(epoch).toBe(mintEpoch); expect(activeFonts).toBe(prior.fonts)
    const adopted = takePreparedDocument(token)!
    expect(activeFonts).toBe(adopted.fonts); expect(epoch).not.toBe(mintEpoch)
    expect(adopted.name).toBe('target')
  } finally { vi.mocked(picking.activateDocumentFonts).mockReset() }
})

test('a changed immutable main resource identity after reply but before mint rejects instead of borrowing the old proof', async () => {
  const pending = prepareDocumentJsonInWorker(JSON.stringify(blank()), identity, controller().signal, () => true)
  ControlledWorker.instances[0].result()
  vi.mocked(picking.pickingPreparationResources).mockReturnValueOnce({ wasmSha256: 'b'.repeat(64), fontSha256: 'd'.repeat(64), bundled: true })
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(picking.activateDocumentFonts).not.toHaveBeenCalled()
})
