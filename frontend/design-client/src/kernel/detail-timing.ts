/** First native region and full-viewport completion are different clocks.
 * A partial presentation must not stamp the viewport as finished. */
export type DetailClock = {
  started: number
  firstPresentMs?: number
  completeMs?: number
}

export function recordDetailClock(clock: DetailClock, event: 'present' | 'complete', now: number) {
  const elapsed = now - clock.started
  if (!Number.isFinite(elapsed) || elapsed < 0) return
  if (event === 'present') {
    if (clock.firstPresentMs === undefined) clock.firstPresentMs = elapsed
    return
  }
  if (clock.completeMs === undefined) clock.completeMs = elapsed
}
