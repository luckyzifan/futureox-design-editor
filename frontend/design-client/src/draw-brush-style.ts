import { paint, type DesignNode, type Network } from './model'
import { pathNetwork } from './path-network'
import type { VectorBrush } from './vector-brush'

/** Original closed contours named for the two Figma Brush families.
 * They are not measurements of the desktop Figma Heist or Bubblegum brushes. */
export type DrawBrushStyle = 'heist' | 'bubblegum'

const SOURCES: Record<DrawBrushStyle, Network> = {
  heist: stableSource('heist', 'M0 0L4 -2L16 -8L28 -5L40 -1L40 1L28 5L16 8L4 2Z'),
  bubblegum: stableSource('bubblegum', 'M0 -8C6 -8 8 -4 8 0C8 4 6 8 0 8C-6 8 -8 4 -8 0C-8 -4 -6 -8 -1 -8Z'),
}

function stableSource(style: DrawBrushStyle, data: string): Network {
  const network = pathNetwork(data)
  const ids = new Map(network.vertices.map((vertex, index) => [vertex.id, `draw-${style}-v${index}`]))
  network.vertices.forEach((vertex, index) => { vertex.id = `draw-${style}-v${index}` })
  network.edges.forEach((edge, index) => {
    edge.id = `draw-${style}-e${index}`
    edge.from = ids.get(edge.from)!
    edge.to = ids.get(edge.to)!
  })
  network.fillRule = 'nonzero'
  return network
}

export function drawBrushPresetId(brush: { mode: string; source: Network } | undefined): DrawBrushStyle | undefined {
  const id = brush?.source.vertices[0]?.id ?? ''
  if (brush?.mode === 'stretch' && id.startsWith('draw-heist-')) return 'heist'
  if (brush?.mode === 'scatter' && id.startsWith('draw-bubblegum-')) return 'bubblegum'
  return undefined
}

export function drawBrushPreset(style: DrawBrushStyle, width: number): VectorBrush {
  const source = structuredClone(SOURCES[style])
  if (style === 'heist') {
    return { source, mode: 'stretch', width, spacing: 24, seed: 1, rotation: 0, rotationVariance: 0, scaleVariance: 0, scatter: 0, followTangent: true }
  }
  return {
    source, mode: 'scatter', width,
    spacing: Math.min(1e7, Math.max(8, width * 1.2)),
    seed: 7, rotation: 0, rotationVariance: 0.45, scaleVariance: 0.28,
    scatter: Math.min(10000, width * 0.3), followTangent: true,
  }
}

export function applyDrawBrushStyle(node: DesignNode, settings: { style?: DrawBrushStyle; width: number; color: string }) {
  if (settings.style !== 'heist' && settings.style !== 'bubblegum') return
  if (node.kind !== 'vector' || !node.network) return
  node.vectorBrush = drawBrushPreset(settings.style, settings.width)
  node.network.fillRule = 'nonzero'
  node.fills = [paint(settings.color)]
  node.name = settings.style === 'heist' ? 'Heist' : 'Bubblegum'
  const stroke = node.strokes[0]
  if (!stroke) return
  stroke.width = settings.width
  stroke.visible = false
  stroke.paint = { ...stroke.paint, kind: 'solid', color: settings.color, visible: true }
  delete stroke.widthProfile
}

/** Pointer-move preview keeps the centerline stroke. The selected family is applied once, on commit. */
export function brushPreviewSettings<T extends { style?: DrawBrushStyle }>(settings: T): T {
  if (!settings.style) return settings
  const next = { ...settings }
  delete next.style
  return next
}

function scaleScatter(brush: VectorBrush, previous: number | undefined, next: number) {
  if (brush.mode !== 'scatter' || !previous || previous <= 0 || !Number.isFinite(next) || next === previous) return
  const ratio = next / previous
  brush.spacing = Math.min(1e7, Math.max(0.001, brush.spacing * ratio))
  brush.scatter = Math.min(10000, Math.max(0, brush.scatter * ratio))
}

export function reconcileDrawBrush(node: DesignNode, before: {
  strokeWidth?: number
  brushWidth?: number
  fillColor?: string
  strokeColor?: string
  preset?: DrawBrushStyle
}) {
  const preset = drawBrushPresetId(node.vectorBrush)
  if (!preset || preset !== before.preset || !node.vectorBrush) return
  const stroke = node.strokes[0]
  const brush = node.vectorBrush
  if (stroke) {
    const strokeChanged = before.strokeWidth !== undefined && stroke.width !== before.strokeWidth
    const brushChanged = before.brushWidth !== undefined && brush.width !== before.brushWidth
    if (strokeChanged && !brushChanged) {
      scaleScatter(brush, before.brushWidth ?? before.strokeWidth, stroke.width)
      brush.width = stroke.width
    } else if (brushChanged && !strokeChanged && before.brushWidth !== undefined) {
      scaleScatter(brush, before.brushWidth, brush.width)
      stroke.width = brush.width
    }
  }
  const fill = node.fills[0]
  if (fill?.kind === 'solid' && stroke?.paint.kind === 'solid') {
    const fillChanged = before.fillColor !== undefined && fill.color !== before.fillColor
    const strokeChanged = before.strokeColor !== undefined && stroke.paint.color !== before.strokeColor
    if (strokeChanged && !fillChanged) fill.color = stroke.paint.color
    else if (fillChanged && !strokeChanged) stroke.paint.color = fill.color
  }
}
