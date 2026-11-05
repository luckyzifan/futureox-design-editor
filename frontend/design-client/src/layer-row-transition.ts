import { layerFlowOrder } from './layer-order'
import type { DesignDocument, DesignNode } from './model'

// A constant-size, weakly owned certificate of an already computed document
// diff. No document chain, node index, or descendant arrays are retained here.
const transitions = new WeakMap<DesignDocument, {
  before: WeakRef<DesignDocument>; topology: boolean; names: boolean; flow: boolean
}>()
export function sameLayerChildren(a: readonly string[], b: readonly string[]) {
  return a === b || (a.length === b.length && a.every((id, i) => id === b[i]))
}
export function certifyLayerTransition(before: DesignDocument, after: DesignDocument, changed: Record<string, DesignNode | null>) {
  let topology = false, names = false, flow = false
  for (const id of Object.keys(changed)) {
    const a = before.nodes[id], b = after.nodes[id]
    if (!a || !b) { topology = true; names = true; flow = true; continue }
    topology ||= !sameLayerChildren(a.children, b.children)
    names ||= a.name !== b.name
    flow ||= layerFlowOrder(a) !== layerFlowOrder(b)
  }
  transitions.set(after, { before: new WeakRef(before), topology, names, flow })
}
export function layerTransition(before: DesignDocument, after: DesignDocument) {
  const value = transitions.get(after)
  return value?.before.deref() === before ? value : undefined
}
