import type { PluginWorkerReply, PluginWorkerRequest } from './protocol'

export function openPluginWorker() {
  return new Worker(new URL('./plugin.worker.ts', import.meta.url), { type: 'module' })
}

export class PluginClient {
  private worker: Worker | null = null
  private pending: ((reply: PluginWorkerReply) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly timeoutMs = 15_000) {}

  start(request: Extract<PluginWorkerRequest, { type: 'start' }>) { return this.send(request) }
  ui(pluginMessage: unknown) { return this.send({ type: 'ui', pluginMessage }) }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.worker?.terminate()
    this.worker = null
  }

  private send(message: PluginWorkerRequest): Promise<PluginWorkerReply> {
    if (typeof Worker === 'undefined') return Promise.resolve({ ok: false, message: 'Plugin worker is unavailable in this environment' })
    if (!this.worker) {
      this.worker = openPluginWorker()
      this.worker.onmessage = (event: MessageEvent<PluginWorkerReply>) => {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        const done = this.pending
        this.pending = null
        done?.(event.data)
      }
      this.worker.onerror = () => {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        const done = this.pending
        this.pending = null
        done?.({ ok: false, message: 'Plugin worker failed to start' })
        this.worker?.terminate()
        this.worker = null
      }
    }
    if (this.pending) return Promise.resolve({ ok: false, message: 'Plugin is still running the previous turn' })
    return new Promise(resolve => {
      this.pending = resolve
      this.timer = setTimeout(() => {
        this.pending = null
        this.stop()
        resolve({ ok: false, message: 'Plugin timed out after 15 seconds' })
      }, this.timeoutMs)
      this.worker?.postMessage(message)
    })
  }
}
