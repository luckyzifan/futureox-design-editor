import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import type { PreparationStateReceiptV1 } from './preparation-state'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
const receipt = (nonce = '1'): PreparationStateReceiptV1 => ({ protocol: 1, sessionGeneration: 'session', canvasOwner: 'owner', documentIncarnation: 'incarnation', lane: 'canvas', synchronizedRevision: nonce, resourceEpoch: nonce, nonce })
async function fixture() {
  const native = { open: async () => 'owned', close: vi.fn(async () => {}), request: vi.fn(async (_id: string, request: any) => ({ id: 1, value: JSON.stringify(request.args[0]) })) }
  class WorkerStub {
    static instances: WorkerStub[] = []
    messages: any[] = []; onmessage?: (event: any) => void
    constructor() { WorkerStub.instances.push(this) }
    postMessage(value: any) { this.messages.push(value) }
    terminate() {}
    reply(data: any) { this.onmessage?.({ data }) }
    requests() { return this.messages.filter(m => m.id && !m.command) }
  }
  vi.stubGlobal('window', { coreDesktop: { version: 1, renderPolicy: { cpuOnly: true }, preparation: native } })
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient } = await import('./client')
  const client = new KernelClient(), worker = WorkerStub.instances[0], document = blank()
  const options = { pageId: document.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }
  const render = (doc = document, extra = {}, signal?: AbortSignal, png = false) => client.render(doc, { ...options, ...extra }, png, 'cpu', false, false, undefined, undefined, signal)
  const next = async (count: number) => { await vi.waitFor(() => expect(worker.requests()).toHaveLength(count)); return worker.requests()[count - 1] }
  const ack = (request: any, value: PreparationStateReceiptV1 | null = receipt()) => worker.reply({ id: request.id, documentSynchronized: true, stateReceipt: value })
  const finish = (request: any) => worker.reply({ id: request.id, backend: 'cpu', milliseconds: 0, stats: { nodes: 0 } })
  return { native, client, worker, document, render, next, ack, finish }
}
test('acknowledged exact canvas identity admits empty derivation with zero full serialization or payload', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const calls = f.native.request.mock.calls.length
    const second = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    expect(two.deriveFrom).toEqual(receipt()); expect(two.document).toBeUndefined(); expect(two.documentPatch).toBeUndefined()
    expect(f.native.request).toHaveBeenCalledTimes(calls)
    f.ack(two, null); f.finish(two); await second
  } finally { f.client.dispose() }
})
test('same ID but different authored object, missing acknowledgment, and post-patch binding all fall back', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1)
    const unacked = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    expect(two.deriveFrom).toBeUndefined(); expect(two.document).toBe(JSON.stringify(f.document))
    f.ack(one); f.finish(one); f.finish(two); await Promise.all([first, unacked])
    const changed = { ...f.document, name: 'new object with same ID' }
    const patch = f.render(changed), three = await f.next(3)
    expect(three.documentPatch).toBeTruthy()
    // A stale full-load ack arriving after mutation submission is unusable.
    f.ack(one); f.ack(three); f.finish(three); await patch
    const derived = f.render(changed, { interactionChannel: true }), four = await f.next(4)
    expect(four.deriveFrom).toBeUndefined(); expect(four.documentPatch).toBeTruthy()
    f.finish(four); await derived
  } finally { f.client.dispose() }
})
test('fallback serializes the captured intended object, not a newer canvas or Rust normalized value', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const interaction = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    const newer = { ...f.document, name: 'newer canvas' }, update = f.render(newer), three = await f.next(3)
    f.worker.reply({ id: two.id, documentFallback: true })
    await vi.waitFor(() => expect(f.worker.messages.some(m => m.command === 'document-fallback')).toBe(true))
    const fallback = f.worker.messages.find(m => m.command === 'document-fallback')
    expect(fallback.document).toBe(JSON.stringify(f.document)); expect(fallback.document).not.toBe(JSON.stringify(newer))
    f.ack(two, null); f.finish(two); f.finish(three); await Promise.all([interaction, update])
  } finally { f.client.dispose() }
})
test('cancelled preview still supplies its accepted mutation fallback, while exact output ignores preview signal', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const signal = new AbortController()
    const preview = f.render(f.document, { interactionChannel: true, renderIntent: 'preview', livePreview: true }, signal.signal)
    const rejected = expect(preview).rejects.toThrow('PREVIEW_CANCELLED'), two = await f.next(2)
    signal.abort(); await rejected
    f.worker.reply({ id: two.id, documentFallback: true })
    await vi.waitFor(() => expect(f.worker.messages.some(m => m.command === 'document-fallback' && m.id === two.id)).toBe(true))
    f.ack(two, null)
    const exact = f.render(f.document, { interactionChannel: true }, signal.signal, true), three = await f.next(3)
    expect(three.png).toBe(true); f.finish(three); await exact
  } finally { f.client.dispose() }
})
test('cancelled accepted synchronizations remain bounded and reset clears captures and rejects late ACKs', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 128; i++) {
      const result = (f.client as any).request({ channel: 'interaction', deriveFrom: receipt(), documentRevision: i + 1,
        options: { livePreview: true } }, undefined, [], undefined, { document: { ...f.document, name: `captured-${i}` } })
      pending.push(result.catch((error: Error) => { expect(error.message).toBe('PREVIEW_CANCELLED') }))
      f.client.cancelPreview('interaction')
    }
    await Promise.all(pending)
    expect((f.client as any).synchronizationInputs.size).toBe(128)
    const dispatched = f.worker.requests().length
    await expect((f.client as any).request({ channel: 'interaction' }, undefined, [], undefined, { document: f.document })).rejects.toThrow('input budget exceeded')
    expect(f.worker.requests()).toHaveLength(dispatched)
    await expect(f.render(f.document, { interactionChannel: true })).rejects.toThrow('input budget exceeded')
    expect((f.client as any).interactionSnapshot).toBeUndefined()
    const rejectedRevision = (f.client as any).interactionRevision
    f.ack(f.worker.requests()[1], null)
    expect((f.client as any).synchronizationInputs.size).toBe(127)
    const retry = f.render(f.document, { interactionChannel: true }), next = await f.next(dispatched + 1)
    expect(next.deriveFrom).toEqual(receipt()); expect(next.documentPatch).toBeUndefined()
    expect(next.documentRevision).toBeGreaterThan(rejectedRevision)
    f.ack(next, null); f.finish(next); await retry
    ;(f.client as any).reset(Error('test reset'))
    expect((f.client as any).synchronizationInputs.size).toBe(0)
    f.ack(one)
    expect((f.client as any).authoredPreparation.receiptFor(f.document)).toBeUndefined()
  } finally { f.client.dispose() }
})
