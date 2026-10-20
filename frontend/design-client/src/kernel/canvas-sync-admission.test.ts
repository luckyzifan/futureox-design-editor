import { afterEach, expect, test, vi } from 'vitest'
import { blank, node } from '../model'
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
test('76 obsolete canvas snapshots are never dispatched: accepted patch ACK gates exact final diff', async () => {
  const f = await fixture()
  try {
    const shape = node('rectangle', 0, 0, 12, 12)
    f.document.nodes[shape.id] = shape; f.document.pages[0].children = [shape.id]
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const preview = { renderIntent: 'preview', livePreview: true }
    const snapshots = Array.from({ length: 78 }, (_, i) => ({ ...f.document, nodes: { ...f.document.nodes, [shape.id]: { ...shape, opacity: (i + 1) / 100 } } }))
    const preserved = JSON.stringify(snapshots)
    const promises: Promise<unknown>[] = [f.render(snapshots[0], preview).catch(e => String(e))]
    const accepted = await f.next(2)
    for (let i = 1; i < snapshots.length; i++) {
      f.client.cancelPreview()
      promises.push(f.render(snapshots[i], preview).catch(e => String(e)))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.worker.requests()).toHaveLength(2)
    // Presentation cancellation cannot unlock an accepted mutation obligation.
    f.ack(accepted, null)
    const last = await f.next(3)
    expect(last.baseDocumentRevision).toBe(2); expect(last.documentRevision).toBe(3)
    expect(last.documentPatch).toBeTruthy(); expect(last.patchBaseReceipt).toBeUndefined()
    const { applyDocumentPatch } = await import('../document-patch')
    const actual = applyDocumentPatch(applyDocumentPatch(f.document, JSON.parse(accepted.documentPatch)), JSON.parse(last.documentPatch))
    expect(actual).toEqual(snapshots.at(-1))
    f.ack(last, null); f.finish(last)
    const outcomes = await Promise.all(promises)
    expect(outcomes.slice(0, -1).every(x => String(x).includes('PREVIEW_CANCELLED'))).toBe(true)
    expect(JSON.stringify(snapshots)).toBe(preserved) // history is caller-owned, never rewritten
    // Independent real WASM mutation/pixel oracle; only two patches vs 78.
    const { readFileSync } = await import('node:fs')
    const kernel = await import('../generated/design-kernel/design_kernel')
    await kernel.default({ module_or_path: new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))) })
    const merged = new kernel.VectorEngine(), serial = new kernel.VectorEngine()
    try {
      merged.load_document(JSON.stringify(f.document)); serial.load_document(JSON.stringify(f.document))
      merged.apply_document_patch_with_damage(accepted.documentPatch); merged.apply_document_patch_with_damage(last.documentPatch)
      const { documentPatch } = await import('../document-patch')
      let before = f.document
      for (const snapshot of snapshots) { serial.apply_document_patch_with_damage(JSON.stringify(documentPatch(before, snapshot))); before = snapshot }
      const options = JSON.stringify({ pageId: f.document.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false })
      expect(merged.compile_gpu_packet(options)).toEqual(serial.compile_gpu_packet(options))
      expect(merged.render_png(options)).toEqual(serial.render_png(options))
      // Undo remains an authored transition, not an invented intermediate ACK.
      merged.apply_document_patch_with_damage(JSON.stringify(documentPatch(snapshots.at(-1)!, snapshots.at(-2)!)))
      serial.load_document(JSON.stringify(snapshots.at(-2)))
      expect(merged.compile_gpu_packet(options)).toEqual(serial.compile_gpu_packet(options))
      expect(merged.render_png(options)).toEqual(serial.render_png(options))
    } finally { merged.free(); serial.free() }
  } finally { f.client.dispose() }
})

test('export is an ordered exact snapshot barrier between cancelled preview groups', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const preview = { renderIntent: 'preview', livePreview: true }
    const a = { ...f.document, name: 'A' }, b = { ...a, name: 'export B' }, c = { ...b, name: 'latest C' }
    const first = f.render(a, preview).catch(String), accepted = await f.next(2)
    f.client.cancelPreview()
    const exported = f.render(b, {}, undefined, true)
    const latest = f.render(c, preview)
    await new Promise(resolve => setTimeout(resolve, 10)); expect(f.worker.requests()).toHaveLength(2)
    f.ack(accepted, null)
    await vi.waitFor(() => expect(f.worker.requests()).toHaveLength(4))
    const [exact, last] = f.worker.requests().slice(2)
    expect(exact.png).toBe(true); expect(JSON.parse(exact.documentPatch).fields.name).toBe('export B')
    expect(last.baseDocumentRevision).toBe(exact.documentRevision)
    expect(JSON.parse(last.documentPatch).fields.name).toBe('latest C')
    f.ack(exact, null); f.finish(exact); f.ack(last, null); f.finish(last)
    await Promise.all([first, exported, latest])
  } finally { f.client.dispose() }
})

