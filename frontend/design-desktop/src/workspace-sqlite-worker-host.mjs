import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'

// Below this, JSON work is cheaper than a thread hop and stays on the caller.
export const SQLITE_OFFTHREAD_BYTES = 32 * 1024

class WorkspaceSqliteWorker {
  constructor() {
    this.worker = new Worker(new URL('./workspace-sqlite-worker.mjs', import.meta.url))
    this.pending = new Map()
    this.closed = false
    this.worker.on('message', (message) => {
      const pending = this.pending.get(message?.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message)
    })
    this.worker.on('error', (error) => this.fail(error))
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  call(op, fields, transfer) {
    if (this.closed) return Promise.reject(new Error('SQLite worker closed'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error('SQLite payload worker timed out'), { code: 'BACKEND_TIMEOUT' }))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ id, op, ...fields }, transfer) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  encodeRequest(requestId, method, params) {
    return this.call('encode-request', { requestId, method, params })
  }

  decodeResponse(frame) {
    const copy = Buffer.from(frame)
    return this.call('decode-response', { frame: copy }, [copy.buffer])
  }

  close() {
    this.fail(new Error('SQLite worker closed'))
    return this.worker.terminate()
  }
}

// The thread starts on the first large SQLite payload, not at process import.
export function createWorkspaceSqliteCodec() {
  let worker
  const current = () => (worker ??= new WorkspaceSqliteWorker())
  return {
    encodeRequest: (requestId, method, params) => current().encodeRequest(requestId, method, params),
    decodeResponse: (frame) => current().decodeResponse(frame),
    close: () => {
      const running = worker
      worker = undefined
      return running ? running.close() : Promise.resolve()
    },
  }
}
