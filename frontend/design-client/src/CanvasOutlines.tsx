import { useLayoutEffect, useRef } from 'react'
import type { Bounds, DesignDocument, DesignNode, Point } from './model'
import type { View } from './engine'
import { scene, SpatialIndex, type SceneEntry } from './geometry'
import { kernelStrokePaths, kernelSvgPaths } from './kernel/picking'

export type OutlineScene = {
  document: DesignDocument
  index: SpatialIndex
  objectBounds: boolean
}

export function createOutlineScene(document: DesignDocument, page: string, hidden: boolean, objectBounds: boolean): OutlineScene {
  return { document, index: new SpatialIndex(scene(document, page, undefined, hidden)), objectBounds }
}

type OutlinePaths = { paths: Path2D; bounds: Path2D; fonts: DesignDocument['fonts'] }
const pathsByNode = new WeakMap<DesignNode, OutlinePaths>()

function pathsFor(document: DesignDocument, node: DesignNode): OutlinePaths {
  const cached = pathsByNode.get(node)
  if (cached && cached.fonts === document.fonts) return cached
  const paths = new Path2D(), bounds = new Path2D()
  bounds.rect(0, 0, node.width, node.height)
  if (node.kind !== 'group') {
    // Image and effect payloads do not define the local shape. Keep those bytes
    // out of the geometry call, especially on source bitmap layers.
    const geometry = { ...node, effects: [], fills: [] }
    const svg = kernelSvgPaths(geometry)
    if (svg?.fill || svg?.stroke) paths.addPath(new Path2D(svg.fill || svg.stroke))
    else if (node.kind === 'frame' || node.kind === 'section' || node.kind === 'slice') paths.addPath(bounds)
    if (node.kind !== 'text' && node.strokes.some(stroke => stroke.visible && stroke.width > 0)) {
      // The kernel computes aligned strokes, dashes and caps with the same
      // geometry as the outline-stroke operation.
      for (const contour of kernelStrokePaths(geometry)) if (contour) paths.addPath(new Path2D(contour))
    }
  }
  const result = { paths, bounds, fonts: document.fonts }
  pathsByNode.set(node, result)
  return result
}

function screenPath(source: OutlineScene, entry: SceneEntry, view: View): Path2D {
  const geometry = pathsFor(source.document, source.document.nodes[entry.id])
  const [a, b, c, d, x, y] = entry.matrix, z = view.zoom
  const matrix = new DOMMatrix([a * z, b * z, c * z, d * z, x * z + view.x, y * z + view.y])
  const path = new Path2D()
  path.addPath(geometry.paths, matrix)
  if (source.objectBounds) path.addPath(geometry.bounds, matrix)
  return path
}

let hitContext: CanvasRenderingContext2D | null | undefined
export function outlineHits(source: OutlineScene, point: Point, zoom: number): SceneEntry[] {
  hitContext ??= document.createElement('canvas').getContext('2d')
  const context = hitContext
  if (!context) return []
  context.lineWidth = 8
  const r = 4 / zoom
  const view = { x: -point.x * zoom, y: -point.y * zoom, zoom }
  return source.index.query({ x: point.x - r, y: point.y - r, width: r * 2, height: r * 2 })
    .reverse().filter(entry => context.isPointInStroke(screenPath(source, entry, view), 0, 0))
}

export function CanvasOutlines({ source, view, size, selected }: {
  source: OutlineScene
  view: View
  size: Pick<Bounds, 'width' | 'height'>
  selected: ReadonlySet<string>
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = ref.current, context = canvas?.getContext('2d', { alpha: false })
    if (!canvas || !context || size.width <= 0 || size.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.ceil(size.width * dpr), height = Math.ceil(size.height * dpr)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    // Screen-space paths keep lines one CSS pixel wide, across zoom and skew.
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, size.width, size.height)
    context.lineWidth = 1
    const { x, y, zoom } = view
    const entries = source.index.query({ x: -x / zoom, y: -y / zoom, width: size.width / zoom, height: size.height / zoom })
    for (const entry of entries) {
      const node = source.document.nodes[entry.id]
      const highlighted = selected.has(entry.id) || entry.ancestors.some(id => selected.has(id))
      context.strokeStyle = entry.hidden ? '#b7b7b7' :
        node.instance || node.component || node.componentSet || node.instanceOrigin ? '#9747ff' : highlighted ? '#0d99ff' : '#252525'
      context.stroke(screenPath(source, entry, view))
    }
    canvas.dataset.outlineCount = String(entries.length)
  }, [source, view.x, view.y, view.zoom, size.width, size.height, selected])

  return <canvas ref={ref} className="canvas-outlines" data-testid="canvas-outlines" aria-hidden="true" />
}
