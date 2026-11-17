import type { DesignNode } from './model'

export type LayerPreviewShape = 'rect' | 'ellipse' | 'line' | 'text' | 'vector' | 'frame' | 'image'

const previewColorPattern = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** A cheap swatch for the Draw-mode layer row. It reads paints already on the node
 * and does not rasterize the subtree. */
export function layerPreviewSpec(node: DesignNode): { shape: LayerPreviewShape; color: string } {
  const image = node.fills.some(paint => paint.visible && paint.opacity > 0 && paint.kind === 'image')
  const fill = node.fills.find(paint => paint.visible && paint.opacity > 0 && previewColorPattern.test(paint.color))
  const stroke = node.strokes.find(item => item.paint.visible && item.paint.opacity > 0 && previewColorPattern.test(item.paint.color))
  const color = fill?.color || stroke?.paint.color || '#b7bcc6'
  const shape: LayerPreviewShape = image ? 'image'
    : node.kind === 'ellipse' ? 'ellipse'
    : node.kind === 'line' ? 'line'
    : node.kind === 'text' ? 'text'
    : node.kind === 'vector' ? 'vector'
    : node.kind === 'frame' || node.kind === 'group' || node.kind === 'section' ? 'frame'
    : 'rect'
  return { shape, color }
}
