import { defaultLayout, defaultSizing, node, type AutoLayout, type DesignDocument, type DesignNode } from '../model'
import { equalValue } from '../document-patch'
import { indexSelection, assertUnlocked, assertStructuralParent, SelectionCommandError,
  prepareSelectionWrap, configureSelectionWrapper, applySelectionWrap, type SelectionGeometryState, type SelectionWrap } from './selection-command'

export interface LayoutAddOptions {
  mode: 'horizontal' | 'vertical'
  gap?: number
  padding?: { top: number; right: number; bottom: number; left: number }
  order?: 'scene' | 'axis'
  id?: string
  name?: string
}
const reject = (code: string, message: string): never => { throw new SelectionCommandError(code, message) }
const active = (n: DesignNode) => !!n.layout && n.layout.mode !== 'none'
/** Shared UI/MCP intent admission. Structural locks reject, property locks
 * remain editable; neither policy filters explicit targets. Instances and
 * bound geometry require dedicated intent; the current phase does not detach. */
function layoutAffectedAdmission(doc: DesignDocument, ids: readonly string[], intent: 'add' | 'remove') {
  if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) reject('invalid_params', 'Supply 1–1000 unique node identifiers')
  // Derive the policy from the real operation and target kinds, never request
  // metadata. Existing frames retain identity/topology: these are properties.
  const propertyIntent = intent === 'remove'
    ? ids.every(id => doc.nodes[id]?.kind === 'frame')
    : ids.length === 1 && doc.nodes[ids[0]]?.kind === 'frame'
  const index = indexSelection(doc, ids, true, undefined, propertyIntent ? 'property' : 'structural')
  let count = 0
  const visit = (id: string) => {
    if (++count > 10000) reject('request_budget', 'Layout affected subtree exceeds 10000 nodes')
    const n = doc.nodes[id]
    if (!propertyIntent) assertUnlocked(doc, id, index.parents)
    // Editing an existing master frame's layout preserves its identity/tree.
    // Rust materializes dependent instances after this normal property edit.
    // Wrapping/retyping masters and changing instance internals remain separate
    // structural intents and must not be admitted by this exception.
    const masterProperty = propertyIntent && index.ids.includes(id) && n.kind === 'frame' && !!n.component
    if (n.component && !masterProperty || n.componentSet || n.instance || n.instanceOrigin)
      reject('instance_structure', 'Layout commands cannot restructure components or edit instance internals')
    if (Object.keys(n.bindings || {}).length || Object.keys(n.variableModes || {}).length || Object.keys(n.styleRefs || {}).length || n.board || n.connector || n.textPath) reject('unsupported_layout_topology', 'Bound or dependent layout geometry is not supported by this command')
    if (!n.transform.every(Number.isFinite) || Math.abs(n.transform[0] * n.transform[3] - n.transform[1] * n.transform[2]) < 1e-12 || !Number.isFinite(n.width) || !Number.isFinite(n.height)) reject('unsupported_transform', 'Layout geometry must have a finite invertible basis')
    for (const child of n.children) visit(child)
  }
  for (const id of index.ids) {
    assertStructuralParent(doc, id, index.parents)
    visit(id)
  }
  return index
}
export function layoutCommandAdmission(doc: DesignDocument, ids: readonly string[], intent: 'add' | 'remove' = 'add') {
  const index = layoutAffectedAdmission(doc, ids, intent)
  for (const id of index.ids) {
    for (let at = index.parents.get(id); at && doc.nodes[at]; at = index.parents.get(at)) {
      const p = doc.nodes[at]
      if (active(p)) reject('unsupported_layout_topology', 'Layout changes inside an active layout ancestor require a dedicated responsive command')
      if (p.component || p.componentSet || Object.keys(p.bindings || {}).length || Object.keys(p.variableModes || {}).length || Object.keys(p.styleRefs || {}).length) reject('unsupported_layout_topology', 'Derived ancestor layout is not supported')
      if (!p.transform.every(Number.isFinite) || Math.abs(p.transform[0] * p.transform[3] - p.transform[1] * p.transform[2]) < 1e-12) reject('unsupported_transform', 'Ancestor basis must be finite and invertible')
    }
  }
  return index
}
function fresh(state: SelectionGeometryState) {
  if (!state.fresh) reject('unsupported_derived_batch_geometry', 'Commit earlier operations, then read and retry layout.add/remove on the normalized document')
}
function childOrder(doc: DesignDocument, children: readonly string[], mode: LayoutAddOptions['mode'], order: 'scene' | 'axis') {
  if (order === 'scene') return [...children]
  const axis = mode === 'vertical' ? 5 : 4
  // Hidden/absolute children retain their slots; stable ties use scene order.
  const flow = children.filter(id => doc.nodes[id].visible && !doc.nodes[id].sizing?.absolute)
  const rank = new Map(children.map((id, i) => [id, i]))
  flow.sort((a, b) => doc.nodes[a].transform[axis] - doc.nodes[b].transform[axis] || rank.get(a)! - rank.get(b)!)
  let i = 0
  return children.map(id => doc.nodes[id].visible && !doc.nodes[id].sizing?.absolute ? flow[i++] : id)
}
export interface LayoutAddPlan { pageId: string; target: string; wrapper?: DesignNode; wrap?: SelectionWrap; layout: AutoLayout; childOrder: string[]; changed: boolean }
export function prepareLayoutAdd(doc: DesignDocument, ids: readonly string[], options: LayoutAddOptions, state: SelectionGeometryState): LayoutAddPlan {
  const index = layoutCommandAdmission(doc, ids); fresh(state)
  if (!['horizontal', 'vertical'].includes(options.mode) || (options.order !== undefined && !['scene', 'axis'].includes(options.order))) reject('invalid_params', 'Invalid layout mode or child order')
  const numeric = (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1e5) reject('invalid_params', 'Gap and padding must be within 0–100000'); return value }
  const selected = index.ids.map(id => doc.nodes[id]), target = selected[0]
  if (selected.some(n => n.booleanOperation || (n.mask && n.children.length))) reject('unsupported_layout_topology', 'Boolean and mask containers require their dedicated operations')
  const inplace = selected.length === 1 && ['frame', 'group'].includes(target.kind)
  if (inplace && (target.booleanOperation || target.mask)) reject('unsupported_layout_topology', 'Boolean and mask groups cannot be converted to layout frames')
  if (inplace && (options.id !== undefined || options.name !== undefined)) reject('invalid_params', 'id and name apply only to newly created wrappers')
  const layout = { ...defaultLayout(), ...(inplace ? target.layout : undefined), mode: options.mode }
  if (options.gap !== undefined) layout.gap = numeric(options.gap)
  if (options.padding) layout.padding = [numeric(options.padding.top), numeric(options.padding.right), numeric(options.padding.bottom), numeric(options.padding.left)]
  if (inplace) {
    const children = childOrder(doc, target.children, options.mode, options.order ?? 'scene')
    return { pageId: index.pageId, target: target.id, layout, childOrder: children, changed: target.kind !== 'frame' || !equalValue(target.layout, layout) || !equalValue(target.children, children) }
  }
  const wrap = prepareSelectionWrap(doc, index.ids, state, index), wrapper = node('frame', 0, 0, wrap.width, wrap.height)
  if (options.id !== undefined) {
    if (!options.id.trim() || options.id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(options.id)) reject('invalid_params', 'Invalid wrapper identifier')
    wrapper.id = options.id
  }
  if (Object.hasOwn(doc.nodes, wrapper.id) || doc.pages.some(p => p.id === wrapper.id)) reject('duplicate_id', 'Wrapper identifier already exists')
  if (options.name !== undefined && (!options.name.trim() || options.name.length > 200)) reject('invalid_params', 'Wrapper name must contain 1–200 characters')
  configureSelectionWrapper(wrapper, wrap); wrapper.name = options.name ?? '自动布局'
  wrapper.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  return { pageId: index.pageId, target: wrapper.id, wrapper, wrap, layout, childOrder: childOrder(doc, wrap.ids, options.mode, options.order ?? 'axis'), changed: true }
}
export function applyLayoutAdd(doc: DesignDocument, plan: LayoutAddPlan) {
  if (!plan.changed) return
  if (plan.wrapper && plan.wrap) applySelectionWrap(doc, plan.wrap, plan.wrapper)
  const target = doc.nodes[plan.target]
  target.kind = 'frame'; target.layout = plan.layout; target.children = [...plan.childOrder]
}
export interface LayoutRemovePlan { pageId: string; ids: string[]; changedIds: string[] }
export function prepareLayoutRemove(doc: DesignDocument, ids: readonly string[], state: SelectionGeometryState): LayoutRemovePlan {
  const index = layoutCommandAdmission(doc, ids, 'remove'); fresh(state)
  // Explicit overlapping selections must all be processed, not just roots.
  for (const id of ids) {
    const n = doc.nodes[id]
    if (n.kind !== 'frame') reject('invalid_kind', 'layout.remove requires ordinary frames')
    if (!active(n)) continue
    for (let at = index.parents.get(id); at && doc.nodes[at]; at = index.parents.get(at)) {
      const p = doc.nodes[at]
      if (active(p) || p.sizing?.width === 'hug' || p.sizing?.height === 'hug') reject('unsupported_layout_topology', 'Removing layout inside a responsive ancestor is not yet supported')
    }
    for (const target of [n, ...n.children.map(child => doc.nodes[child])]) {
      const s = target.sizing
      if (s && (target.width < s.minWidth || target.width > s.maxWidth || target.height < s.minHeight || target.height > s.maxHeight)) reject('unsupported_layout_topology', 'Current geometry conflicts with min/max sizing constraints')
    }
  }
  return { pageId: index.pageId, ids: [...ids], changedIds: ids.filter(id => active(doc.nodes[id])) }
}
export function applyLayoutRemove(doc: DesignDocument, plan: LayoutRemovePlan) {
  for (const id of plan.changedIds) {
    const n = doc.nodes[id]
    const layout = n.layout!
    delete n.layout
    n.sizing = { ...defaultSizing(), ...n.sizing, width: 'fixed', height: 'fixed' }
    for (const childId of n.children) {
      const child = doc.nodes[childId]
      if (child.sizing) {
        const sizing = child.sizing
        const stretched = child.visible && !sizing.absolute && (sizing.alignSelf ?? layout.align) === 'stretch'
        // Parent stretch may override a hug axis (including intrinsic text).
        // Freeze only the axis actually assigned by that parent, not all hug.
        // Match native fit_axis: a near-zero axis coefficient skips resize.
        const widthAssigned = stretched && Math.abs(child.transform[0]) > 1e-9 && (layout.mode === 'vertical' || layout.mode === 'grid')
        const heightAssigned = stretched && Math.abs(child.transform[3]) > 1e-9 && (layout.mode === 'horizontal' || layout.mode === 'grid')
        child.sizing = { ...sizing,
          width: sizing.width === 'fill' || (widthAssigned && sizing.width === 'hug') ? 'fixed' : sizing.width,
          height: sizing.height === 'fill' || (heightAssigned && sizing.height === 'hug') ? 'fixed' : sizing.height }
      }
      if (child.constraints) child.constraints = { ...child.constraints, referenceWidth: n.width, referenceHeight: n.height }
    }
  }
}
