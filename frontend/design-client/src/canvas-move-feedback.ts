import type { Point, Matrix } from './model'

/** Feedback lives in world-coordinate SVG groups. Titles get a translation
 * wrapper so moving them never overwrites their authored matrix transform. */
export function moveCanvasFeedback(host: ParentNode, ids: readonly string[], offset: Point & { matrix?: Matrix },
  originals: Map<SVGElement, string>) {
  const moving = new Set(ids)
  for (const element of host.querySelectorAll<SVGElement>(
    '[data-testid="canvas-selection-outline"],[data-testid^="resize-"],[data-testid^="rotate-"],[data-testid="rotation-origin"],[data-frame-title-owner]',
  )) {
    const owner = element.getAttribute('data-frame-title-owner')
    if (owner && !moving.has(owner)) continue
    if (!originals.has(element)) originals.set(element, element.style.transform)
    element.style.transform = offset.matrix ? `matrix(${offset.matrix.join(',')})` : `translate(${offset.x}px,${offset.y}px)`
  }
}
