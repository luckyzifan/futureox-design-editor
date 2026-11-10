/** One admission decision for a prepared zoom/pan tile. Callers choose whether
 * a fill-generation change is enforced and whether one already-prepared tile
 * may cover a visible gap. Cancelling this choice does not release a texture
 * that a presented frame still samples. */

export type RefinementChoice =
  | { action: 'continue' }
  | { action: 'cancel'; reason: 'aborted' | 'generation' | 'fill' }
  | { action: 'cover-gap' }

export function choosePreparedTile(input: {
  aborted: boolean
  generationCurrent: boolean
  fillCurrent: boolean
  /** Canvas fill changes cancel preview work. Interaction ignores this fence. */
  enforceFill: boolean
  channelIsCanvas: boolean
  /** Only the tile whose compilation already finished may fill a gap. */
  allowGapFill: boolean
  canFillGap: boolean
}): RefinementChoice {
  if (input.aborted) return { action: 'cancel', reason: 'aborted' }
  if (!input.generationCurrent) return { action: 'cancel', reason: 'generation' }
  if (input.enforceFill && input.channelIsCanvas && !input.fillCurrent) {
    if (input.allowGapFill && input.canFillGap) return { action: 'cover-gap' }
    return { action: 'cancel', reason: 'fill' }
  }
  return { action: 'continue' }
}

/** Exact viewport tiles own the raster batch. A page overview is a candidate
 * only after that list is empty. This does not change tile pixels or budgets. */
export function exactTilesBeforeOverview<T>(exactMissing: readonly T[], overview: readonly T[]): T[] {
  return exactMissing.length ? [...exactMissing] : [...overview]
}

/** The quiet pasteboard strip may use the raster batch only when the gesture
 * has stopped and this camera's exact tiles are already cached. Invalid
 * counts refuse it. Cached tiles are not dropped by this decision. */
export function quietPasteStripAllowed(input: {
  moving: boolean
  continuousZoom: boolean
  exactMissing: number
}) {
  if (input.moving || input.continuousZoom) return false
  if (!Number.isSafeInteger(input.exactMissing) || input.exactMissing < 0) return false
  return input.exactMissing === 0
}
