import { assertImportInputBytes } from './import-input-policy'
import { ImportStage, type ImportDiagnostic } from './import-diagnostics'
import { documentCapacity } from './document-capacity'
import { FIG_WARNING_LIMITS, FIG_WARNINGS_TRUNCATED } from './import-warnings'
import type { ImportedDesign } from './import-svg'
import { validateDocument, type DesignDocument } from './model'

export type WorkerImportFormat = 'fig' | 'sketch' | 'pdf'

/** One owned worker per import, reclaimed on completion, failure or cancellation. */
export function importFileInWorker(
  input: ArrayBuffer | File,
  name: string,
  format: WorkerImportFormat,
  signal?: AbortSignal,
  diagnostic?: ImportDiagnostic,
): Promise<ImportedDesign> {
  const isBuffer = 'byteLength' in input
  assertImportInputBytes(isBuffer ? input.byteLength : input.size)
  // A selected File is structured-cloned as a Blob, not eagerly read in the UI.
  // The owned worker's termination also cancels adoption after a pending read.
  // This does not promise zero-copy browser internals or streaming decoding.
  const payload = isBuffer ? { bytes: input, name, format } : { file: input, name, format }
  return runFileWorker(payload, isBuffer ? [input] : [], format.toUpperCase(), (message) => {
    const result = message.result as ImportedDesign
    diagnostic?.stage(ImportStage.validate)
    validateDocument(result.document)
    if (!Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== 'string'))
      throw new Error('文件导入兼容报告无效')
    if (format === 'fig') {
      if (result.warnings.length > FIG_WARNING_LIMITS.count ||
          result.warnings.some(warning => warning.length > FIG_WARNING_LIMITS.messageBytes))
        throw new Error('FIG 兼容报告超限')
      const encoder = new TextEncoder()
      const sizes = result.warnings.map(warning => encoder.encode(warning).length)
      if (sizes.length > FIG_WARNING_LIMITS.count || sizes.some(size => size > FIG_WARNING_LIMITS.messageBytes) ||
          sizes.reduce((sum, size) => sum + size, 0) > FIG_WARNING_LIMITS.totalBytes ||
          (result.droppedOccurrences !== undefined && (!Number.isSafeInteger(result.droppedOccurrences) || result.droppedOccurrences < 1)) ||
          (result.droppedOccurrences !== undefined) !== result.warnings.includes(FIG_WARNINGS_TRUNCATED))
        throw new Error('FIG 兼容报告超限或截断元数据无效')
    }
    return result
  }, signal, diagnostic)
}

/** Compatibility export shares the same WASM codec in both application hosts. */
export function exportSketchInWorker(document: DesignDocument, signal?: AbortSignal): Promise<Uint8Array> {
  return runFileWorker({ format: 'sketch-export', document }, [], 'Sketch 导出', (message) => {
    if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength > 32 * 1024 * 1024)
      throw new Error('Sketch 导出结果无效或超过 32 MB')
    return new Uint8Array(message.bytes)
  }, signal)
}

function runFileWorker<T>(
  payload: unknown,
  transfer: Transferable[],
  label: string,
  decode: (message: Record<string, unknown>) => T,
  signal?: AbortSignal,
  diagnostic?: ImportDiagnostic,
): Promise<T> {
  diagnostic?.stage(ImportStage.worker)
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: unknown, result?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(signal?.reason || new DOMException('文件导入已取消', 'AbortError'))
    const timeout = setTimeout(() => finish(new Error(`${label} 处理超过 30 秒预算；请拆分文件`)), 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    const failWorker = (error: Error) => {
      if (settled) return
      // A pending File read does not prove that a generic worker/transport
      // failure came from file I/O. Keep unknown worker failures unknown.
      diagnostic?.stage(ImportStage.worker)
      finish(error)
    }
    worker.onerror = (event) => failWorker(new Error(event.message || '文件导入进程失败'))
    worker.onmessageerror = () => failWorker(new Error('文件导入响应无法读取'))
    worker.onmessage = (event) => {
      if (settled) return
      try {
        if (event.data?.kind === 'import-stage') {
          if (![ImportStage.read, ImportStage.initialize].includes(event.data.importStage))
            throw new Error('文件导入阶段响应无效')
          diagnostic?.stage(event.data.importStage)
          return
        }
        if (typeof event.data?.error === 'string') {
          if ([ImportStage.read, ImportStage.initialize, ImportStage.decode].includes(event.data.importStage)) diagnostic?.stage(event.data.importStage)
          throw new Error(event.data.error || '文件导入失败')
        }
        finish(undefined, decode(event.data))
      } catch (error) { finish(error) }
    }
    if (signal?.aborted) { abort(); return }
    try { worker.postMessage({ ...(payload as object), memoryBytes: documentCapacity().memoryBytes }, transfer) }
    catch (error) { finish(error) }
  })
}
