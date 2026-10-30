import type { DesignNode } from './model'

/** Sufficient proof of an empty resolved alpha mask, not pixel-alpha picking.
 * Unknown modes, paints and render sources retain the geometric fallback.
 */
export function isEmptyLeafAlphaMask(n: DesignNode): boolean {
  if (
    !n.mask ||
    (n.maskType !== undefined && n.maskType !== 'alpha') ||
    n.blend !== 'normal' ||
    n.children.length !== 0 ||
    n.strokes.length !== 0 ||
    n.effects.length !== 0
  )
    return false
  switch (n.kind) {
    case 'frame':
    case 'section':
    case 'rectangle':
    case 'ellipse':
    case 'polygon':
    case 'star':
    case 'line':
    case 'vector':
      return n.fills.every(
        (p) =>
          p.kind === 'solid' && p.blend === 'normal' && (p.visible === false || p.opacity === 0),
      )
    default:
      return false
  }
}
