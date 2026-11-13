const LEAD = /^(?:操作失败，当前画布已保留：|保存失败，当前画布已保留：|自动保存失败，当前修改已保留：)\s*/
const ERR = /^(?:Uncaught\s+)?(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|DOMException):\s+/
const USEFUL_ENGLISH = /large document|source scene|working set|hash mismatch|operation is busy|design content|opening view|stale or foreign|native file|utf-8/i
/** Fixed span admit. Checked before the read buffer exists, so it is not an allocator failure.
 * "conversion entry" and thumbnail dependency overflow are the same 64 MiB admit. */
const WINDOW = /conversion window|conversion entry exceeds|thumbnail dependencies exceed window/i
/** Session or working-set allowance. Quitting other apps does not raise it. */
const CAPACITY = /DOCUMENT_(RESOURCE_LIMIT|TOO_LARGE)|\bTOO_LARGE\b|working[\s-]set|working[\s-]memory|memory allowance|safely admit/i
/** A failed allocation attempt, after policy checks have been ruled out. */
const ALLOCATION = /out of memory|memory allocation(?: of \d+ bytes)? failed|failed to allocate|allocation failed|cannot allocate|unable to allocate|allocerror/i
const CORRUPT = /corrupt|malformed|truncated|checksum|invalid utf-8|not valid utf-8/i
const UNSUPPORTED = /unsupported|no supported editable mapping|has no supported/i

export type SourceErrorKind = 'window' | 'capacity' | 'allocation' | 'corrupt' | 'unsupported' | 'other'

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

export function sourceErrorKind(error: string): SourceErrorKind {
  const unwrapped = unwrapSourceError(error)
  if (WINDOW.test(unwrapped)) return 'window'
  const memory = /(\d+)-byte working-memory budget/.exec(unwrapped)
  if (memory && Number(memory[1]) < 64 * 1024 ** 2) return 'capacity'
  if (CAPACITY.test(unwrapped)) return 'capacity'
  if (ALLOCATION.test(unwrapped)) return 'allocation'
  if (CORRUPT.test(unwrapped)) return 'corrupt'
  if (UNSUPPORTED.test(unwrapped)) return 'unsupported'
  return 'other'
}

export function sourceErrorSummary(error: string): string {
  const unwrapped = unwrapSourceError(error)
  // Window before every memory phrase: "conversion window/entry exceeds its memory allowance"
  // is the fixed admit limit, checked before a read buffer exists.
  if (WINDOW.test(unwrapped))
    return '所选内容超过固定转换窗口。请点击「选择较小页面、素材或子树」，在左侧列表改选较小的页面、素材或子树后再试。这个上限在分配读取缓冲之前已经固定，无需退出其他应用。'
  const memory = /(\d+)-byte working-memory budget/.exec(unwrapped)
  if (memory && Number(memory[1]) < 64 * 1024 ** 2)
    return `当前启动内存预算仅为 ${(Number(memory[1]) / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB，无法载入这些内容。请检查启动配置并重新打开应用。`
  if (CAPACITY.test(unwrapped))
    return '本次内容超过当前会话的固定容量上限。请改为较小的页面或对象，或检查启动内存预算。无需退出其他应用。'
  if (ALLOCATION.test(unwrapped))
    return '本次处理未能分配所需内存。当前内容已保留，可释放其他应用的内存后重试。'
  if (/cancel|abort|取消/i.test(unwrapped)) return '操作已取消，可以重新选择页面继续。'
  if (/[\u4e00-\u9fff]/.test(unwrapped)) return unwrapped
  if (CORRUPT.test(unwrapped))
    return '源内容已损坏或不完整。当前内容已保留，可展开技术详情查看原因。'
  if (UNSUPPORTED.test(unwrapped))
    return '这份内容包含当前不支持的语义。当前内容已保留，可展开技术详情查看原因。'
  if (unwrapped !== error.trim() && unwrapped) return unwrapped
  if (USEFUL_ENGLISH.test(unwrapped)) return unwrapped
  return '此操作未能完成。当前内容已保留，可展开技术详情查看原因。'
}

/** Move focus to the page, asset, or subtree control that can narrow the next read. */
export function focusSmallerSourceEntry(root: Document = document): boolean {
  const select = root.querySelector<HTMLSelectElement>('select[data-source-page-picker], select[aria-label="素材页面"], select[aria-label="Asset pages"]')
  if (select && !select.disabled) {
    select.focus()
    return root.activeElement === select
  }
  const entry = root.querySelector<HTMLButtonElement>(
    '[data-source-material-list] button.source-page-entry:not([disabled]), [aria-label="全部素材"] button.source-page-entry:not([disabled]), [aria-label="源页面列表"] button.source-page-entry:not([disabled]), [aria-label="源画板列表"] button.source-page-entry:not([disabled]), [aria-label="All assets"] button.source-page-entry:not([disabled])',
  )
  if (!entry) return false
  entry.focus()
  return root.activeElement === entry
}
