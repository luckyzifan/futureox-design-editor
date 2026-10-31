import type { DesignDocument } from '../model'
import type { ChildListPlan, TransformPatch } from './structure-plan'

/** Apply only to an adapter-owned isolated draft. This is not a public write API
 * and deliberately does not publish state, validate authority or commit history. */
export function applyChildListPlan(doc: DesignDocument, plan: ChildListPlan): void {
  for (const entry of plan.lists) {
    const list = doc.nodes[entry.parent]?.children ?? doc.pages.find(page => page.id === entry.parent)!.children
    // Avoid spreading an unbounded sibling list into function arguments. MCP
    // bounds selected IDs, not the total number of existing siblings.
    let start = 0
    while (start < list.length && start < entry.children.length && list[start] === entry.children[start]) start++
    let oldEnd = list.length, newEnd = entry.children.length
    while (oldEnd > start && newEnd > start && list[oldEnd - 1] === entry.children[newEnd - 1]) { oldEnd--; newEnd-- }
    if (newEnd - start <= 2048) list.splice(start, oldEnd - start, ...entry.children.slice(start, newEnd))
    else {
      // Very large moves have a long changed interval. Indexed writes avoid the
      // JS call-argument limit and repeated chunk-splice quadratic shifts.
      for (let index = start; index < entry.children.length; index++) list[index] = entry.children[index]
      list.length = entry.children.length
    }
  }
}
export function applyTransformPlan(doc: DesignDocument, patches: readonly TransformPatch[]): void {
  for (const patch of patches) doc.nodes[patch.id].transform = patch.transform
}
