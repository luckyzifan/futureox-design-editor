import type { DesignDocument, DesignNode, Matrix } from '../model'
import { identity } from '../model'
import { cloneValue } from '../draft'
import { equalValue } from '../document-patch'
import { allParents, worldMatrix, type ParentMap } from '../geometry'
import { duplicateGraph, type Duplication, type GraphCopy } from '../duplicate-graph'
import { apply, bounds, boxPoints, inverse, multiply, translate, unionBounds } from './affine'
import { assertFreshSelection, assertStructuralParent, indexSelection, SelectionCommandError } from './selection-command'

/** Local command state, never request JSON, identity authority or a replay token. */
export interface DuplicationRepeat {
  roots: readonly string[]
  reference: ReadonlyMap<string, Matrix>
}
export type DuplicationIntent = { kind: 'default' } | { kind: 'world-offset'; x: number; y: number }
/** Desktop Figma puts a duplicated top-level frame to the right of the source.
 * Help text states that direction and which objects, not the gap:
 * copy/paste (top-level frames), FD4B (top-level frames and sections), and
 * Frames (a frame duplicated inside a section grows that section). Desktop
 * reports from 2021 through 2024 measure 40px between the frames. This
 * environment did not run Figma 126.10.13 and does not substitute another gap.
 * The first ordinary Figma canvas copy stays in place. Sketch uses its
 * existing +10,+10 step. */
export const FIGMA_TOP_LEVEL_FRAME_DUPLICATE_GAP = 40
export function duplicationCanvas(uiMode: string | undefined): 'figma' | 'ordinary' {
  return uiMode === 'sketch' ? 'ordinary' : 'figma'
}
export interface DuplicationPlan {
  content: GraphCopy
  transforms: Map<string, Matrix>
  pageId: string
  /** Figma default/repeat only. Grows ancestor sections after the copy lands. */
  accommodateSections: boolean
}
const reject = (code: string, message: string): never => { throw new SelectionCommandError(code, message) }
/** Explicit MCP axes retain their established world-space meaning, including
 * the missing axis default of 24. No offsets means the shared editor intent. */
export function duplicationIntent(offsetX?: number, offsetY?: number): DuplicationIntent {
  return offsetX === undefined && offsetY === undefined ? { kind: 'default' }
    : { kind: 'world-offset', x: offsetX ?? 24, y: offsetY ?? 24 }
}
function finite(matrix: Matrix) { return matrix.every(Number.isFinite) }
export function supportedRepeatDelta(current: Matrix, reference: Matrix): Matrix | null {
  if (!finite(current) || !finite(reference)) return null
  if (current.every((v, i) => v === reference[i])) return identity()
  if (current.slice(0, 4).every((v, i) => v === reference[i]))
    return translate(current[4] - reference[4], current[5] - reference[5])
  let delta: Matrix
  try { delta = multiply(current, inverse(reference)) } catch { return null }
  const [a, b, c, d] = delta, epsilon = 1e-8
  return finite(delta) && Math.abs(a * a + b * b - 1) < epsilon && Math.abs(c * c + d * d - 1) < epsilon &&
    Math.abs(a * c + b * d) < epsilon && Math.abs(a * d - b * c - 1) < epsilon ? delta : null
}
export function repeatMatches(repeat: DuplicationRepeat | null | undefined, ids: readonly string[]): repeat is DuplicationRepeat {
  return !!repeat && ids.length === repeat.roots.length && ids.every(id => repeat.reference.has(id))
}
/** Borrow immutable UI roots. A mutable automation draft needs only a shallow
 * source graph plus the containers/behavior arrays changed by duplicateGraph;
 * do not clone image/font resources or introduce another whole-doc layout. */
