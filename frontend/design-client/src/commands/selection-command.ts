import type { Bounds, DesignDocument, DesignNode, Matrix } from '../model'
import { identity } from '../model'
import { allParents, boxPoints, bounds, type ParentMap } from '../geometry'
import { kernelBounds } from '../kernel/picking'
import { apply, inverse as affineInverse, multiply, translate, unionBounds } from './affine'
import { planArrangement, type ArrangementMode } from './arrangement-plan'
import { planChildReparent, planContainerPlacement, type TransformPatch } from './structure-plan'
import { applyChildListPlan, applyTransformPlan } from './apply-plan'
import { CORE_SELECTION_PROFILE } from './profiles'

/** Internal command facts, not caller-supplied authority or an API version.
 * A mutable batch draft is fresh only before its first operation. A later
 * geometry command must not reuse derived networks from the original root. */
export interface SelectionGeometryState { fresh: boolean }
export class SelectionCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SelectionCommandError' }
}
const reject = (code: string, message: string): never => { throw new SelectionCommandError(code, message) }
function inverse(matrix: Matrix): Matrix {
  try { return affineInverse(matrix) }
  catch { return reject('unsupported_transform', 'Selection coordinate basis cannot be inverted safely') }
}
const activeLayout = (n: DesignNode | undefined) => !!n?.layout && n.layout.mode !== 'none'
function list(doc: DesignDocument, parent: string): readonly string[] {
  const result = doc.nodes[parent]?.children ?? doc.pages.find(page => page.id === parent)?.children
  return result ?? reject('invalid_structure', 'Selection has no valid parent')
}
interface SelectionIndex { ids: string[]; parents: ParentMap; pageId: string; order: Map<string, number> }
export function assertUnlocked(doc: DesignDocument, id: string, parents: ParentMap) {
  for (let at: string | undefined = id; at && doc.nodes[at]; at = parents.get(at))
    if (doc.nodes[at].locked) reject('locked_node', 'Selection or an affected ancestor/child is locked')
}
export function assertStructuralParent(doc: DesignDocument, id: string, parents: ParentMap) {
  for (let at: string | undefined = id; at && doc.nodes[at]; at = parents.get(at)) {
    const n = doc.nodes[at]
    if (n.instance || n.instanceOrigin) reject('instance_structure', 'Detach the instance before changing its internal structure')
  }
}
/** Complete validation precedes any plan application; UI never silently filters
 * locked or invalid explicit targets and edits the rest of a mixed selection. */
