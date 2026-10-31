import { allParents } from './geometry'
import { layerTreeRows } from './layer-tree'
import type { DesignDocument } from './model'

export type BatchRenameOptions = {
  prefix?: string
  suffix?: string
  find?: string
  replace?: string
  numbering?: { start: number; step: number; padding: number; position: 'prefix' | 'suffix'; separator: string }
}
export type BatchRenameEntry = Readonly<{ id: string; from: string; to: string }>
export type BatchRenamePlan = Readonly<{ pageId: string; entries: readonly BatchRenameEntry[] }>
const validUnicode = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
function text(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 200 || !validUnicode(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label}无效，最多 200 个字符且不能含控制字符`)
  return value
}
function name(value: unknown) {
  const result = text(value, '图层名称')
  if (!result.trim()) throw new Error('图层名称不能为空')
  return result
}
function targets(document: DesignDocument, pageId: string, selected: readonly string[]) {
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('请选择不重复的图层')
  const requested = new Set(selected)
  const ordered = layerTreeRows(document, pageId, new Set(), '').map(row => row.id).filter(id => requested.has(id))
  if (ordered.length !== selected.length) throw new Error('所选图层不属于当前页面或已不存在')
  const parents = allParents(document)
  for (const id of ordered) {
    for (let at: string | undefined = id; at && document.nodes[at]; at = parents.get(at)) {
      const n = document.nodes[at]
      if (n.locked) throw new Error('选区包含锁定图层或锁定父级，请先解锁')
      if (n.instanceOrigin || (at !== id && n.instance)) throw new Error('实例内部图层由主组件继承，请先分离实例再批量重命名')
    }
  }
  return ordered
}

/** Stable front-to-back layer-panel order, independent of selection click order.
 * Only explicitly selected names are planned; parent selection never expands. */
export function planBatchRename(document: DesignDocument, pageId: string, selected: readonly string[], options: BatchRenameOptions): BatchRenamePlan {
  const ordered = targets(document, pageId, selected)
  const prefix = text(options.prefix ?? '', '前缀'), suffix = text(options.suffix ?? '', '后缀')
  const find = text(options.find ?? '', '查找文字'), replace = text(options.replace ?? '', '替换文字'), numbering = options.numbering
  if (!find && replace) throw new Error('请填写要替换的查找文字')
  if (numbering && (!Number.isSafeInteger(numbering.start) || numbering.start < 0 || !Number.isSafeInteger(numbering.step) || !numbering.step ||
    !Number.isInteger(numbering.padding) || numbering.padding < 0 || numbering.padding > 12 || !['prefix', 'suffix'].includes(numbering.position))) throw new Error('编号参数无效')
  if (numbering) text(numbering.separator, '编号分隔符')
  const entries = ordered.map((id, index) => {
    const from = document.nodes[id].name
    let to = prefix + (find ? from.split(find).join(replace) : from) + suffix
    if (numbering) {
      const value = numbering.start + index * numbering.step
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('编号超出有效整数范围')
      const serial = String(value).padStart(numbering.padding, '0')
      to = numbering.position === 'prefix' ? serial + numbering.separator + to : to + numbering.separator + serial
    }
    return Object.freeze({ id, from, to: name(to) })
  })
  return Object.freeze({ pageId, entries: Object.freeze(entries) })
}

/** Validate the complete plan before touching a draft. The same plan can be
 * used by Editor commands or an automation transaction without a second model. */
export function applyBatchRename(document: DesignDocument, plan: BatchRenamePlan) {
  const ordered = targets(document, plan.pageId, plan.entries.map(entry => entry.id))
  for (const [index, entry] of plan.entries.entries()) {
    if (ordered[index] !== entry.id || document.nodes[entry.id].name !== entry.from) throw new Error('重命名预览已过期，请重新打开')
    name(entry.to)
  }
  for (const entry of plan.entries) document.nodes[entry.id].name = entry.to
}