function copyForDuplication(doc: DesignDocument, roots: string[], mutable: boolean, parents: ParentMap): GraphCopy {
  const nodes: Record<string, DesignNode> = {}, stack = [...roots]
  while (stack.length) {
    const id = stack.pop()!, n = doc.nodes[id]
    if (nodes[id]) continue
    nodes[id] = cloneValue(n)
    for (const child of n.children) stack.push(child)
  }
  if (!mutable) return { nodes, roots, document: doc }
  const source = { ...doc, nodes: { ...doc.nodes }, pages: doc.pages.map(p => ({ ...p, children: [...p.children] })) }
  // Parent child-lists are the only existing node fields this primitive edits.
  for (const parent of new Set(roots.map(id => parents.get(id)!))) {
    const n = source.nodes[parent]
    if (n) source.nodes[parent] = { ...n, children: [...n.children] }
  }
  if (doc.prototype) source.prototype = { ...doc.prototype, interactions: { ...doc.prototype.interactions } }
  if (doc.animations) source.animations = doc.animations.map(clip => ({ ...clip, tracks: [...clip.tracks] }))
  return { nodes, roots, document: source }
}
export function prepareDuplication(doc: DesignDocument, selected: readonly string[], intent: DuplicationIntent,
  state: { fresh: boolean; singleStep: boolean; mutable: boolean; repeat?: DuplicationRepeat | null; destination?: string; canvas?: 'figma' | 'ordinary' }): DuplicationPlan {
  const index = indexSelection(doc, selected)
  for (const id of index.ids) {
    assertStructuralParent(doc, index.parents.get(id)!, index.parents)
    if (doc.nodes[id].instanceOrigin) reject('instance_structure', 'Duplicate the complete instance, not a generated internal node')
  }
  assertFreshSelection(doc, index, state)
  if (state.destination && doc.nodes[state.destination]) {
    const destination = indexSelection(doc, [state.destination], false, index.parents)
    assertStructuralParent(doc, state.destination, index.parents)
    assertFreshSelection(doc, destination, state)
  }
  const repeat = intent.kind === 'default' && repeatMatches(state.repeat, index.ids) ? state.repeat : null
  if (repeat && !state.singleStep) reject('unsupported_duplicate_repeat_batch', 'Implicit duplicate repeat requires one normalized operation, not a multi-operation batch')
  // Bounds run only when every root is a page-level frame/section or a direct
  // child of a non-flow section. Other Figma canvas selections duplicate
  // in place, including ordinary rectangles in the live comparison.
  const rightDuplicate = state.canvas === 'figma' && intent.kind === 'default' && !repeat
    && index.ids.every(id => figmaRightDuplicate(doc, id, index))
  const frameShift = rightDuplicate ? unionBounds(index.ids.map(id => {
    const n = doc.nodes[id], matrix = worldMatrix(doc, id, index.parents)
    return bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map(point => apply(matrix, point)))
  })).width + FIGMA_TOP_LEVEL_FRAME_DUPLICATE_GAP : null
  const transforms = new Map<string, Matrix>()
  for (const id of index.ids) {
    const delta = intent.kind === 'world-offset' ? translate(intent.x, intent.y) : repeat
      ? supportedRepeatDelta(worldMatrix(doc, id, index.parents), repeat.reference.get(id)!)
      : frameShift !== null ? translate(frameShift, 0) : state.canvas === 'figma' ? identity() : translate(10, 10)
    if (!delta || !finite(delta)) throw new SelectionCommandError('unsupported_duplicate_transform', 'Duplicate repeat supports finite translation and rotation only')
    transforms.set(id, delta)
  }
  return { content: copyForDuplication(doc, index.ids, state.mutable, index.parents), transforms, pageId: index.pageId,
    accommodateSections: state.canvas === 'figma' && intent.kind === 'default' }
}
function activeFlow(node: DesignNode | undefined) {
  return !!node?.layout && node.layout.mode !== 'none'
}
/** Page children, and direct children of a section that is not auto-layout. */
function figmaRightDuplicate(doc: DesignDocument, id: string, index: { parents: ParentMap; pageId: string }) {
  const node = doc.nodes[id]
  if (!node || (node.kind !== 'frame' && node.kind !== 'section')) return false
  const parentId = index.parents.get(id)
  if (!parentId || activeFlow(doc.nodes[parentId])) return false
  return parentId === index.pageId || doc.nodes[parentId]?.kind === 'section'
}
function localBox(node: DesignNode) {
  return bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(node.transform, point)))
}
/** Grow a section to the listed direct children. No padding. Existing siblings
 * keep their world position when the section origin has to move. */
