import { cloneValue } from '../draft'
import { node, type DesignDocument, type DesignNode } from '../model'
import { indexSelection, assertUnlocked, assertStructuralParent, prepareSelectionWrap, configureSelectionWrapper,
  applySelectionWrap, SelectionCommandError, type SelectionGeometryState, type SelectionWrap } from './selection-command'

export type LiveBooleanOperation = 'union' | 'subtract' | 'intersect' | 'exclude'
/** Internal admission policy, never an editor preference or authority grant.
 * existing-fill preserves the historical UI route (including its limitations).
 * verified-fill admits only proven fill geometry; it is not full Figma/Sketch parity. */
export type BooleanAdmissionPolicy = 'existing-fill' | 'verified-fill'
export interface BooleanCreateOptions { operation: LiveBooleanOperation; id?: string; name?: string }
export interface BooleanCreatePlan { wrap: SelectionWrap; wrapper: DesignNode; policy: BooleanAdmissionPolicy; styleSourceId: string }
const reject = (code: string, message: string): never => { throw new SelectionCommandError(code, message) }
function commonAdmission(doc: DesignDocument, ids: readonly string[]) {
  if (ids.length < 2 || ids.length > 64 || new Set(ids).size !== ids.length)
    reject('invalid_params', 'Live boolean creation requires 2–64 unique operands')
  const index = indexSelection(doc, ids)
  if (index.ids.length !== ids.length) reject('invalid_params', 'Select distinct operands, not an operand and its descendant')
  let count = 0
  const visit = (id: string) => {
    if (++count > 10000) reject('request_budget', 'Boolean operand subtree exceeds 10000 nodes')
    const n = doc.nodes[id]
    assertUnlocked(doc, id, index.parents); assertStructuralParent(doc, id, index.parents)
    if (n.component || n.componentSet) reject('instance_structure', 'Component operands require a dedicated boolean command')
    if (!['rectangle', 'ellipse', 'polygon', 'star', 'vector'].includes(n.kind) || (n.children.length && !n.booleanOperation))
      reject('unsupported_boolean_operand', 'verified-fill supports closed shapes, vectors and nested live booleans; text, frames and Symbols are not yet supported')
    if (n.mask || n.maskType || n.repeat || n.vectorBrush || n.pathOffset || n.textPath || n.connector || n.board || n.bindings || n.styleRefs || n.variableModes || n.layout || n.constraints || (n.sizing && (n.sizing.width !== 'fixed' || n.sizing.height !== 'fixed')))
      reject('unsupported_boolean_operand', 'Masks, repeated, bound and dependent operand geometry require a dedicated boolean command')
    if (n.strokes.some(s => s.visible && s.width > 0))
      reject('unsupported_boolean_stroke', 'Native live booleans currently use fill geometry only; outline visible strokes first')
    if (!n.fills.some(p => p.visible)) reject('unsupported_boolean_operand', 'verified-fill requires a visible operand fill')
    if (!n.transform.every(Number.isFinite) || Math.abs(n.transform[0] * n.transform[3] - n.transform[1] * n.transform[2]) < 1e-12)
      reject('unsupported_transform', 'Boolean operand transforms must be finite and invertible')
    if (n.kind === 'vector' && !n.booleanOperation) {
      const g = n.network
      if (!g || !g.edges.length) reject('unsupported_boolean_operand', 'Vector operands require a nonempty closed network')
      const degrees = new Map<string, number>()
      for (const e of g!.edges) { degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1); degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1) }
      if ([...degrees.values()].some(degree => degree !== 2)) reject('unsupported_boolean_operand', 'Open or branching vector networks are not supported by verified-fill')
    }
    for (const child of n.children) visit(child)
  }
  for (const id of index.ids) visit(id)
  for (let at = index.parents.get(index.ids[0]); at && doc.nodes[at]; at = index.parents.get(at)) {
    const n = doc.nodes[at]
    // An auto-layout ancestor is a normal Figma parent: the boolean becomes
    // one fixed flow item and the layout pass reflows. Masks, components and
    // nested booleans still need their own command.
    if (n.mask || n.booleanOperation || n.repeat || n.bindings || n.styleRefs || n.variableModes || n.component || n.componentSet)
      reject('unsupported_boolean_context', 'Derived or masked ancestors require a dedicated boolean command')
  }
  const parent = index.parents.get(index.ids[0])!, siblings = doc.nodes[parent]?.children ?? doc.pages.find(p => p.id === parent)!.children
  if (siblings.some(id => doc.nodes[id].mask)) reject('unsupported_boolean_context', 'Mask sibling scopes must be resolved before boolean grouping')
  return index
}
/** Plan only: native normalization remains the sole owner of result geometry. */
export function prepareBooleanCreate(doc: DesignDocument, ids: readonly string[], options: BooleanCreateOptions, state: SelectionGeometryState, policy: BooleanAdmissionPolicy): BooleanCreatePlan {
  if (!['existing-fill', 'verified-fill'].includes(policy) || !['union', 'subtract', 'intersect', 'exclude'].includes(options.operation))
    reject('invalid_params', 'Invalid boolean operation or policy')
  const index = policy === 'verified-fill' ? commonAdmission(doc, ids) : undefined
  // Figma places the boolean where the front-most selected sibling was, including
  // inside an auto-layout parent. Ordinary grouping keeps the back-most slot.
  const wrap = prepareSelectionWrap(doc, ids, state, index, { allowLayoutParent: true, stack: 'front' })
  const wrapper = node('vector', 0, 0, wrap.width, wrap.height)
  if (options.id !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.id)) reject('invalid_params', 'Boolean identifiers must be UUIDs')
    wrapper.id = options.id
  }
  if (Object.hasOwn(doc.nodes, wrapper.id) || doc.pages.some(p => p.id === wrapper.id)) reject('duplicate_id', 'Boolean identifier already exists')
  if (options.name !== undefined && (!options.name.trim() || options.name.length > 200)) reject('invalid_params', 'Boolean name must contain 1–200 characters')
  configureSelectionWrapper(wrapper, wrap)
  wrapper.name = options.name ?? ({ union: '联集', subtract: '减去', intersect: '交集', exclude: '排除' } as const)[options.operation]
  wrapper.booleanOperation = options.operation; wrapper.blend = 'normal'
  // Scene children are bottom-to-top. Subtract is bottom minus all upper operands.
  const styleSourceId = policy === 'existing-fill' || options.operation === 'subtract' ? wrap.ids[0] : wrap.ids[wrap.ids.length - 1]
  const source = doc.nodes[styleSourceId]
  wrapper.fills = cloneValue(source.fills); wrapper.strokes = cloneValue(source.strokes)
  if (policy === 'verified-fill') wrapper.effects = cloneValue(source.effects)
  return { wrap, wrapper, policy, styleSourceId }
}
export function applyBooleanCreate(doc: DesignDocument, plan: BooleanCreatePlan): void {
  applySelectionWrap(doc, plan.wrap, plan.wrapper)
  // The boolean group is not an auto-layout frame. Freeze fill/hug on the
  // operands so their sizes stay the ones measured at the merge.
  for (const id of plan.wrap.ids) {
    const child = doc.nodes[id]
    if (child.sizing && (child.sizing.width !== 'fixed' || child.sizing.height !== 'fixed'))
      child.sizing = { ...child.sizing, width: 'fixed', height: 'fixed' }
  }
}
