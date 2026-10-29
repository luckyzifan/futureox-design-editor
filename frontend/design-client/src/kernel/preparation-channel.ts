import type { PreparationStateReceiptV1 } from './preparation-state'
export type PreparationMethod = 'preparation_capabilities_v1' | 'derive_document_v1' | 'warm_resources' | 'initialize' | 'load_document' | 'load_source_snapshot' | 'apply_document_patch_with_damage' | 'apply_interaction_transforms' |
  'compile_gpu_packet' | 'render_linear' | 'render_png' | 'render_color_png' | 'render_region_png' |
  'render_cpu_frame' | 'stats' | 'gpu_memory_breakdown'
export type PreparationProgress = { backendCode: 1 | 2; boundaryCode: number; boundaryDurationMs?: number; bridgeBoundaryAt?: number }
export type PreparationReply = { progress?: PreparationProgress; bridgeBoundaryAt?: number; id: number; value?: unknown; settings?: string; error?: string; fatal?: string; documentFork?: boolean; compileStats?:Record<string,unknown>; stateReceipt?: PreparationStateReceiptV1 | null }

const methods: PreparationMethod[] = ['warm_resources','initialize','load_document','apply_document_patch_with_damage','apply_interaction_transforms','compile_gpu_packet','render_linear','render_png','render_color_png','render_region_png','render_cpu_frame','stats','gpu_memory_breakdown','preparation_capabilities_v1','derive_document_v1','load_source_snapshot']
type Diagnostics = { enabled: () => boolean; owner: () => number; record: (event: string, fields: Record<string, number | boolean>) => void }
type Job = { cancellation?: Int32Array<SharedArrayBuffer>; cancellable?: boolean; owner?: number; queuedAt?: number; startedAt?: number; id: number; lane: string; method: PreparationMethod; args: unknown[];
  resolve: (reply: PreparationReply) => void; reject: (error: Error) => void; cleanup?: () => void; cancelled?: boolean; backendCode?: number; boundaryCode?: number; diagnosticTimer?: ReturnType<typeof setTimeout> }
/** CPU preparation has its own event loop. Keep at most one physical job in
 * flight until its actual reply, including cooperative cancellation. Later packet
 * jobs remain here so superseded consumers can remove them before dispatch.
 * Document mutations, delta sessions and exact outputs are never cancellable. */
