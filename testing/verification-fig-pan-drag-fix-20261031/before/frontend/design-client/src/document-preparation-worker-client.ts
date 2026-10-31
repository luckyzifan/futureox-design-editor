import { documentCapacity } from './document-capacity'
import type { DesignDocument } from './model'
import { documentPreparationRuntime, sameDocumentPreparationRuntime, type DocumentPreparationRuntime } from './document-preparation-identity'

export type DocumentPreparationIdentity = Readonly<{
  documentId: string; version: number; generation: number; session: number | null
}>
export type DocumentPreparationRequest = {
  protocol: 1; id: string; identity: DocumentPreparationIdentity; source: string; memoryBytes: number; runtime: DocumentPreparationRuntime
}
export type DocumentPreparationReply = {
  protocol: 1; id: string; identity: DocumentPreparationIdentity; runtime?: DocumentPreparationRuntime
} & ({ document: DesignDocument; validatedJson: string } |
  { error: string; errorName: string; sourceFailure: boolean })
type Job = {
  request: DocumentPreparationRequest; signal: AbortSignal; cleanup(): void
  resolve(value: { document: DesignDocument; validatedJson: string }): void; reject(error: Error): void
}
const sourceFailures = new WeakSet<Error>()
const cancelled = () => new DOMException('文档准备已取消；当前画布已保留', 'AbortError')
export function consumeDocumentPreparationSourceFailure(error: unknown): boolean {
  return error instanceof Error && sourceFailures.delete(error)
}
function identityMatches(a: DocumentPreparationIdentity | undefined, b: DocumentPreparationIdentity) {
  return !!a && a.documentId === b.documentId && a.version === b.version &&
    a.generation === b.generation && a.session === b.session
}

/** A separate lane from canvas preparation. One isolated worker globally, not
 * one per tab. Termination also interrupts synchronous WASM on cancellation.
 * No supplied Worker, port, URL, callback or result can bypass preparation. */
class DocumentPreparationQueue {
  private queued: Job[] = []
  private active?: Job
  private worker?: Worker
  private timer?: ReturnType<typeof setTimeout>
  prepare(source: string, identity: DocumentPreparationIdentity, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(cancelled())
    const runtime = documentPreparationRuntime()
    if (!runtime) return Promise.reject(new Error('文档准备缺少已验证的内核资源身份'))
    const capacity = documentCapacity()
    // A cheap necessary bound only. Exact raw UTF-8 and canonical bounds still
    // execute in the worker, through the unchanged admission implementation.
    if (source.length > capacity.documentBytes) {
      const error = new Error('Invalid document JSON size')
      sourceFailures.add(error)
      return Promise.reject(error)
    }
    const retainedUnits = (this.active?.request.source.length ?? 0) +
      this.queued.reduce((total, job) => total + job.request.source.length, 0)
    if (this.queued.length + Number(!!this.active) >= 8 || retainedUnits + source.length > capacity.documentBytes)
      return Promise.reject(new Error('文档准备队列已满；请稍后重试'))
    return new Promise<{ document: DesignDocument; validatedJson: string }>((resolve, reject) => {
      const job: Job = { request: { protocol: 1, id: crypto.randomUUID(), identity: { ...identity }, source, memoryBytes: capacity.memoryBytes, runtime },
        signal, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) }
      const abort = () => {
        if (this.active === job) this.finish(job, cancelled())
        else {
          const index = this.queued.indexOf(job)
          if (index < 0) return
          this.queued.splice(index, 1); job.cleanup(); reject(cancelled())
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      this.queued.push(job)
      this.dispatch()
    })
  }
  private dispatch() {
    if (this.active) return
    const job = this.queued.shift()
    if (!job) return
    this.active = job
    if (job.signal.aborted) { this.finish(job, cancelled()); return }
    if (!sameDocumentPreparationRuntime(documentPreparationRuntime(), job.request.runtime)) {
      this.finish(job, new Error('文档准备内核资源已改变')); return
    }
    try {
      // Static Vite-owned entry and same-origin build assets; never a document
      // supplied program. A fresh realm isolates fonts, caches and kernel state.
      const worker = this.worker = new Worker(new URL('./document-preparation-worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = event => {
        if (this.active !== job || this.worker !== worker) return
        const reply = event.data as DocumentPreparationReply
        if (!reply || reply.protocol !== 1 || reply.id !== job.request.id ||
            !identityMatches(reply.identity, job.request.identity)) {
          this.finish(job, new Error('文档准备响应身份无效')); return
        }
        if ('error' in reply) {
          const message = typeof reply.error === 'string' ? reply.error : '文档准备失败'
          const error = reply.errorName === 'SyntaxError' ? new SyntaxError(message)
            : reply.errorName === 'RangeError' ? new RangeError(message) : new Error(message)
          if (reply.sourceFailure === true) sourceFailures.add(error)
          this.finish(job, error); return
        }
        if (!sameDocumentPreparationRuntime(reply.runtime, job.request.runtime) ||
            !sameDocumentPreparationRuntime(documentPreparationRuntime(), job.request.runtime)) {
          this.finish(job, new Error('文档准备内核资源身份不匹配')); return
        }
        if (!reply.document || typeof reply.document.id !== 'string' || typeof reply.validatedJson !== 'string') {
          this.finish(job, new Error('文档准备响应无效')); return
        }
        this.finish(job, undefined, reply)
      }
      worker.onerror = event => { event.preventDefault(); this.finish(job, new Error('文档准备线程失败；当前画布已保留')) }
      worker.onmessageerror = () => this.finish(job, new Error('文档准备响应无法读取'))
      // Includes cold WASM/font initialization and queue delivery, not a claimed
      // runtime performance target. No silent main-thread retry after failure.
      this.timer = setTimeout(() => this.finish(job, new Error('文档准备超时；当前画布已保留')), 120_000)
      worker.postMessage(job.request)
    } catch (error) { this.finish(job, error instanceof Error ? error : new Error(String(error))) }
  }
  private finish(job: Job, error?: Error, value?: { document: DesignDocument; validatedJson: string }) {
    if (this.active !== job) return
    clearTimeout(this.timer); this.timer = undefined
    const worker = this.worker; this.worker = undefined; this.active = undefined
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate() }
    job.cleanup()
    if (error) job.reject(error)
    else if (job.signal.aborted) job.reject(cancelled())
    else job.resolve(value!)
    this.dispatch()
  }
}
const queue = new DocumentPreparationQueue()
/** Returns only controlled worker output. The private main-realm ownership mint
 * lives in prepared-document.ts and accepts no caller-supplied prepared object. */
export function requestDocumentPreparation(source: string, identity: DocumentPreparationIdentity, signal: AbortSignal) {
  return queue.prepare(source, identity, signal)
}
