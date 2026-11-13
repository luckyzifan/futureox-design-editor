/** Distance from the shell bottom that keeps the status capsule above a
 * bottom-center tool pill. The pill's own width and height stay content-sized;
 * this only reports the capsule offset from the pill that was actually rendered. */
export function figmaStatusClearance(bottomPx: number, heightPx: number, gap = 8): number {
  if (!Number.isFinite(bottomPx) || !Number.isFinite(heightPx) || heightPx <= 0 || bottomPx < 0) return 0
  return Math.ceil(bottomPx + heightPx + gap)
}
