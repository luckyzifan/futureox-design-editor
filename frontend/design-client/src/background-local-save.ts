import { documentCapacity } from './document-capacity'
import { LocalConflictError, localSave, type LocalRecord } from './local-store'
import type { DesignDocument } from './model'

export type LocalSaveRequest = { document: DesignDocument; revision: number; memoryBytes: number }
export type LocalSaveReply = Omit<LocalRecord, 'document'> & { documentId: string }
  | { error: string; conflict: boolean }

/** Browser storage has its own worker so encoding and IndexedDB commit do not
 * take a turn on the canvas thread. SaveCoordinator serializes its requests. */
export class BackgroundLocalSave {
  private worker?: Worker
  private failPending?: (error: Error) => void

  save = (document: DesignDocument, revision = 0): Promise<LocalRecord> => {
    if (typeof Worker === 'undefined') return localSave(document, revision)
    if (this.failPending) return Promise.reject(new Error('本地保存正在进行'))
    return new Promise((resolve, reject) => {
      const worker = this.worker ??= new Worker(new URL('./local-save-worker.ts', import.meta.url), { type: 'module' })
      const finish = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        this.failPending = undefined
      }
      const fail = (error: Error) => {
        finish()
        worker.terminate()
        this.worker = undefined
        reject(error)
      }
      this.failPending = fail
      worker.onerror = event => { event.preventDefault(); fail(new Error('本地保存线程失败')) }
      worker.onmessageerror = () => fail(new Error('无法读取本地保存回执'))
      worker.onmessage = ({ data }: MessageEvent<LocalSaveReply>) => {
        if (data && 'error' in data) {
          finish()
          reject(data.conflict ? new LocalConflictError() : new Error(data.error))
          return
        }
        if (!data || data.documentId !== document.id || data.revision !== revision + 1 || !Number.isFinite(data.updatedAt)) {
          fail(new Error('本地保存回执无效'))
          return
        }
        finish()
        resolve({ document, revision: data.revision, updatedAt: data.updatedAt })
      }
      try {
        worker.postMessage({ document, revision, memoryBytes: documentCapacity().memoryBytes } satisfies LocalSaveRequest)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose() {
    if (this.failPending) this.failPending(new Error('本地保存已取消'))
    else { this.worker?.terminate(); this.worker = undefined }
  }
}
