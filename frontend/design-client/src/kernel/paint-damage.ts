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

/** Physical demand for an ordinary, same-camera SDR presentation. Round both
 * edges out and include the neighbours used by integer-centre sampling. */
export function viewportDamage(damage: PaintDamage, view: { x:number; y:number; zoom:number }, width:number, height:number) {
  if (damage.full || !(view.zoom > 0) || ![view.x, view.y, view.zoom].every(Number.isFinite) ||
      ![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > 4_194_304) return
  const rects = paintDamageRects(damage)
  if (!rects.length || rects.length > 32) return
  let left = width, top = height, right = 0, bottom = 0
  for (const [x,y,w,h] of rects) {
    if (![x,y,w,h].every(Number.isFinite) || w < 0 || h < 0) return
    left = Math.min(left, Math.max(0, Math.floor(x * view.zoom + view.x) - 2))
    top = Math.min(top, Math.max(0, Math.floor(y * view.zoom + view.y) - 2))
    right = Math.max(right, Math.min(width, Math.ceil((x+w) * view.zoom + view.x) + 2))
    bottom = Math.max(bottom, Math.min(height, Math.ceil((y+h) * view.zoom + view.y) + 2))
  }
  const w = right - left, h = bottom - top
  if (w <= 0 || h <= 0 || w*h > width*height*.75) return
  return { x:left, y:top, w, h }
}
