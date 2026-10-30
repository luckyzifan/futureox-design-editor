/** Finite scrollbar coordinates over an unbounded world. Drag owners freeze
 * this range until release, so extending the viewport cannot move the thumb
 * away from the pointer midway through a gesture. All units are CSS pixels. */
export function canvasScrollAxis(contentStart: number, contentSize: number, camera: number, zoom: number, viewport: number) {
  const start = -camera / zoom, visible = viewport / zoom
  const margin = visible * .5
  const minimum = Math.min(contentStart - margin, start - margin)
  const maximum = Math.max(contentStart + contentSize + margin, start + visible + margin)
  const span = Math.max(visible, maximum - minimum)
  const track = Math.max(1, viewport - 20)
  const thumb = Math.min(track, Math.max(28, track * visible / span))
  const travel = Math.max(0, track - thumb)
  const range = Math.max(0, span - visible)
  const fraction = range ? Math.max(0, Math.min(1, (start - minimum) / range)) : 0
  return { minimum, range, track, thumb, travel, offset: fraction * travel, fraction }
}

export function scrollbarCamera(axis: ReturnType<typeof canvasScrollAxis>, offset: number, zoom: number) {
  const fraction = axis.travel ? Math.max(0, Math.min(1, offset / axis.travel)) : 0
  return -(axis.minimum + fraction * axis.range) * zoom
}
