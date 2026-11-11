import type { InteractionPoseFeedback } from './kernel/interaction-layers'

/** Feedback lives in world-coordinate SVG groups. Titles get a translation
 * wrapper so moving them never overwrites their authored matrix transform. */
export function moveCanvasFeedback(host: ParentNode, ids: readonly string[], offset: InteractionPoseFeedback,
  originals: Map<SVGElement, string>) {
  const moving = new Set(ids)
  const rotation = offset.rotationFromStart && host.querySelector('[data-selection-held="texture"]')
    ? offset.rotationFromStart : undefined
  for (const element of host.querySelectorAll<SVGElement>(
    '[data-testid="canvas-selection-outline"],[data-testid="canvas-selection-member"],[data-testid="canvas-selection-name"],[data-testid^="resize-"],[data-testid^="rotate-"],[data-testid="rotation-origin"],[data-frame-title-owner]',
  )) {
    const owner = element.getAttribute('data-frame-title-owner')
    if (owner && !moving.has(owner)) continue
    const testId = rotation ? element.getAttribute('data-testid') : null
    // Held outlines and handles still use the pointer-down geometry. Labels
    // and other live chrome use the authored pose's relative transform.
    const matrix = rotation && (testId === 'canvas-selection-outline' || testId === 'canvas-selection-member' ||
      testId?.startsWith('resize-') || testId?.startsWith('rotate-')) ? rotation : offset.matrix
    if (!originals.has(element)) originals.set(element, element.style.transform)
    element.style.transform = matrix ? `matrix(${matrix.join(',')})` : `translate(${offset.x}px,${offset.y}px)`
  }
}

export function concealCanvasFeedback(host: ParentNode, ids: readonly string[], originals: Map<SVGElement, string>) {
  const moving = new Set(ids)
  for (const element of host.querySelectorAll<SVGElement>(
    '[data-testid="canvas-selection-outline"],[data-testid="canvas-selection-name"],[data-testid^="resize-"],[data-testid^="rotate-"],[data-testid="rotation-origin"],[data-frame-title-owner]',
  )) {
    const owner = element.getAttribute('data-frame-title-owner')
    if (owner && !moving.has(owner)) continue
    if (!originals.has(element)) originals.set(element, element.style.visibility)
    element.style.visibility = 'hidden'
  }
}

export function restoreCanvasFeedbackVisibility(originals: Map<SVGElement, string>) {
  for (const [element, visibility] of originals) element.style.visibility = visibility
  originals.clear()
}
