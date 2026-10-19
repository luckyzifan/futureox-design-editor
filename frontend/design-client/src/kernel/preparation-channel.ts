export type PreparationMethod = 'warm_resources' | 'initialize' | 'load_document' | 'apply_document_patch_with_damage' | 'apply_interaction_transforms' |
  'compile_gpu_scene_update' | 'clear_gpu_scene_session' | 'compile_gpu_packet' | 'render_linear' | 'render_png' | 'render_color_png' | 'render_region_png' |
  'render_cpu_frame' | 'stats' | 'gpu_memory_breakdown'
export type PreparationReply = { id: number; value?: unknown; settings?: string; error?: string; fatal?: string; documentFork?: boolean; compileStats?:Record<string,unknown> }

/** CPU preparation has its own event loop. No device, canvas or GPU handle
 * crosses this port; binary kernel packets use transferable ArrayBuffers. */
export class PreparationChannel {
  private sequence = 0
  private closed?: Error
  private pending = new Map<number, { resolve: (reply: PreparationReply) => void; reject: (error: Error) => void }>()
  constructor(private port: MessagePort) {
    port.onmessage = event => {
      const reply = event.data as PreparationReply
      if (reply.fatal) { this.close(new Error(reply.fatal)); return }
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply)
    }
    port.onmessageerror = () => this.close(new Error('CPU preparation response could not be decoded'))
    port.start()
  }
  request(lane: string, method: PreparationMethod, args: unknown[] = []): Promise<PreparationReply> {
    if (this.closed) return Promise.reject(this.closed)
    if (this.pending.size >= 128) return Promise.reject(new Error('CPU preparation request budget exceeded'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.port.postMessage({ id, lane, method, args }) }
      catch (error) { this.pending.delete(id); reject(error as Error) }
    })
  }
  close(error = new Error('CPU preparation closed')) {
    this.closed = error
    this.port.close()
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}
