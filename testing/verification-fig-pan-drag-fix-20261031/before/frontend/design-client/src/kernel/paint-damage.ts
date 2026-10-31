export type PaintRect = [number, number, number, number]
export type PaintDamage = { full: boolean; translationOnly?: boolean; bounds?: PaintRect; rects?: PaintRect[]; reason?: string }

/** Rectangles are the kernel's conservative paint certificate. The legacy
 * union remains a fallback for older kernels, never a replacement for gaps. */
export function paintDamageRects(damage: PaintDamage): PaintRect[] {
  return damage.rects ?? (damage.bounds ? [damage.bounds] : [])
}
export function paintDamageIntersects(damage: PaintDamage, bounds: PaintRect): boolean {
  return damage.full || paintDamageRects(damage).some(r =>
    bounds[0] <= r[0]+r[2] && bounds[0]+bounds[2] >= r[0] &&
    bounds[1] <= r[1]+r[3] && bounds[1]+bounds[3] >= r[1])
}