function expandSection(doc: DesignDocument, sectionId: string, childIds: readonly string[]): boolean {
  const section = doc.nodes[sectionId]
  if (!section || section.kind !== 'section' || !childIds.length) return false
  let minX = 0, minY = 0, maxX = section.width, maxY = section.height
  for (const id of childIds) {
    const child = doc.nodes[id]
    if (!child) continue
    const box = localBox(child)
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (minX === 0 && minY === 0 && maxX === section.width && maxY === section.height) return false
  if (minX !== 0 || minY !== 0) {
    section.transform = multiply(section.transform, translate(minX, minY))
    for (const id of section.children) {
      const child = doc.nodes[id]
      if (!child) continue
      child.transform[4] -= minX
      child.transform[5] -= minY
    }
    if (section.guides) section.guides = section.guides.map(guide => ({
      ...guide, position: guide.position - (guide.axis === 'x' ? minX : minY),
    }))
  }
  section.width = maxX - minX
  section.height = maxY - minY
  for (const id of section.children) {
    const child = doc.nodes[id]
    if (child?.constraints) child.constraints = { ...child.constraints, referenceWidth: section.width, referenceHeight: section.height }
  }
  return true
}
function fittingSection(doc: DesignDocument, id: string | undefined) {
  const section = id ? doc.nodes[id] : undefined
  return !!section && section.kind === 'section' && !activeFlow(section)
}
/** After a Figma duplicate, keep each ancestor section around the new frame
 * or section. Deeper sections grow before their parents see the new box. */
function accommodateFigmaDuplicateSections(doc: DesignDocument, created: Duplication, sourceParents: ParentMap) {
  const pending = new Map<string, string[]>()
  const queued = new Set<string>()
  const enqueue = (sectionId: string | undefined, childId: string) => {
    if (!fittingSection(doc, sectionId) || !sectionId) return
    const list = pending.get(sectionId)
    if (list) { if (!list.includes(childId)) list.push(childId) }
    else pending.set(sectionId, [childId])
    queued.add(sectionId)
  }
  const depth = (id: string) => {
    let count = 0, at: string | undefined = id
    const seen = new Set<string>()
    while (at && !seen.has(at)) { seen.add(at); count += 1; at = sourceParents.get(at) }
    return count
  }
  created.roots.forEach((root, index) => {
    const node = doc.nodes[root]
    if (!node || (node.kind !== 'frame' && node.kind !== 'section')) return
    enqueue(sourceParents.get(created.sourceRoots[index]), root)
  })
  while (queued.size) {
    let next = '', best = -1
    for (const id of queued) {
      const value = depth(id)
      if (value > best) { best = value; next = id }
    }
    queued.delete(next)
    if (expandSection(doc, next, pending.get(next)!)) enqueue(sourceParents.get(next), next)
  }
}
export function applyDuplication(doc: DesignDocument, plan: DuplicationPlan, behindSource = false): Duplication {
  const created = duplicateGraph(doc, plan.content, { transforms: plan.transforms, behindSource })
  if (plan.accommodateSections) accommodateFigmaDuplicateSections(doc, created, allParents(plan.content.document))
  return created
}
/** Retain repeat only across a provable authored root transform-only chain.
 * Any other property/topology/behavior edit clears it. No hidden recomputation. */
export function canContinueDuplication(before: DesignDocument, after: DesignDocument, repeat: DuplicationRepeat): boolean {
  const roots = new Set(repeat.roots)
  if (Object.keys(before).length !== Object.keys(after).length || Object.keys(before.nodes).length !== Object.keys(after.nodes).length) return false
  for (const key of Object.keys(before) as (keyof DesignDocument)[]) if (key !== 'nodes' && before[key] !== after[key] && !equalValue(before[key], after[key])) return false
  const beforeParents = allParents(before), afterParents = allParents(after)
  for (const [id, previous] of Object.entries(before.nodes)) {
    const next = after.nodes[id]
    if (next === previous) continue
    if (!next || !roots.has(id) || !equalValue({ ...previous, transform: next.transform }, next)) return false
    if (!supportedRepeatDelta(worldMatrix(after, id, afterParents), worldMatrix(before, id, beforeParents))) return false
  }
  return repeat.roots.every(id => !!after.nodes[id])
}
