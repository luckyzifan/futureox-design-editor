import { figReceipt } from './fig-document'
import type { AutoLayout, DesignDocument, StackingOrder } from './model'

export function usesFigmaLayerFlow(doc: DesignDocument, figmaInterface = false) {
  return figmaInterface || figReceipt(doc)?.source === 'figma'
}

type LayerOrder = { layout?: Pick<AutoLayout, 'mode' | 'reverseFlow' | 'stackingOrder'> | null }

export function stackOrder(layout: Pick<AutoLayout, 'reverseFlow' | 'stackingOrder'>): StackingOrder {
  return layout.stackingOrder ?? (layout.reverseFlow ? 'first-on-top' : 'last-on-top')
}

/** Whether storage order already matches the layer list. Figma stacks
 * display their layout flow, with the same direction as the layout kernel. */
export function layerFlowOrder(node: LayerOrder | undefined, figmaFlow = false) {
  const layout = node?.layout
  if (!layout || layout.mode === 'none') return false
  if (layout.mode === 'grid') return true
  return figmaFlow ? stackOrder(layout) === 'last-on-top' : !layout.stackingOrder && !layout.reverseFlow
}

export function displayedLayerChildren<T>(node: LayerOrder | undefined, children: readonly T[], figmaFlow = false): T[] {
  return layerFlowOrder(node, figmaFlow) ? [...children] : [...children].reverse()
}
