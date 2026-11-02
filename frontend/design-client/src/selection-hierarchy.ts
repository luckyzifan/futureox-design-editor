import { allParents, type ParentMap } from './geometry'
import type { DesignDocument, DesignNode } from './model'

const boundary = (node: DesignNode) => node.kind === 'frame' || node.kind === 'group' ||
  !!node.component || !!node.instance || !!node.componentSet

/** Marquee stays in the entered hierarchy shared by the current selection. */
export function marqueeScope(document: DesignDocument, page: string, selection: readonly string[], parents: ParentMap = allParents(document)): string {
  const paths = selection.map(id => interactivePath(document, page, id, false, parents).slice(0, -1)).filter(path => path.length)
  if (!paths.length || paths.length !== selection.length) return page
  let shared = page
  for (let i = 0; i < paths[0].length; i++) {
    const id = paths[0][i]
    if (!paths.every(path => path[i] === id)) break
    if (boundary(document.nodes[id])) shared = id
  }
  return shared
}

/** A page-local path, including the node, with inherited visibility/lock checks. */
export function interactivePath(document: DesignDocument, page: string, id: string,
  allowLocked = false, parents: ParentMap = allParents(document)): string[] {
  const path: string[] = [], seen = new Set<string>()
  let at: string | undefined = id
  while (at && at !== page) {
    const node = document.nodes[at]
    if (!node || !node.visible || (!allowLocked && node.locked) || seen.has(at)) return []
    seen.add(at); path.unshift(at); at = parents.get(at)
  }
  return at === page ? path : []
}

/** Mac Figma: frames and sections pass clicks through to child paint, and an
 * empty frame interior selects the frame. Groups and boolean groups take the
 * click until a descendant is the selection (entered). Components and
 * instances do the same. Command/Ctrl skips this and returns the leaf, and
 * repeating it does not walk back out. */
function clickBarrier(node: DesignNode): boolean {
  if (node.component || node.instance || node.componentSet) return true
  if (node.kind === 'frame' || node.kind === 'section') return false
  return node.kind === 'group' || !!node.booleanOperation
}
export function shallowSelectionHit(document: DesignDocument, selection: readonly string[],
  hit: string, path: readonly string[], parents: ParentMap = allParents(document)): string {
  const entered = new Set<string>()
  for (const id of selection) {
    const ancestors: string[] = []
    let at = parents.get(id)
    while (at && document.nodes[at]) { ancestors.push(at); at = parents.get(at) }
    if (!ancestors.some(parent => selection.includes(parent))) ancestors.forEach(parent => entered.add(parent))
  }
  return path.find(id => clickBarrier(document.nodes[id]) && !entered.has(id)) || hit
}

export function deeperSelectionHit(document: DesignDocument, selection: readonly string[],
  hit: string, path: readonly string[], parents?: ParentMap): string {
  const chain = path.filter(id => id === hit || boundary(document.nodes[id]))
  const selected = chain.findIndex(id => selection.includes(id))
  if (selected >= 0) return chain[Math.min(selected + 1, chain.length - 1)]
  // Nothing in this chain is selected, so a double-click goes one level past
  // the group or instance a single click would have selected.
  const shallow = shallowSelectionHit(document, selection, hit, path, parents)
  if (shallow === hit) return hit
  const at = path.indexOf(shallow)
  return at >= 0 && at + 1 < path.length ? path[at + 1] : shallow
}

export function navigateSelection(document: DesignDocument, page: string, selection: readonly string[],
  action: 'children' | 'parent' | 'next' | 'previous', parents: ParentMap = allParents(document)): string[] | null {
  const eligible = (id: string) => interactivePath(document, page, id, false, parents).length > 0
  const roots = [...new Set(selection)].filter(id => eligible(id) &&
    !interactivePath(document, page, id, false, parents).slice(0, -1).some(parent => selection.includes(parent)))
  if (!roots.length) return null
  let consumed = false
  const result = roots.flatMap(id => {
    if (action === 'children') {
      const children = [...document.nodes[id].children].reverse().filter(eligible)
      if (children.length) { consumed = true; return children }
      return [id]
    }
    if (action === 'parent') {
      const parent = parents.get(id)
      if (parent && eligible(parent)) { consumed = true; return [parent] }
      return [id]
    }
    const parent = parents.get(id)
    const siblings = [...(document.nodes[parent || '']?.children ||
      document.pages.find(value => value.id === parent)?.children || [])].reverse().filter(eligible)
    const at = siblings.indexOf(id)
    if (at < 0 || siblings.length < 2) return [id]
    consumed = true
    return [siblings[(at + (action === 'next' ? 1 : -1) + siblings.length) % siblings.length]]
  })
  return consumed ? [...new Set(result)] : null
}
