/** Figma shows freeform children front-to-back (storage is back-to-front).
 * Auto-layout children read in flow order: the first child is the top row. */
export function layerFlowOrder(node: { layout?: { mode: string; reverseFlow?: boolean } | null } | undefined) {
  const layout = node?.layout
  return !!layout && layout.mode !== 'none' && (layout.mode === 'grid' || !layout.reverseFlow)
}

export function displayedLayerChildren<T>(node: { layout?: { mode: string; reverseFlow?: boolean } | null } | undefined, children: readonly T[]): T[] {
  return layerFlowOrder(node) ? [...children] : [...children].reverse()
}
