import { sourceErrorKind, sourceErrorSummary } from './source-error-text'

/** Short Chinese for raw engine memory strings. A fixed conversion window is not an allocator failure. */
export function canvasStatusLabel(message: string): string {
  if (sourceErrorKind(message) === 'window') return sourceErrorSummary(message)
  if (/memory allowance|working-memory|wasm memory|out of memory|DOCUMENT_TOO_LARGE|DOCUMENT_RESOURCE_LIMIT/i.test(message))
    return '内存不足，当前画面已保留'
  return message
}
