import { assertImportInputBytes } from './import-input-policy'
import { ImportStage, type ImportDiagnostic } from './import-diagnostics'
import { assertDocumentBytes } from './document-capacity'
import { forma_encode_json, forma_decode_json } from './generated/design-kernel/design_kernel'
import { initializeKernelModule } from './kernel/module'
import type { DesktopCloudBridge } from './desktop'
import { importFileInWorker } from './import-file-worker'
import { type DesignDocument, validateDocument } from './model'
import { immutableDocument } from './immutable-document'
import { readWorkspacePatch, type WorkspacePatch } from './workspace-patch'
export { localSave } from './local-store'
import { localOpen } from './local-store'
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
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
/** The desktop requests the independent service through its opt-in host bridge. */
export class Backend {
  constructor(private readonly cloud?: { bridge: DesktopCloudBridge; handle: string }) {}
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.cloud) throw Error('桌面离线模式不连接云端文件服务')
    const { bridge, handle } = this.cloud, signal = options.signal
    signal?.throwIfAborted()
    const callId = crypto.randomUUID()
    const cancel = () => { void bridge.cancel({ handle, callId }).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const result = await bridge.request({ handle, callId, method: options.method ?? 'GET',
        target: path, body: typeof options.body === 'string' ? options.body : undefined })
      signal?.throwIfAborted()
      if (result.status !== 'ok') throw Error(result.status === 'cancelled' ? '云端请求已取消' : result.message)
      if (result.httpStatus < 200 || result.httpStatus >= 300) {
        const error = result.data as { error?: string } | undefined
        throw new BackendError(result.httpStatus, error?.error || '云端请求失败')
      }
      return result.data as T
    } finally { signal?.removeEventListener('abort', cancel) }
  }
  list(signal?: AbortSignal): Promise<Omit<RemoteDocument, 'document'>[]> {
    return this.request('/documents', { signal })
  }
  async changes(id: string, revision: number, signal: AbortSignal): Promise<RemoteChange> {
    const next = await this.request<RemoteChange>(`/documents/${encodeURIComponent(id)}/changes?after=${revision}`, { signal })
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
    return checkedRemoteDocument(await this.request(`/documents/${encodeURIComponent(id)}`, { signal }), id)
  }
  async getVersion(id: string, revision: number, signal: AbortSignal): Promise<RemoteDocument> {
    const result = checkedRemoteDocument(await this.request(`/documents/${encodeURIComponent(id)}/versions/${revision}`, { signal }), id)
    if (result.revision !== revision) throw Error('服务器历史版本响应无效')
    return result
  }
  async save(doc: DesignDocument, revision: number, options: { signal?: AbortSignal; requestId?: string } = {}): Promise<RemoteDocument> {
    if (!immutableDocument(doc)) doc = structuredClone(doc)
    validateDocument(doc)
    const result = checkedRemoteDocument(await this.request(`/documents/${encodeURIComponent(doc.id)}`, {
      method: 'PUT', body: JSON.stringify({ document: doc, revision, requestId: options.requestId ?? crypto.randomUUID() }),
      signal: options.signal,
    }), doc.id)
    if (result.revision !== revision + 1) throw Error('服务器保存回执无效')
    return result
  }
}

function checkedRemoteDocument(value: unknown, id: string): RemoteDocument {
  const result = value as RemoteDocument | undefined
  if (!result || result.id !== id || result.document?.id !== id ||
      !Number.isSafeInteger(result.revision) || result.revision < 1)
    throw Error('服务器文档响应无效')
  return result
}
