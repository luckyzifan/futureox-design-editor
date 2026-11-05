/** Figma shows freeform children front-to-back (storage is back-to-front).
 * Auto-layout children read in flow order: the first child is the top row. */
export function layerFlowOrder(node: { layout?: { mode: string } | null } | undefined) {
  return !!node?.layout && node.layout.mode !== 'none'
}

export function displayedLayerChildren<T>(node: { layout?: { mode: string } | null } | undefined, children: readonly T[]): T[] {
  return layerFlowOrder(node) ? [...children] : [...children].reverse()
}