export class PreparationChannel {
  private sequence = 0
  private operationSequence = 0
  private receipts = new Map<string, PreparationStateReceiptV1>()
  private capability?: Promise<{ emptyDeltaDerivation: boolean; guardedPatchReceiptV1: boolean; nativeSourceSnapshot: boolean }>
  private static mutates(method: PreparationMethod) {
    return ['initialize', 'load_document', 'load_source_snapshot', 'apply_document_patch_with_damage', 'apply_interaction_transforms', 'derive_document_v1'].includes(method)
  }
  currentReceipt(lane: string): PreparationStateReceiptV1 | undefined {
    if (this.closed || [this.active, ...this.queued].some(job => job && PreparationChannel.mutates(job.method) &&
      job.lane === lane)) return undefined
    return this.receipts.get(lane)
  }
  private capabilities() {
    return this.capability ??= this.request('canvas', 'preparation_capabilities_v1').then(reply => {
      const value = reply.value as { protocol?: unknown; emptyDeltaDerivation?: unknown; guardedPatchReceiptV1?: unknown; nativeSourceSnapshot?:unknown } | undefined
      return { emptyDeltaDerivation: value?.protocol === 1 && value.emptyDeltaDerivation === true,
        guardedPatchReceiptV1: value?.protocol === 1 && value.guardedPatchReceiptV1 === true,
        nativeSourceSnapshot:value?.protocol===1&&value.nativeSourceSnapshot===true }
    }, () => ({ emptyDeltaDerivation: false, guardedPatchReceiptV1: false, nativeSourceSnapshot:false }))
  }
  supportsDerivation(): Promise<boolean> { return this.capabilities().then(value => value.emptyDeltaDerivation) }
  supportsGuardedPatch(): Promise<boolean> { return this.capabilities().then(value => value.guardedPatchReceiptV1) }
  supportsNativeSource(): Promise<boolean> { return this.capabilities().then(value => value.nativeSourceSnapshot) }
  private static guardedPatch(job: Pick<Job, 'method' | 'args'>) {
    return job.method === 'apply_document_patch_with_damage' && job.args.length === 2
  }
  nextDerivationOperation() { return ++this.operationSequence }
  private readonly originChannelId = (() => { const words = crypto.getRandomValues(new Uint32Array(2)); return (words[0] & 0xffff) * 0x100000000 + words[1] })()
  private observedBackendCode = 0
  get diagnosticBackendCode() { return this.observedBackendCode }
  private closed?: Error
  private active?: Job
  private queued: Job[] = []
  constructor(private port: MessagePort, private diagnostics?: Diagnostics) {
    port.onmessage = event => {
      const reply = event.data as PreparationReply
      if (reply.fatal) { this.close(new Error(reply.fatal)); return }
      const job = this.active
      if (!job || job.id !== reply.id) return
      // Clocks carry their performance time origin: retain sender time separately
      // from this worker's receive timestamp. This is delivery/event-loop delay,
      // not Rust execution time. Invalid or clock-discontinuous ages are omitted.
      const bridgeTiming = (sentAt: unknown) => {
        if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt < 0 || sentAt > 1e15) return {}
        const age = performance.timeOrigin + performance.now() - sentAt
        return { bridgeBoundaryAt: sentAt, ...(age >= 0 && age <= 120000 ? { bridgeDeliveryMs: age } : {}) }
      }
      // Progress never completes the physical job, even after consumer cancellation.
      if ('progress' in reply) {
        const p = reply.progress
        if (p && (p.backendCode === 1 || p.backendCode === 2) && Number.isInteger(p.boundaryCode) && p.boundaryCode >= 1 && p.boundaryCode <= 16 &&
          (p.boundaryDurationMs === undefined || (Number.isFinite(p.boundaryDurationMs) && p.boundaryDurationMs >= 0 && p.boundaryDurationMs <= 120000))) {
          this.observedBackendCode = p.backendCode
          job.backendCode = p.backendCode; job.boundaryCode = p.boundaryCode
          this.trace(job, 5, { ...bridgeTiming(p.bridgeBoundaryAt), backendCode: p.backendCode, boundaryCode: p.boundaryCode, ...(p.boundaryDurationMs === undefined ? {} : { boundaryDurationMs: p.boundaryDurationMs }) })
        }
        return
      }
      clearTimeout(job.diagnosticTimer)
      this.trace(job, 4, { ...bridgeTiming(reply.bridgeBoundaryAt), durationMs: performance.now() - (job.startedAt ?? performance.now()), documentFork: reply.documentFork === true })
      this.active = undefined
      if (PreparationChannel.mutates(job.method)) {
        if (!reply.error && reply.stateReceipt) this.receipts.set(job.lane, reply.stateReceipt)
        else if (!(job.method === 'derive_document_v1' && reply.error) &&
          !(PreparationChannel.guardedPatch(job) && (reply.error === 'STALE_BASE' || reply.error === 'PATCH_GUARD_SCHEMA'))) this.receipts.delete(job.lane)
      }
      job.cleanup?.()
      // A late packet owns only CPU bytes, never a GPU resource. Do not
      // publish it or admit it to a cache after the consumer was cancelled.
      if (!job.cancelled) {
        if (reply.error) job.reject(new Error(reply.error)); else job.resolve(reply)
      }
      this.dispatch()
    }
    port.onmessageerror = () => this.close(new Error('CPU preparation response could not be decoded'))
    port.start()
  }
  request(lane: string, method: PreparationMethod, args: unknown[] = [], signal?: AbortSignal): Promise<PreparationReply> {
    if (this.closed) return Promise.reject(this.closed)
    if (signal && method !== 'compile_gpu_packet') return Promise.reject(new Error('Only stateless packet preparation can be cancelled'))
    if (signal?.aborted) return Promise.reject(new Error('PREVIEW_CANCELLED'))
    if (this.queued.length + Number(!!this.active) >= 128) return Promise.reject(new Error('CPU preparation request budget exceeded'))
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, lane, method, args, resolve, reject, cancellable: !!signal }
      if (signal && typeof SharedArrayBuffer !== 'undefined') job.cancellation = new Int32Array(new SharedArrayBuffer(4))
      if (this.diagnostics?.enabled()) { job.owner = this.diagnostics.owner(); job.queuedAt = performance.now() }
      this.trace(job, 1)
      if (signal) {
        const cancel = () => {
          job.cancelled = true
          if (job.cancellation) Atomics.store(job.cancellation, 0, 1)
          else if (this.active === job) this.port.postMessage({ cancel: job.id })
          this.trace(job, 3)
          const index = this.queued.indexOf(job)
          if (index >= 0) this.queued.splice(index, 1)
          job.cleanup?.()
          reject(new Error('PREVIEW_CANCELLED'))
          // Keep an active job as the transport fence until its actual reply.
        }
        signal.addEventListener('abort', cancel, { once: true })
        job.cleanup = () => signal.removeEventListener('abort', cancel)
      }
      if (PreparationChannel.mutates(method) && method !== 'derive_document_v1' && !PreparationChannel.guardedPatch(job)) {
        this.receipts.delete(lane)
      }
      this.queued.push(job)
      this.dispatch()
    })
  }
  private trace(job: Job, phase: number, extra: Record<string, number | boolean> = {}) {
    if (!this.diagnostics?.enabled()) return
    this.diagnostics.record('preparation', { originChannelId: this.originChannelId, requestId: job.owner ?? 0, preparationId: job.id, methodCode: methods.indexOf(job.method) + 1, phase, channel: job.lane === 'interaction' ? 1 : 0, queueDepth: this.queued.length, activePreparationId: this.active?.id ?? 0, superseded: job.cancelled === true, backendCode: job.backendCode ?? 0, boundaryCode: job.boundaryCode ?? 0, ...extra })
  }
  private watch(job: Job, sample = 0) {
    if (!this.diagnostics?.enabled() || sample >= 8) return
    job.diagnosticTimer = setTimeout(() => {
      if (this.active !== job || this.closed) return
      this.trace(job, 6, { durationMs: performance.now() - (job.startedAt ?? performance.now()), count: sample + 1 })
      this.watch(job, sample + 1)
    }, 1000 * 2 ** sample)
    ;(job.diagnosticTimer as unknown as { unref?: () => void }).unref?.()
  }
  private dispatch() {
    if (this.active || this.closed) return
    const job = this.queued.shift()
    if (!job) return
    this.active = job
    if (this.diagnostics?.enabled()) job.startedAt = performance.now()
    this.trace(job, 2, { waitMs: (job.startedAt ?? 0) - (job.queuedAt ?? 0) })
    this.watch(job)
    try { this.port.postMessage({ id: job.id, lane: job.lane, method: job.method, args: job.args, ...(job.cancellable ? { cancellable: true, cancellation: job.cancellation?.buffer } : {}), ...(this.diagnostics?.enabled() ? { diagnostics: { originChannelId: this.originChannelId, requestId: job.owner ?? 0 } } : {}) }) }
    catch (error) {
      clearTimeout(job.diagnosticTimer); this.trace(job, 7, { reasonCode: 1 }); this.active = undefined; job.cleanup?.(); job.reject(error as Error); this.dispatch()
    }
  }
  close(error = new Error('CPU preparation closed')) {
    this.closed = error
    this.receipts.clear()
    this.port.close()
    for (const job of [...(this.active ? [this.active] : []), ...this.queued]) { clearTimeout(job.diagnosticTimer); this.trace(job, 7, { reasonCode: 2 }); job.cleanup?.(); job.reject(error) }
    this.active = undefined; this.queued = []
  }
}
