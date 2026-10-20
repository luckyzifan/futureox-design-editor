export type PreparationMethod = 'warm_resources' | 'initialize' | 'load_document' | 'apply_document_patch_with_damage' | 'apply_interaction_transforms' |
  'compile_gpu_scene_update' | 'clear_gpu_scene_session' | 'compile_gpu_packet' | 'render_linear' | 'render_png' | 'render_color_png' | 'render_region_png' |
  'render_cpu_frame' | 'stats' | 'gpu_memory_breakdown'
export type PreparationReply = { id: number; value?: unknown; settings?: string; error?: string; fatal?: string; documentFork?: boolean; compileStats?:Record<string,unknown> }

const methods: PreparationMethod[] = ['warm_resources','initialize','load_document','apply_document_patch_with_damage','apply_interaction_transforms','compile_gpu_scene_update','clear_gpu_scene_session','compile_gpu_packet','render_linear','render_png','render_color_png','render_region_png','render_cpu_frame','stats','gpu_memory_breakdown']
type Diagnostics = { enabled: () => boolean; owner: () => number; record: (event: string, fields: Record<string, number | boolean>) => void }
type Job = { owner?: number; queuedAt?: number; startedAt?: number; id: number; lane: string; method: PreparationMethod; args: unknown[];
  resolve: (reply: PreparationReply) => void; reject: (error: Error) => void; cleanup?: () => void; cancelled?: boolean }
/** CPU preparation has its own event loop. Keep at most one physical job in
 * flight: its synchronous WASM/native call cannot be interrupted. Later packet
 * jobs remain here so superseded consumers can remove them before dispatch.
 * Document mutations, delta sessions and exact outputs are never cancellable. */
export class PreparationChannel {
  private sequence = 0
  private closed?: Error
  private active?: Job
  private queued: Job[] = []
  constructor(private port: MessagePort, private diagnostics?: Diagnostics) {
    port.onmessage = event => {
      const reply = event.data as PreparationReply
      if (reply.fatal) { this.close(new Error(reply.fatal)); return }
      const job = this.active
      if (!job || job.id !== reply.id) return
      this.trace(job, 4, { durationMs: performance.now() - (job.startedAt ?? performance.now()), documentFork: reply.documentFork === true })
      this.active = undefined
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
      const job: Job = { id: ++this.sequence, lane, method, args, resolve, reject }
      if (this.diagnostics?.enabled()) { job.owner = this.diagnostics.owner(); job.queuedAt = performance.now() }
      this.trace(job, 1)
      if (signal) {
        const cancel = () => {
          job.cancelled = true
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
      this.queued.push(job)
      this.dispatch()
    })
  }
  private trace(job: Job, phase: number, extra: Record<string, number | boolean> = {}) {
    if (!this.diagnostics?.enabled()) return
    this.diagnostics.record('preparation', { requestId: job.owner ?? 0, preparationId: job.id, methodCode: methods.indexOf(job.method) + 1, phase, channel: job.lane === 'interaction' ? 1 : 0, queueDepth: this.queued.length, activePreparationId: this.active?.id ?? 0, superseded: job.cancelled === true, ...extra })
  }
  private dispatch() {
    if (this.active || this.closed) return
    const job = this.queued.shift()
    if (!job) return
    this.active = job
    if (this.diagnostics?.enabled()) job.startedAt = performance.now()
    this.trace(job, 2, { waitMs: (job.startedAt ?? 0) - (job.queuedAt ?? 0) })
    try { this.port.postMessage({ id: job.id, lane: job.lane, method: job.method, args: job.args }) }
    catch (error) {
      this.active = undefined; job.cleanup?.(); job.reject(error as Error); this.dispatch()
    }
  }
  close(error = new Error('CPU preparation closed')) {
    this.closed = error
    this.port.close()
    for (const job of [...(this.active ? [this.active] : []), ...this.queued]) { job.cleanup?.(); job.reject(error) }
    this.active = undefined; this.queued = []
  }
}