export function indexSelection(doc: DesignDocument, selected: readonly string[], ordered = true, knownParents?: ParentMap, lockIntent: 'structural' | 'property' = 'structural'): SelectionIndex {
  if (!selected.length) reject('invalid_params', 'Select at least one node')
  const ids = [...new Set(selected)], parents = knownParents ?? allParents(doc), chosen = new Set(ids)
  const pageIds = new Set<string>(), top: string[] = []
  for (const id of ids) {
    if (!Object.hasOwn(doc.nodes, id)) reject('not_found', 'A selected node no longer exists')
    // Authored lock is not authorization. Only known in-place property intents
    // opt out; every existing structural caller keeps the default guard.
    if (lockIntent === 'structural') assertUnlocked(doc, id, parents)
    let covered = false, at = parents.get(id)
    while (at && doc.nodes[at]) { if (chosen.has(at)) covered = true; at = parents.get(at) }
    if (!at || !doc.pages.some(page => page.id === at)) reject('invalid_structure', 'Selection has no page owner')
    pageIds.add(at!); if (!covered) top.push(id)
  }
  if (pageIds.size !== 1) reject('different_pages', 'Selection commands require one page')
  const pageId = [...pageIds][0], order = new Map<string, number>(), stack = ordered ? [...list(doc, pageId)].reverse() : []
  while (ordered && stack.length) {
    const id = stack.pop()!; order.set(id, order.size)
    const children = doc.nodes[id].children
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  if (ordered) top.sort((a, b) => order.get(a)! - order.get(b)! || a.localeCompare(b))
  return { ids: top, parents, pageId, order }
}
function assertPositionable(doc: DesignDocument, index: SelectionIndex) {
  for (const id of index.ids) {
    const n = doc.nodes[id], parent = doc.nodes[index.parents.get(id)!]
    if (activeLayout(parent) && !n.sizing?.absolute)
      reject('auto_layout_position', 'Auto-layout flow children must be positioned through layout controls')
  }
}
function assertWrap(doc: DesignDocument, index: SelectionIndex, allowLayoutParent = false) {
  const parent = index.parents.get(index.ids[0])!
  if (index.ids.some(id => index.parents.get(id) !== parent)) reject('different_parents', 'Grouping requires the same immediate parent')
  assertStructuralParent(doc, parent, index.parents)
  if (!allowLayoutParent && activeLayout(doc.nodes[parent])) reject('unsupported_layout_topology', 'Grouping in auto-layout requires a layout-aware command')
  for (const id of index.ids) {
    const n = doc.nodes[id]
    if (n.component || n.componentSet || n.instance || n.instanceOrigin)
      reject('instance_structure', 'Component and instance containers require their dedicated structural operations')
  }
}
function assertUnwrap(doc: DesignDocument, index: SelectionIndex) {
  for (const id of index.ids) {
    const n = doc.nodes[id], parent = index.parents.get(id)!
    if (!['group', 'frame', 'section'].includes(n.kind) && !n.booleanOperation)
      reject('invalid_kind', 'Only groups, frames, sections and boolean containers can be ungrouped')
    if (n.component || n.componentSet || n.instance || n.instanceOrigin)
      reject('instance_structure', 'Components and instances cannot be ungrouped')
    assertStructuralParent(doc, parent, index.parents)
    if (activeLayout(n) || activeLayout(doc.nodes[parent])) reject('unsupported_layout_topology', 'Ungrouping auto-layout topology requires a layout-aware command')
    for (const child of n.children) {
      assertUnlocked(doc, child, index.parents)
      if (doc.nodes[child].instanceOrigin) reject('instance_structure', 'Instance-internal children cannot be reparented')
    }
  }
}
/** Cheap toolbar/Inspector availability shares admission, not a second geometry
 * implementation. Exact overlap/bounds checks still run at execution time. */
export function selectionCommandAdmission(doc: DesignDocument, ids: readonly string[], command: 'align' | 'distribute' | 'wrap' | 'unwrap', parents?: ParentMap) {
  try {
    const index = indexSelection(doc, ids, false, parents)
    if (command === 'wrap') assertWrap(doc, index)
    else if (command === 'unwrap') assertUnwrap(doc, index)
    else {
      assertPositionable(doc, index)
      if (command === 'align' && index.ids.length === 1 && !doc.nodes[index.parents.get(index.ids[0])!]) reject('invalid_parent', 'Single-node alignment requires a finite node parent')
      if (command === 'distribute' && index.ids.length < 2) reject('invalid_params', 'Distribution requires at least two nodes')
    }
    return { ok: true as const }
  } catch (error) {
    if (error instanceof SelectionCommandError) return { ok: false as const, code: error.code, message: error.message }
    throw error
  }
}
export function assertFreshSelection(doc: DesignDocument, index: SelectionIndex, state: SelectionGeometryState) {
  if (state.fresh) return
  const visited = new Set<string>()
  const derived = (n: DesignNode) => !!(n.booleanOperation || n.instance || n.instanceOrigin || n.component || n.componentSet ||
    n.kind === 'text' || n.textPath || n.connector || n.board || activeLayout(n) || Object.keys(n.bindings || {}).length || Object.keys(n.styleRefs || {}).length || Object.keys(n.variableModes || {}).length ||
    n.constraints || (n.sizing && (n.sizing.width !== 'fixed' || n.sizing.height !== 'fixed')))
  const assertFresh = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const n = doc.nodes[id]
    if (derived(n)) reject('unsupported_derived_batch_geometry', 'Derived geometry after an earlier batch operation is not yet proven fresh; commit first, then read and retry the selection command')
    for (const child of n.children) assertFresh(child)
  }
  for (const id of index.ids) {
    assertFresh(id)
    for (let at = index.parents.get(id); at && doc.nodes[at]; at = index.parents.get(at))
      if (derived(doc.nodes[at])) reject('unsupported_derived_batch_geometry', 'Ancestor-derived batch geometry is not proven fresh; commit first, then read and retry the selection command')
  }
}
function geometry(doc: DesignDocument, index: SelectionIndex, state: SelectionGeometryState, basis: Matrix) {
  assertFreshSelection(doc, index, state)
  const world = new Map<string, Matrix>(), measured = new Map<string, Bounds>()
  const matrix = (id: string): Matrix => {
    const found = world.get(id); if (found) return found
    const n = doc.nodes[id], value = n ? multiply(matrix(index.parents.get(id)!), n.transform) : identity()
    world.set(id, value); return value
  }
  const measure = (id: string): Bounds => {
    const known = measured.get(id); if (known) return known
    const n = doc.nodes[id], m = multiply(basis, matrix(id))
    let result: Bounds
    if (n.kind === 'group' && n.children.length) result = unionBounds(n.children.map(measure))
    else if (n.network || n.vectorGeometry || n.textPath || n.pathOffset || n.vectorBrush || n.booleanOperation) {
      // Never use a mutable draft node as the WeakMap key in kernelBounds.
      // The private shallow record is stable for this synchronous measurement.
      const stable = { ...n }
      result = kernelBounds(stable, m) ?? reject('geometry_unavailable', 'Exact selection geometry is unavailable')
    } else result = bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map(point => apply(m, point)))
    if (![result.x, result.y, result.width, result.height].every(Number.isFinite) || result.width < 0 || result.height < 0)
      reject('geometry_unavailable', 'Selection geometry is not finite')
    measured.set(id, result); return result
  }
  return { measure, matrix }
}
export interface SelectionArrangement { ids: string[]; patches: TransformPatch[] }
export function prepareSelectionArrangement(doc: DesignDocument, selected: readonly string[], axis: 'x' | 'y', mode: ArrangementMode, state: SelectionGeometryState): SelectionArrangement {
  const index = indexSelection(doc, selected); assertPositionable(doc, index)
  if (mode === 'distribute' && index.ids.length < 2) reject('invalid_params', 'Distribution requires at least two nodes')
  if (mode === 'distribute' && index.ids.length === 2) return { ids: index.ids, patches: [] }
  const single = index.ids.length === 1, parent = index.parents.get(index.ids[0])!, parentNode = doc.nodes[parent]
  if (single && !parentNode) reject('invalid_parent', 'Single-node alignment requires a finite node parent')
  // Build the parent basis once; the geometry reader independently memoizes
  // world matrices for every measured node and its ancestry.
  const world = (id: string): Matrix => doc.nodes[id] ? multiply(world(index.parents.get(id)!), doc.nodes[id].transform) : identity()
  const basis = single ? inverse(world(parent)) : identity(), reader = geometry(doc, index, state, basis)
  const rects = index.ids.map(reader.measure)
  if (mode === 'distribute') {
    const size = axis === 'x' ? 'width' : 'height', sorted = [...rects].sort((a, b) => a[axis] - b[axis])
    for (let i = 1; i < sorted.length; i++) if (sorted[i][axis] < sorted[i - 1][axis] + sorted[i - 1][size] - 1e-9)
      reject('unsupported_distribution_geometry', 'Overlapping or contained distribution intervals need an explicit endpoint policy')
  }
  const plan = planArrangement(CORE_SELECTION_PROFILE, rects, axis, mode, single ? { x: 0, y: 0, width: parentNode.width, height: parentNode.height } : undefined)!
  return { ids: index.ids, patches: index.ids.map((id, i) => {
    const delta = plan.offsets[i]
    if (delta.x === 0 && delta.y === 0) return { id, transform: doc.nodes[id].transform }
    return { id, transform: single ? multiply(translate(delta.x, delta.y), doc.nodes[id].transform) :
      multiply(inverse(reader.matrix(index.parents.get(id)!)), multiply(translate(delta.x, delta.y), reader.matrix(id))) }
  }).filter((patch) => patch.transform.some((value, i) => value !== doc.nodes[patch.id].transform[i])) }
}
export interface SelectionWrap {
  ids: string[]; parent: string; index: number; transform: Matrix; width: number; height: number; transforms: TransformPatch[]
}
export function prepareSelectionWrap(doc: DesignDocument, selected: readonly string[], state: SelectionGeometryState, knownIndex?: ReturnType<typeof indexSelection>, placementMode?: { allowLayoutParent?: boolean; stack?: 'back' | 'front' }): SelectionWrap {
  const index = knownIndex ?? indexSelection(doc, selected); assertWrap(doc, index, placementMode?.allowLayoutParent)
  const parent = index.parents.get(index.ids[0])!
  const world = (id: string): Matrix => doc.nodes[id] ? multiply(world(index.parents.get(id)!), doc.nodes[id].transform) : identity()
  const parentWorld = world(parent), reader = geometry(doc, index, state, inverse(parentWorld))
  const box = unionBounds(index.ids.map(reader.measure)), placement = planContainerPlacement(CORE_SELECTION_PROFILE, box, parentWorld), transform = placement.transform
  const childBasis = inverse(multiply(parentWorld, transform))
  const siblingIndex = new Map(list(doc, parent).map((id, at) => [id, at]))
  const slots = index.ids.map(id => siblingIndex.get(id)!)
  const at = placementMode?.stack === 'front' ? Math.max(...slots) : Math.min(...slots)
  return { ids: index.ids, parent, index: at, transform,
    width: placement.width, height: placement.height,
    transforms: index.ids.map(id => ({ id, transform: multiply(childBasis, reader.matrix(id)) })) }
}
function resetReparentedConstraints(doc: DesignDocument, ids: readonly string[]) {
  // Like Editor.reparentMany, adopt the new parent's dimensions on the next
  // native layout pass instead of applying a resize delta from the old parent.
  for (const id of ids) if (doc.nodes[id].constraints)
    doc.nodes[id].constraints = { ...doc.nodes[id].constraints!, referenceWidth: null, referenceHeight: null }
}
export function applySelectionWrap(doc: DesignDocument, plan: SelectionWrap, wrapper: DesignNode) {
  if (Object.hasOwn(doc.nodes, wrapper.id) || doc.pages.some(page => page.id === wrapper.id)) reject('duplicate_id', 'Container identifier already exists')
  const siblings = doc.nodes[plan.parent]?.children ?? doc.pages.find(page => page.id === plan.parent)!.children
  siblings.splice(plan.index, 0, wrapper.id); doc.nodes[wrapper.id] = wrapper
  applyChildListPlan(doc, planChildReparent(CORE_SELECTION_PROFILE, plan.ids.map(id => ({ id, parent: plan.parent })), [
    { parent: plan.parent, children: siblings }, { parent: wrapper.id, children: [] },
  ], wrapper.id))
  applyTransformPlan(doc, plan.transforms)
  resetReparentedConstraints(doc, plan.ids)
}
export interface SelectionUnwrap { ids: string[]; entries: { id: string; parent: string; children: string[]; transforms: TransformPatch[] }[] }
export function prepareSelectionUnwrap(doc: DesignDocument, selected: readonly string[], state: SelectionGeometryState): SelectionUnwrap {
  const index = indexSelection(doc, selected); assertUnwrap(doc, index); assertFreshSelection(doc, index, state)
  return { ids: index.ids, entries: index.ids.map(id => ({ id, parent: index.parents.get(id)!, children: [...doc.nodes[id].children],
    transforms: doc.nodes[id].children.map(child => ({ id: child, transform: multiply(doc.nodes[id].transform, doc.nodes[child].transform) })),
  })) }
}
export function applySelectionUnwrap(doc: DesignDocument, plan: SelectionUnwrap): string[] {
  const revealed: string[] = [], replacements = new Map(plan.entries.map(entry => [entry.id, entry.children]))
  const lists = [...new Set(plan.entries.map(entry => entry.parent))].map(parent => {
    const children: string[] = []
    for (const id of list(doc, parent)) {
      const lifted = replacements.get(id)
      if (lifted) for (const child of lifted) children.push(child)
      else children.push(id)
    }
    return { parent, children }
  })
  // Rewrite each affected sibling list once, not once per selected wrapper.
  applyChildListPlan(doc, { profile: CORE_SELECTION_PROFILE, lists })
  for (const entry of plan.entries) {
    applyTransformPlan(doc, entry.transforms)
    resetReparentedConstraints(doc, entry.children)
    // Release only the removed container's direct mask scope. Nested scopes stay.
    for (const id of entry.children) { doc.nodes[id].mask = false; revealed.push(id) }
    delete doc.nodes[entry.id]
  }
  return revealed
}

/** Defaults of wrapping a selection, intentionally not the empty-frame factory. */
export function configureSelectionWrapper(wrapper: DesignNode, plan: SelectionWrap): void {
  wrapper.transform = plan.transform; wrapper.width = plan.width; wrapper.height = plan.height
  wrapper.fills = []; wrapper.strokes = []; wrapper.effects = []; wrapper.blend = 'pass-through'; wrapper.clip = false
}
