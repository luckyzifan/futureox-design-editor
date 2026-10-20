export type PreparationMethod = 'warm_resources' | 'initialize' | 'load_document' | 'apply_document_patch_with_damage' | 'apply_interaction_transforms' |
  'compile_gpu_scene_update' | 'clear_gpu_scene_session' | 'compile_gpu_packet' | 'render_linear' | 'render_png' | 'render_color_png' | 'render_region_png' |
  'render_cpu_frame' | 'stats' | 'gpu_memory_breakdown'
export type PreparationReply = { id: number; value?: unknown; settings?: string; error?: string; fatal?: string; documentFork?: boolean; compileStats?:Record<string,unknown> }

type Job = { id: number; lane: string; method: PreparationMethod; args: unknown[];
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
  constructor(private port: MessagePort) {
    port.onmessage = event => {
      const reply = event.data as PreparationReply
      if (reply.fatal) { this.close(new Error(reply.fatal)); return }
      const job = this.active
      if (!job || job.id !== reply.id) return
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
      if (signal) {
        const cancel = () => {
          job.cancelled = true
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
  private dispatch() {
    if (this.active || this.closed) return
    const job = this.queued.shift()
    if (!job) return
    this.active = job
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
