import type { Bounds, Matrix } from '../model'
import { inverse, multiply, translate } from './affine'
import type { CommandProfile } from './profiles'

export interface TransformPatch { id: string; transform: Matrix }
export interface ChildListPlan { profile: CommandProfile; lists: { parent: string; children: string[] }[] }
/** Wrapping uses the shared parent-local geometry basis and admitted minimum dimensions. */
export function planContainerPlacement(profile: CommandProfile, box: Bounds, _parentWorld: Matrix) {
  return { transform: translate(box.x, box.y), width: Math.max(.01, box.width), height: Math.max(.01, box.height) }
}
export function reparentedTransform(parentWorld: Matrix, childWorld: Matrix): Matrix {
  return multiply(inverse(parentWorld), childWorld)
}
/** Pure list rewriting after adapter validation. No node lookup, locks, identity
 * generation, authority, selection, publication or history. Supplied lists are
 * copied; the target insertion index uses the list AFTER all removals. */
export function planChildReparent(profile: CommandProfile, moving: readonly { id: string; parent: string }[], lists: readonly { parent: string; children: readonly string[] }[], target: string, index?: number): ChildListPlan {
  if (new Set(moving.map(entry => entry.id)).size !== moving.length) throw Error('Duplicate reparent child')
  if (new Set(lists.map(list => list.parent)).size !== lists.length) throw Error('Duplicate reparent parent')
  // Group removals once. UI ungroup has no MCP target-count limit, so never
  // rescan/splice a source list for each moving child (quadratic for big groups).
  const removals = new Map<string, Set<string>>()
  for (const entry of moving) {
    let ids = removals.get(entry.parent)
    if (!ids) { ids = new Set(); removals.set(entry.parent, ids) }
    ids.add(entry.id)
  }
  const changed = new Map<string, string[]>()
  for (const list of lists) {
    const pending = removals.get(list.parent), children: string[] = []
    // Delete exactly the first occurrence, matching the legacy indexOf/splice
    // semantics even for an invalid list supplied to this pure helper.
    for (const id of list.children) if (!pending?.delete(id)) children.push(id)
    changed.set(list.parent, children)
  }
  if (!changed.has(target)) throw Error('Missing reparent target')
  for (const ids of removals.values()) if (ids.size) throw Error('Missing reparent child')
  const destination = changed.get(target)!
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index > destination.length)) throw Error('Invalid reparent index')
  const at = index ?? destination.length, inserted = new Array<string>(destination.length + moving.length)
  for (let i = 0; i < at; i++) inserted[i] = destination[i]
  for (let i = 0; i < moving.length; i++) inserted[at + i] = moving[i].id
  for (let i = at; i < destination.length; i++) inserted[moving.length + i] = destination[i]
  changed.set(target, inserted)
  return { profile, lists: [...changed].map(([parent, children]) => ({ parent, children })) }
}
