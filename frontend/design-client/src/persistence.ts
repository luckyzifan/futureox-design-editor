import { forma_encode_json, forma_decode_json } from './generated/design-kernel/design_kernel'
import { initializeKernelModule } from './kernel/module'
import { desktopBridge } from './desktop'
import { importFileInWorker } from './import-file-worker'
import { type DesignDocument, validateDocument } from './model'
export { localSave } from './local-store'
import { localOpen, localTransaction, localRequest } from './local-store'
export async function localRead(): Promise<DesignDocument | null> {
  return (await localOpen())?.document || null
}
export const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
export function exportDocument(doc: DesignDocument) {
  download(`${doc.name}.fd`, new Blob([new Uint8Array(forma_encode_json(JSON.stringify(doc))).buffer], { type: 'application/vnd.futureox-desgin' }))
}
export async function readDocument(file: File) {
  return (await readDesignFile(file)).document
}
export async function readDesignFile(file:File, signal?:AbortSignal):Promise<import('./import-svg').ImportedDesign> {
  signal?.throwIfAborted()
  if (file.size > 32 * 1024 * 1024) throw new Error('文件超过 32 MB')
  if (/\.(fig|sketch|pdf)$/i.test(file.name)) {
    const bytes = await file.arrayBuffer()
    signal?.throwIfAborted()
    const format = /\.sketch$/i.test(file.name) ? 'sketch' : /\.pdf$/i.test(file.name) ? 'pdf' : 'fig'
    return importFileInWorker(bytes, file.name.replace(/\.(fig|sketch|pdf)$/i, ''), format, signal)
  }
  if (!/\.(fd|json|svg)$/i.test(file.name)) throw new Error('请选择 .fd、Sketch、JSON、SVG、FIG 或 PDF 文件')
  if(/\.svg$/i.test(file.name)) {
    const {importSvg}=await import('./import-svg')
    const result=importSvg(await file.text(),file.name.replace(/\.svg$/i,''));validateDocument(result.document);return result
  }
  const bytes=new Uint8Array(await file.arrayBuffer())
  const binary=bytes[0]===70 && bytes[1]===88 && bytes[2]===68 && bytes[3]===75
  return {document:validateDocument(JSON.parse(binary ? forma_decode_json(bytes) : new TextDecoder('utf-8',{fatal:true}).decode(bytes))),warnings:[]}
}
export { imageData } from './image-import'
export type RemoteDocument = {
  id: string
  name: string
  revision: number
  document: DesignDocument
  updatedAt: string
}
type PendingSave = { document: DesignDocument; revision: number; requestId: string }
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export class Backend {
  token = ''
  private async scope(id: string, token: string) {
    if (!token) throw new Error('请输入工作空间访问令牌')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return `${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')}:${id}`
  }
  async request(path: string, options: RequestInit = {}) {
    if (desktopBridge()) throw new Error('桌面离线模式不连接云端文件服务')
    const response = await fetch(`/api/design${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      throw new BackendError(
        response.status,
        response.status === 409
          ? '服务器版本已变化，请先打开最新版本或保存为副本'
          : error.error || '请求失败',
      )
    }
    return response.status === 204 ? null : response.json()
  }
  list(): Promise<Omit<RemoteDocument, 'document'>[]> {
    return this.request('/documents')
  }
  async get(id: string): Promise<RemoteDocument> {
    const token = this.token,
      key = await this.scope(id, token)
    const result: RemoteDocument = await this.request(`/documents/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await localTransaction(['remote'], 'readwrite', async (tx) => {
      tx.objectStore('remote').put({ revision: result.revision }, key)
    })
    return result
  }
  async save(doc: DesignDocument, revision: number): Promise<RemoteDocument> {
    validateDocument(doc)
    const token = this.token,
      key = await this.scope(doc.id, token)
    const pending = await localTransaction(['outbox', 'remote'], 'readwrite', async (tx) => {
      const store = tx.objectStore('outbox')
      const existing = (await localRequest(store.get(key))) as PendingSave | undefined
      if (existing) return existing
      const confirmed = (await localRequest(tx.objectStore('remote').get(key))) as
        | { revision: number }
        | undefined
      const next = {
        document: doc,
        revision: revision || confirmed?.revision || 0,
        requestId: crypto.randomUUID(),
      }
      store.put(next, key)
      return next
    })
    // Persist before sending. A timeout leaves this immutable request intact;
    // the next explicit save recovers its receipt using the same operation ID.
    let result: RemoteDocument
    try {
      result = await this.request(`/documents/${doc.id}`, {
        method: 'PUT',
        body: JSON.stringify(pending),
        headers: { authorization: `Bearer ${token}` },
      })
    } catch (error) {
      if (error instanceof BackendError && [409, 422].includes(error.status)) {
        // A definitive rejection is not an unknown commit. Allow a corrected
        // explicit request; the authored document remains in local storage.
        await localTransaction(['outbox'], 'readwrite', async (tx) => {
          const store = tx.objectStore('outbox'),
            current = (await localRequest(store.get(key))) as PendingSave | undefined
          if (current?.requestId === pending.requestId) store.delete(key)
        })
      }
      throw error
    }
    await localTransaction(['outbox', 'remote'], 'readwrite', async (tx) => {
      const outbox = tx.objectStore('outbox')
      const current = (await localRequest(outbox.get(key))) as PendingSave | undefined
      if (current?.requestId === pending.requestId) outbox.delete(key)
      const known = (await localRequest(tx.objectStore('remote').get(key))) as
        | { revision: number }
        | undefined
      tx.objectStore('remote').put(
        { revision: Math.max(known?.revision || 0, result.revision) },
        key,
      )
    })
    return result
  }
}