test('failed accepted mutation after visual cancellation cannot poison the next diff base', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const preview = { renderIntent: 'preview', livePreview: true }
    const failed = f.render({ ...f.document, name: 'failed' }, preview).catch(String), accepted = await f.next(2)
    f.client.cancelPreview()
    const target = { ...f.document, name: 'exact recovery', fonts: {} }, recovery = f.render(target, preview)
    f.worker.reply({ id: accepted.id, error: 'STALE_AUTHORED_PATCH_BASE' })
    const last = await f.next(3)
    expect(last.document).toBe(JSON.stringify(target)); expect(last.documentPatch).toBeUndefined()
    f.ack(last); f.finish(last); await Promise.all([failed, recovery])
  } finally { f.client.dispose() }
})

test('reset releases pending mutation fence without replaying old-owner snapshots or acknowledging late receipts', async () => {
  const f = await fixture()
  try {
    const preview = { renderIntent: 'preview', livePreview: true }
    const first = f.render(f.document, preview).catch(String), accepted = await f.next(1)
    const queued = f.render({ ...f.document, name: 'queued old owner' }, preview).catch(String)
    ;(f.client as any).reset(Error('owner reset'))
    const outcomes = await Promise.all([first, queued])
    expect(outcomes.every(x => typeof x === 'string')).toBe(true)
    expect(f.worker.requests()).toHaveLength(1)
    f.ack(accepted)
    expect((f.client as any).synchronizationInputs.size).toBe(0)
    expect((f.client as any).authoredPreparation.receiptFor(f.document)).toBeUndefined()
  } finally { f.client.dispose() }
})

test('root/resource fields and document owner replacement remain exact across admission', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const preview = { renderIntent: 'preview', livePreview: true }
    const acceptedDoc = { ...f.document, name: 'accepted' }
    const first = f.render(acceptedDoc, preview).catch(String), accepted = await f.next(2)
    f.client.cancelPreview()
    const hidden = f.render({ ...acceptedDoc, fonts: { transient: 'not-uploaded' }, extension: { value: 1 } } as any, preview).catch(String)
    f.client.cancelPreview()
    const target = { ...acceptedDoc, fonts: { final: 'canonical-bytes' }, extension: { value: 2, unknown: ['retained'] } } as any
    const latest = f.render(target, preview)
    f.ack(accepted, null)
    const last = await f.next(3), patch = JSON.parse(last.documentPatch)
    expect(patch.fields.fonts).toEqual(target.fonts); expect(patch.fields.extension).toEqual(target.extension)
    expect(last.patchBaseReceipt).toBeUndefined()
    f.ack(last, null); f.finish(last); await Promise.all([first, hidden, latest])
    const replacement = blank('new owner'), reset = f.render(replacement, preview), full = await f.next(4)
    expect(full.document).toBe(JSON.stringify(replacement)); expect(full.documentPatch).toBeUndefined()
    f.ack(full); f.finish(full); await reset
  } finally { f.client.dispose() }
})

test('owner abort does not release accepted sync and an exact same-state read stays ordered', async () => {
  const f = await fixture()
  try {
    const signal = new AbortController()
    const pending = f.render(f.document, { renderIntent: 'preview', livePreview: true }, signal.signal).catch(String)
    const accepted = await f.next(1)
    signal.abort(); expect(await pending).toContain('PREVIEW_CANCELLED')
    const exact = f.render(f.document, {}, undefined, true)
    await new Promise(resolve => setTimeout(resolve, 10)); expect(f.worker.requests()).toHaveLength(1)
    f.ack(accepted)
    const output = await f.next(2)
    expect(output.document).toBeUndefined(); expect(output.documentPatch).toBeUndefined(); expect(output.documentRevision).toBe(accepted.documentRevision)
    f.finish(output); await exact
  } finally { f.client.dispose() }
})

