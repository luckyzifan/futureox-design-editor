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
/** Official Figma Duplicate puts a top-level frame or section to the right.
 * Help text states that direction and not the gap. Desktop reports from 2021
 * through 2024 measure 40px between those objects. This environment did not
 * run Figma 126.10.13. Shapes, groups, nested frames, and mixed selections
 * stay on top of the source. Sketch layout keeps the +10,+10 step. Paste is
 * a separate path and is not this command. */
export const FIGMA_TOP_LEVEL_FRAME_DUPLICATE_GAP = 40
export function duplicationCanvas(uiMode: string | undefined): 'figma' | 'ordinary' {
  return uiMode === 'sketch' ? 'ordinary' : 'figma'
}
export interface DuplicationPlan {
  content: GraphCopy
  transforms: Map<string, Matrix>
  pageId: string
  /** Figma sections grow around a duplicated frame or section. Sketch does not. */
  growSections: boolean
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
  // Bounds run only when every root is a free top-level frame or section.
  // A group, shape, nested frame, flow child, or mixed selection does not.
  const rightward = state.canvas === 'figma' && intent.kind === 'default' && !repeat
    && index.ids.every(id => rightwardDuplicateRoot(doc, id, index.parents, index.pageId))
  const frameShift = rightward ? unionBounds(index.ids.map(id => authoredWorldBounds(doc, id, index.parents))).width + FIGMA_TOP_LEVEL_FRAME_DUPLICATE_GAP : null
  const ordinary = state.canvas === 'figma' ? translate(0, 0) : translate(10, 10)
  const transforms = new Map<string, Matrix>()
  for (const id of index.ids) {
    const delta = intent.kind === 'world-offset' ? translate(intent.x, intent.y) : repeat
      ? supportedRepeatDelta(worldMatrix(doc, id, index.parents), repeat.reference.get(id)!)
      : frameShift !== null ? translate(frameShift, 0) : ordinary
    if (!delta || !finite(delta)) throw new SelectionCommandError('unsupported_duplicate_transform', 'Duplicate repeat supports finite translation and rotation only')
    transforms.set(id, delta)
  }
  return {
    content: copyForDuplication(doc, index.ids, state.mutable, index.parents), transforms, pageId: index.pageId,
    growSections: state.canvas === 'figma' && intent.kind === 'default',
  }
}
/** Page children, and frames or sections inside a free section, duplicate right.
 * Auto-layout flow stays with the layout solver. Nested frames stay on top. */
function rightwardDuplicateRoot(doc: DesignDocument, id: string, parents: ParentMap, pageId: string): boolean {
  const node = doc.nodes[id]
  if (!node || node.instanceOrigin || (node.kind !== 'frame' && node.kind !== 'section')) return false
  const parentId = parents.get(id)
  if (parentId === pageId) return true
  const parent = parentId ? doc.nodes[parentId] : undefined
  return !!parent && parent.kind === 'section' && (!parent.layout || parent.layout.mode === 'none')
}
function authoredWorldBounds(doc: DesignDocument, id: string, parents: ParentMap) {
  const n = doc.nodes[id], matrix = worldMatrix(doc, id, parents)
  return bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map(point => apply(matrix, point)))
}
function localBounds(node: DesignNode) {
  return bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(node.transform, point)))
}
/** Include only the new frame or section. Pre-existing overflow does not pull the section. */
function expandSectionToChildren(doc: DesignDocument, sectionId: string, childIds: readonly string[]): boolean {
  const section = doc.nodes[sectionId]
  if (!section || section.kind !== 'section' || (section.layout && section.layout.mode !== 'none')) return false
  const oldWidth = section.width, oldHeight = section.height
  let left = 0, top = 0, right = oldWidth, bottom = oldHeight, saw = false
  for (const id of childIds) {
    const child = doc.nodes[id]
    if (!child) continue
    saw = true
    const box = localBounds(child)
    left = Math.min(left, box.x); top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height)
  }
  if (!saw || (left === 0 && top === 0 && right === oldWidth && bottom === oldHeight)) return false
  if (left !== 0 || top !== 0) {
    section.transform = multiply(section.transform, translate(left, top))
    for (const id of section.children) {
      const child = doc.nodes[id], [a, b, c, d, tx, ty] = child.transform
      child.transform = [a, b, c, d, tx - left, ty - top]
    }
  }
  section.width = right - left
  section.height = bottom - top
  if (section.width !== oldWidth || section.height !== oldHeight) {
    for (const id of section.children) {
      const child = doc.nodes[id]
      if (!child.constraints) continue
      const referenceWidth = child.constraints.referenceWidth, referenceHeight = child.constraints.referenceHeight
      if (referenceWidth == null && referenceHeight == null) continue
      child.constraints = {
        ...child.constraints,
        ...(section.width !== oldWidth && referenceWidth != null ? { referenceWidth: section.width } : {}),
        ...(section.height !== oldHeight && referenceHeight != null ? { referenceHeight: section.height } : {}),
      }
    }
  }
  return true
}
function accommodateDuplicatedSections(doc: DesignDocument, roots: readonly string[]) {
  const parents = allParents(doc)
  const visit = (id: string) => {
    const node = doc.nodes[id]
    if (!node || (node.kind !== 'frame' && node.kind !== 'section')) return
    const parentId = parents.get(id)
    if (!parentId || doc.nodes[parentId]?.kind !== 'section') return
    if (expandSectionToChildren(doc, parentId, [id])) visit(parentId)
  }
  for (const id of roots) visit(id)
}
export function applyDuplication(doc: DesignDocument, plan: DuplicationPlan, behindSource = false): Duplication {
  const created = duplicateGraph(doc, plan.content, { transforms: plan.transforms, behindSource })
  if (plan.growSections) accommodateDuplicatedSections(doc, created.roots)
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
