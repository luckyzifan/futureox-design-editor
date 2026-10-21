import type { DesignDocument, DesignNode, Matrix } from '../model'
import { identity } from '../model'
import { cloneValue } from '../draft'
import { equalValue } from '../document-patch'
import { allParents, worldMatrix, type ParentMap } from '../geometry'
import { duplicateGraph, type Duplication, type GraphCopy } from '../duplicate-graph'
import { bounds, boxPoints, apply, inverse, multiply, translate, unionBounds } from './affine'
import { assertFreshSelection, assertStructuralParent, indexSelection, SelectionCommandError } from './selection-command'

/** Local command state, never request JSON, identity authority or a replay token. */
export interface DuplicationRepeat {
  roots: readonly string[]
  reference: ReadonlyMap<string, Matrix>
}
export type DuplicationIntent = { kind: 'default' } | { kind: 'world-offset'; x: number; y: number }
export interface DuplicationPlan {
  content: GraphCopy
  transforms: Map<string, Matrix>
  pageId: string
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
  // Officially documented repeat translation/rotation only. Scale, reflection
  // and skew invalidate the seed rather than inventing Figma's private rules.
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
  state: { fresh: boolean; singleStep: boolean; mutable: boolean; repeat?: DuplicationRepeat | null; destination?: string }): DuplicationPlan {
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
  const topFrames = index.ids.every(id => doc.nodes[id].kind === 'frame' && index.parents.get(id) === index.pageId)
  const frameBox = topFrames && intent.kind === 'default' && !repeat ? unionBounds(index.ids.map(id => {
    const n = doc.nodes[id], matrix = worldMatrix(doc, id, index.parents)
    return bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map(p => apply(matrix, p)))
  })) : undefined
  const transforms = new Map<string, Matrix>()
  for (const id of index.ids) {
    const delta = intent.kind === 'world-offset' ? translate(intent.x, intent.y) : repeat
      ? supportedRepeatDelta(worldMatrix(doc, id, index.parents), repeat.reference.get(id)!)
      : frameBox ? translate(frameBox.width + 24, 0) : identity()
    if (!delta || !finite(delta)) throw new SelectionCommandError('unsupported_duplicate_transform', 'Duplicate repeat supports finite translation and rotation only')
    transforms.set(id, delta)
  }
  return { content: copyForDuplication(doc, index.ids, state.mutable, index.parents), transforms, pageId: index.pageId }
}
export function applyDuplication(doc: DesignDocument, plan: DuplicationPlan): Duplication {
  return duplicateGraph(doc, plan.content, { transforms: plan.transforms })
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