test('pre-dispatch abort after snapshot advance invalidates base before next same-identity submission', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const target = { ...f.document, name: 'never accepted' }, signal = new AbortController()
    const client = f.client as any, request = client.request.bind(client)
    client.request = (...args: any[]) => { client.request = request; signal.abort(); return request(...args) }
    await expect(f.render(target, { renderIntent: 'preview', livePreview: true }, signal.signal)).rejects.toThrow('PREVIEW_CANCELLED')
    expect(f.worker.requests()).toHaveLength(1); expect(client.documentSnapshot).toBeUndefined()
    const retry = f.render(target), next = await f.next(2)
    expect(next.document).toBe(JSON.stringify(target)); expect(next.documentPatch).toBeUndefined()
    f.ack(next); f.finish(next); await retry
  } finally { f.client.dispose() }
})

test('128-input rejection releases admission and invalidates advanced snapshot synchronously', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const client = f.client as any, target = { ...f.document, name: 'budget rejection' }
    for (let i = 0; i < 128; i++) client.synchronizationInputs.set(1000 + i, { document: f.document })
    await expect(f.render(target, { renderIntent: 'preview', livePreview: true })).rejects.toThrow('input budget exceeded')
    expect(client.documentSnapshot).toBeUndefined(); expect(f.worker.requests()).toHaveLength(1)
    client.synchronizationInputs.clear()
    const retry = f.render(target), next = await f.next(2)
    expect(next.document).toBe(JSON.stringify(target)); expect(next.documentPatch).toBeUndefined()
    f.ack(next); f.finish(next); await retry
  } finally { f.client.dispose() }
})

test('synchronous postMessage throw clears owner, obligations and optimistic snapshot without replay', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const post = f.worker.postMessage.bind(f.worker)
    f.worker.postMessage = (value: any) => { if (value.id && !value.command) throw Error('transport rejected'); post(value) }
    const failure = f.render({ ...f.document, name: 'failed transport' }, { renderIntent: 'preview', livePreview: true })
    const originalSubmission = (f.client as any).nativeSubmission
    await expect(failure).rejects.toThrow('transport rejected')
    await expect(originalSubmission).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect((f.client as any).documentSnapshot).toBeUndefined()
    expect((f.client as any).synchronizationInputs.size).toBe(0)
    expect((f.client as any).worker).toBeUndefined()
    expect(f.worker.requests()).toHaveLength(1)
  } finally { f.client.dispose(); vi.useRealTimers() }
})

test('dispose between preparation and dispatch releases gate without sending or leaking synchronization timer', async () => {
  const f = await fixture()
  try {
    const client = f.client as any, request = client.request.bind(client)
    client.request = (...args: any[]) => { client.request = request; f.client.dispose(); return request(...args) }
    await expect(f.render(f.document, { renderIntent: 'preview', livePreview: true })).rejects.toThrow('渲染器已关闭')
    expect(client.documentSnapshot).toBeUndefined(); expect(client.synchronizationInputs.size).toBe(0)
    expect(f.worker.requests()).toHaveLength(0)
  } finally { f.client.dispose() }
})

test('pixel success without ACK never authorizes queued mutation and synchronization watchdog resets old owner', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await fixture()
  try {
    const first = f.render(f.document, { renderIntent: 'preview', livePreview: true }), accepted = await f.next(1)
    f.finish(accepted); await first
    const next = f.render({ ...f.document, name: 'must wait' }, { renderIntent: 'preview', livePreview: true }).catch(String)
    await vi.advanceTimersByTimeAsync(29900)
    expect(f.worker.requests()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(await next).toContain('渲染器已关闭')
    expect((f.client as any).worker).toBeUndefined(); expect((f.client as any).synchronizationInputs.size).toBe(0)
    f.ack(accepted)
    expect((f.client as any).authoredPreparation.receiptFor(f.document)).toBeUndefined()
  } finally { f.client.dispose(); vi.useRealTimers() }
})

test('already-queued old synchronization watchdog callback cannot reset a newer worker owner', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const f = await fixture()
  try {
    const first = f.render(f.document, { renderIntent: 'preview', livePreview: true }), accepted = await f.next(1)
    const callback = timer.mock.calls.find(([fn]) => String(fn).includes('Document synchronization timed out'))?.[0]
    expect(callback).toBeTypeOf('function')
    f.ack(accepted); f.finish(accepted); await first
    const client = f.client as any
    client.reset(Error('replace owner')); client.startWorker()
    const replacement = client.worker
    ;(callback as () => void)()
    expect(client.worker).toBe(replacement)
  } finally { f.client.dispose(); timer.mockRestore() }
})
