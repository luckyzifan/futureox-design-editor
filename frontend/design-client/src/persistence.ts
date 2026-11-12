import { assertImportInputBytes } from './import-input-policy'
import { ImportStage, type ImportDiagnostic } from './import-diagnostics'
import { assertDocumentBytes } from './document-capacity'
import { forma_encode_json, forma_decode_json } from './generated/design-kernel/design_kernel'
import { initializeKernelModule } from './kernel/module'
import { desktopBridge } from './desktop'
import { importFileInWorker } from './import-file-worker'
import { type DesignDocument, validateDocument } from './model'
import { immutableDocument } from './immutable-document'
import { readWorkspacePatch, type WorkspacePatch } from './workspace-patch'
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
export async function readDesignFile(file:File, signal?:AbortSignal, diagnostic?:ImportDiagnostic):Promise<import('./import-svg').ImportedDesign> {
  diagnostic?.stage(ImportStage.admission)
  signal?.throwIfAborted()
  assertImportInputBytes(file.size)
  const nativeFile = /\.(fd|json)$/i.test(file.name)
  if (nativeFile) assertDocumentBytes(file.size)
  if (/\.(fig|sketch|pdf)$/i.test(file.name)) {
    const format = /\.sketch$/i.test(file.name) ? 'sketch' : /\.pdf$/i.test(file.name) ? 'pdf' : 'fig'
    return importFileInWorker(file, file.name.replace(/\.(fig|sketch|pdf)$/i, ''), format, signal, diagnostic)
  }
  if (!/\.(fd|json|svg|svgz)$/i.test(file.name)) throw new Error('请选择 .fd、Sketch、JSON、SVG、FIG 或 PDF 文件')
  if(/\.svgz?$/i.test(file.name)) {
    diagnostic?.stage(ImportStage.decode)
    const {importSvg}=await import('./import-svg')
    const { decodeSvgFileBytes } = await import('./export-options')
    const bytes = new Uint8Array(await (diagnostic ? diagnostic.wait(ImportStage.read, () => file.arrayBuffer()) : file.arrayBuffer())); signal?.throwIfAborted()
    const compressed=/\.svgz$/i.test(file.name)
    const expanded=compressed && bytes.length>=18 ? new DataView(bytes.buffer,bytes.byteOffset+bytes.length-4,4).getUint32(0,true) : bytes.length
    if (expanded>8*1024*1024 || bytes.length>8*1024*1024) {
      if (!['','image/svg+xml','application/gzip','application/x-gzip'].includes(file.type)) throw new Error('大型 SVG 文件 MIME 类型无效')
      const {importSvgArtifact}=await import('./import-svg-artifact'); signal?.throwIfAborted()
      return importSvgArtifact(bytes,compressed?'svgz':'svg',signal,file.name.replace(/\.svgz?$/i,''))
    }
    diagnostic?.stage(ImportStage.decode)
    const result=importSvg(decodeSvgFileBytes(bytes, compressed),file.name.replace(/\.svgz?$/i,''));validateDocument(result.document);return result
  }
  const bytes=new Uint8Array(await (diagnostic ? diagnostic.wait(ImportStage.read, () => file.arrayBuffer()) : file.arrayBuffer()))
  diagnostic?.stage(ImportStage.decode)
  const binary=bytes[0]===70 && bytes[1]===88 && bytes[2]===68 && bytes[3]===75
  const decoded = JSON.parse(binary ? forma_decode_json(bytes) : new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  diagnostic?.stage(ImportStage.validate)
  return {document:validateDocument(decoded),warnings:[]}
}
export { imageData } from './image-import'
export type RemoteDocument = {
  id: string
  name: string
  revision: number
  document: DesignDocument
  updatedAt: string
}
export type RemoteChange = { revision: number; patch: WorkspacePatch | null }
export type RemoteEditReceipt = { revision: number; merged?: RemoteDocument }
type PendingSave = { document: DesignDocument; revision: number; requestId: string; owner?: string }
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
  private readonly outboxOwner = crypto.randomUUID()
  private async scope(id: string, token: string) {
    if (!token) throw new Error('请输入工作空间访问令牌')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return `${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')}:${id}`
  }
  async request(path: string, options: RequestInit = {}) {
    if (desktopBridge()) throw new Error('桌面离线模式不连接云端文件服务')
    const response = await fetch(`/api/design${path}`, {
      cache: 'no-store',
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        ...options.headers,
      },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
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
  list(signal?: AbortSignal): Promise<Omit<RemoteDocument, 'document'>[]> {
    return this.request('/documents', { signal })
  }
  async changes(id: string, revision: number, signal: AbortSignal): Promise<RemoteChange> {
    const next = await this.request(`/documents/${encodeURIComponent(id)}/changes?after=${revision}`, { signal })
    if (!next || !Number.isSafeInteger(next.revision) || next.revision < revision ||
        next.patch !== null && next.revision !== revision + 1)
      throw Error('服务器版本更新无效')
    return { revision: next.revision, patch: next.patch === null ? null : readWorkspacePatch(next.patch) }
  }
  async edit(id: string, revision: number, requestId: string, patch: WorkspacePatch,
    signal: AbortSignal): Promise<RemoteEditReceipt> {
    const receipt: RemoteEditReceipt = await this.request(`/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ revision, requestId, patch }), signal,
    })
    if (!receipt || !Number.isSafeInteger(receipt.revision) || receipt.revision <= revision ||
        (receipt.revision === revision + 1 ? !!receipt.merged :
          receipt.merged?.id !== id || receipt.merged?.document?.id !== id || receipt.merged?.revision !== receipt.revision))
      throw Error('服务器编辑回执无效')
    return receipt
  }
  async get(id: string, signal?: AbortSignal): Promise<RemoteDocument> {
    const token = this.token,
      key = await this.scope(id, token)
    const result: RemoteDocument = await this.request(`/documents/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    })
    if (result.id !== id || result.document?.id !== id || !Number.isSafeInteger(result.revision) || result.revision < 1)
      throw new Error('服务器文档响应无效')
    await localTransaction(['remote'], 'readwrite', async (tx) => {
      tx.objectStore('remote').put({ revision: result.revision }, key)
    })
    return result
  }
  async save(doc: DesignDocument, revision: number, options: { signal?: AbortSignal; exactRevision?: boolean } = {}): Promise<RemoteDocument> {
    if (!immutableDocument(doc)) doc = structuredClone(doc)
    validateDocument(doc)
    const { signal, exactRevision } = options
    const token = this.token,
      key = await this.scope(doc.id, token)
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      const pending = await localTransaction(exactRevision ? ['outbox'] : ['outbox', 'remote'], 'readwrite', async (tx) => {
        const store = tx.objectStore('outbox')
        const existing = (await localRequest(store.get(key))) as PendingSave | undefined
        if (existing) return existing
        const confirmed = exactRevision || revision ? undefined :
          await localRequest(tx.objectStore('remote').get(key)) as { revision: number } | undefined
        const next = { document: doc, revision: confirmed?.revision ?? revision, requestId: crypto.randomUUID(), owner: this.outboxOwner }
        store.put(next, key)
        return next
      })
      const result = await this.sendPending(doc.id, key, token, pending, signal)
      if (!exactRevision) return result
      const sameRevision = revision === pending.revision || revision === result.revision
      const sameDocument = pending.document === doc || JSON.stringify(pending.document) === JSON.stringify(doc)
      if (sameRevision && sameDocument) return result
      // A retry may acknowledge this editor's earlier snapshot first. A
      // different tab's receipt cannot advance this editor's CAS base.
      if (revision !== result.revision && !(revision === pending.revision && pending.owner === this.outboxOwner)) break
      revision = result.revision
    }
    throw new BackendError(409, '服务器版本已变化，请先打开最新版本或保存为副本')
  }
  private async sendPending(id: string, key: string, token: string, pending: PendingSave, signal?: AbortSignal): Promise<RemoteDocument> {
    // Persist before sending. A timeout leaves this immutable request intact;
    // the next explicit save recovers its receipt using the same operation ID.
    let result: RemoteDocument
    try {
      result = await this.request(`/documents/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ document: pending.document, revision: pending.revision, requestId: pending.requestId }),
        headers: { authorization: `Bearer ${token}` },
        signal,
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
    if (result.id !== id || result.document?.id !== id || result.revision !== pending.revision + 1)
      throw new Error('服务器保存回执无效')
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
