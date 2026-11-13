/** Inspector readout for a blur-axis drag. The panel snapshot stays on the
 * authored tree until the canvas transaction ends; these numbers follow the
 * published preview without rebuilding that tree. */
export type LiveBlur = {
  session: number
  page: string
  documentId: string
  nodeId: string
  effectId: string
  gradient?: { start: [number, number]; end: [number, number] }
  zoomCenter?: [number, number]
}

function samePair(a: readonly [number, number] | undefined, b: readonly [number, number] | undefined) {
  if (a === b) return true
  if (!a || !b) return !a && !b
  return Object.is(a[0], b[0]) && Object.is(a[1], b[1])
}

export function sameLiveBlur(a: LiveBlur | null, b: LiveBlur | null) {
  if (a === b) return true
  if (!a || !b) return false
  return a.session === b.session && a.page === b.page && a.documentId === b.documentId
    && a.nodeId === b.nodeId && a.effectId === b.effectId
    && samePair(a.gradient?.start, b.gradient?.start) && samePair(a.gradient?.end, b.gradient?.end)
    && samePair(a.zoomCenter, b.zoomCenter)
    && !!a.gradient === !!b.gradient
}
