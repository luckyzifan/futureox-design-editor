const LEAD = /^(?:操作失败，当前画布已保留：|保存失败，当前画布已保留：|自动保存失败，当前修改已保留：)\s*/
const ERR = /^(?:Uncaught\s+)?(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|DOMException):\s+/
const USEFUL_ENGLISH = /large document|source scene|working set|hash mismatch|operation is busy|design content|opening view|stale or foreign|native file|utf-8/i

/** Drop English `Error:` and the desktop failure prefix so a Chinese reason can surface. */
export function unwrapSourceError(error: string): string {
  let text = error.trim()
  for (let i = 0; i < 6; i++) {
    const next = text.replace(LEAD, '').replace(ERR, '').trim()
    if (!next || next === text) return text
    text = next
  }
  return text
}

export function sourceErrorSummary(error: string): string {
  const unwrapped = unwrapSourceError(error)
  const memory = /(\d+)-byte working-memory budget/.exec(unwrapped)
  if (memory && Number(memory[1]) < 64 * 1024 ** 2)
    return `当前启动内存预算仅为 ${(Number(memory[1]) / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB，无法载入这些内容。请检查启动配置并重新打开应用。`
  if (/DOCUMENT_(RESOURCE_LIMIT|TOO_LARGE)|working.set|conversion window/i.test(unwrapped))
    return '本次处理未能分配所需内存。当前内容已保留，可释放其他应用的内存后重试。'
  if (/cancel|abort|取消/i.test(unwrapped)) return '操作已取消，可以重新选择页面继续。'
  if (/[\u4e00-\u9fff]/.test(unwrapped)) return unwrapped
  if (unwrapped !== error.trim() && unwrapped) return unwrapped
  if (USEFUL_ENGLISH.test(unwrapped)) return unwrapped
  return '此操作未能完成。当前内容已保留，可展开技术详情查看原因。'
}
