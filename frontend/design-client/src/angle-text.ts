/** Wrap into (−180, 180]. Exactly 180° lands on −180°. Same rule as the kernel. */
export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180
  return Object.is(wrapped, -0) ? 0 : wrapped
}

/** Canvas and the right-hand angle field share this text. Two decimals, no float tail. */
export function formatAngleDegrees(degrees: number): string {
  const wrapped = normalizeDegrees(degrees)
  return (Object.is(wrapped, -0) ? 0 : Math.round(wrapped * 100) / 100).toFixed(2)
}
