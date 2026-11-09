/** Short Chinese for raw engine memory strings. Other messages stay unchanged. */
export function canvasStatusLabel(message: string): string {
  if (/memory allowance|working-memory|wasm memory|out of memory|DOCUMENT_TOO_LARGE|DOCUMENT_RESOURCE_LIMIT/i.test(message))
    return '内存不足，当前画面已保留'
  return message
}
