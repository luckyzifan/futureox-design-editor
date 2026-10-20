import { allParents, type ParentMap } from './geometry'
import type { DesignDocument } from './model'

/** Tree selection can include hidden or locked layers. Feedback describes
 * those targets without changing visibility or granting editing capability. */
export function canvasLayerFeedback(document: DesignDocument, page: string, selection: readonly string[], parents: ParentMap = allParents(document)) {
  const visible = new Set<string>(), locked = new Set<string>()
  let hidden = 0, unavailable = 0
  for (const id of new Set(selection)) {
    const path: string[] = [], seen = new Set<string>()
    let at: string | undefined = id
    while (at && at !== page && document.nodes[at] && !seen.has(at)) {
      seen.add(at); path.push(at); at = parents.get(at)
    }
    if (at !== page || !path.length) { unavailable++; continue }
    if (path.some(value => !document.nodes[value].visible)) { hidden++; continue }
    visible.add(id)
    if (path.some(value => document.nodes[value].locked)) locked.add(id)
  }
  // A selected ancestor already supplies the complete feedback bounds.
  const ids = [...visible].filter(id => {
    for (let at = parents.get(id); at && document.nodes[at]; at = parents.get(at))
      if (visible.has(at)) return false
    return true
  })
  const message = hidden
    ? visible.size ? '部分所选图层已隐藏，仅显示可见图层' : '所选图层已隐藏，画布不显示'
    : unavailable ? '所选图层不在当前页面或已不存在'
      : locked.size ? '图层已锁定，仅显示选框' : null
  return { ids, readOnly: locked.size > 0 || hidden > 0 || unavailable > 0, message }
}
