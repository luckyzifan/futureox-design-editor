import type { AutoLayout, StackingOrder } from './model'

type LayerOrder = { layout?: Pick<AutoLayout, 'mode' | 'reverseFlow' | 'stackingOrder'> | null }

export function stackOrder(layout: Pick<AutoLayout, 'reverseFlow' | 'stackingOrder'>): StackingOrder {
  return layout.stackingOrder ?? (layout.reverseFlow ? 'first-on-top' : 'last-on-top')
}

/** Freeform and stacks with an explicit stacking order show the frontmost
 * layer at the top. Other auto-layout rows follow flow order. */
export function layerFlowOrder(node: LayerOrder | undefined) {
  const layout = node?.layout
  return !!layout && layout.mode !== 'none' && (layout.mode === 'grid' || (!layout.stackingOrder && !layout.reverseFlow))
}

export function displayedLayerChildren<T>(node: LayerOrder | undefined, children: readonly T[]): T[] {
  return layerFlowOrder(node) ? [...children] : [...children].reverse()
}
