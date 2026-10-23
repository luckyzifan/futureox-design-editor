import { importInputStatus } from './import-input-policy'
import { createRenderDiagnostics, PREFIX } from '../../design-desktop/src/render-terminal-diagnostics.mjs'
/** Import request stages, separate from render/load phases. No file names, paths,
 * exception text, stacks, authored bytes or image data enter diagnostics. */
export const ImportStage = { admission: 230, read: 231, worker: 232, decode: 233, validate: 234, copy: 235, commit: 236, open: 237, initialize: 238 } as const
export const ImportFailure = { unknown: 0, cancelled: 1, unsupportedFormat: 2, size: 3, read: 4, syntax: 5, validation: 6, worker: 7, timeout: 8, decode: 9 } as const
export function importFailureCode(error: unknown, stage: number): number {
  // Read own data properties only: do not invoke user-controlled getters.
  const own = (key: string) => { try { return error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined } catch { return undefined } }
  let name = own('name')
  const message = own('message')
  try { if (typeof DOMException !== 'undefined' && error instanceof DOMException) name = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(error) } catch { /* Unknown exception stays unknown. */ }
  if (name === 'StaleImageImport' || name === 'AbortError' || message === '导入请求已过期，文件或编辑会话已切换；请重新导入') return ImportFailure.cancelled
  if (message === '请选择 .fd、Sketch、JSON、SVG、FIG 或 PDF 文件') return ImportFailure.unsupportedFormat
  if (importInputStatus(error)) return ImportFailure.size
  if (message === '文件超过 32 MB' || message === 'SVG 文件超过 48 MiB' || typeof message === 'string' && message.startsWith('DOCUMENT_RESOURCE_LIMIT: ')) return ImportFailure.size
  if (typeof message === 'string' && /^(FIG|SKETCH|PDF) 处理超过 30 秒预算；请拆分文件$/.test(message)) return ImportFailure.timeout
  if (stage === ImportStage.read) return ImportFailure.read
  if (error instanceof SyntaxError) return ImportFailure.syntax
  if (stage === ImportStage.validate) return ImportFailure.validation
  // Unknown codec/worker/initialization failures stay unknown; stage is separate.
  return ImportFailure.unknown
}
export type ImportDiagnostic = ReturnType<typeof beginImportDiagnostic>
let serial = 0
let collector: ReturnType<typeof createRenderDiagnostics> | undefined
export function beginImportDiagnostic(file: Pick<File, 'name' | 'size'>, mode: 'open' | 'append', action: { actionId: number; actionOwner: number }) {
  const requestId = ++serial
  const match = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase()
  const format = ['fd','json','svg','svgz','fig','sketch','pdf','png','jpg','jpeg','webp'].indexOf(match || '') + 1
  const host = typeof window === 'undefined' ? undefined : (window as unknown as { coreDesktop?: {renderDiagnostics?: boolean; renderDiagnosticsDetail?: boolean} }).coreDesktop
  const enabled = host?.renderDiagnostics === true
  if (enabled) collector ||= createRenderDiagnostics({ enabled: true, detail: host?.renderDiagnosticsDetail === true, session: Math.floor(Math.random()*1e11), source:'main', sink: row => console.log(PREFIX+JSON.stringify(row)), batchSink: batch => console.log(PREFIX+JSON.stringify({batch})) })
  const fields = { requestId, ...action, importFormat: format, importBytes: file.size, importMode: mode === 'append' ? 2 : 1 }
  let current: number = ImportStage.admission, failure: number | undefined
  let isCancelled = () => false
  const emit = (phase: number, stage: number, durationMs = 0, reasonCode = 0, count = 0) => {
    if (!enabled) return
    try { collector?.record('load-stage', { ...fields, methodCode: stage, phase, durationMs, reasonCode, count }) } catch { /* diagnostics never reject an import */ }
  }
  const fail = (error: unknown, cancelled = false) => {
    if (failure === undefined) {
      const original = importFailureCode(error, current)
      failure = cancelled || isCancelled() ? ImportFailure.cancelled : original
      emit(3, current, 0, failure)
      // A rejected asynchronous read after cancellation is still observable, but
      // belongs to this retired request, not a current import failure.
      if (failure === ImportFailure.cancelled && original !== ImportFailure.cancelled) emit(4, current, 0, original, 1)
    }
    return failure
  }
  return {
    stage(stage: number) { if ((Object.values(ImportStage) as number[]).includes(stage)) { current=stage; emit(1,stage) } },
    bindRequest(request: { signal: AbortSignal; isCurrent(): boolean }) { isCancelled = () => request.signal.aborted || !request.isCurrent() },
    bindCancellation(check: () => boolean) { isCancelled = check },
    result(status: number, count: number) { if (failure === undefined) emit(2, current, 0, status, count) },
    fail,
    run<T>(stage: number, work: () => T): T { current=stage; const at=performance.now();emit(1,stage);try { const result=work();emit(2,stage,performance.now()-at);return result } catch(error) { fail(error);throw error } },
    async wait<T>(stage: number, work: () => Promise<T>): Promise<T> { current=stage;const at=performance.now();emit(1,stage);try { const result=await work();emit(2,stage,performance.now()-at);return result } catch(error) { fail(error);throw error } },
  }
}
