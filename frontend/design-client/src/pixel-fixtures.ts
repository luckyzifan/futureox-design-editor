import { blank, node, paint, stroke, type DesignDocument } from './model'
import type { KernelOptions } from './kernel/client'
export type PixelCase = {
  name: string
  document: DesignDocument
  options: KernelOptions
  bounds: [number, number, number, number]
}
export function pixelCases(): PixelCase[] {
  const result: PixelCase[] = []
  const rect = (name: string, x: number, y: number, w: number, h: number, zoom = 1, offset = 0) => {
    const d = blank(name),
      n = node('rectangle', x, y, w, h)
    n.fills = [paint('#000000')]
    d.nodes[n.id] = n
    d.pages[0].children = [n.id]
    result.push({
      name,
      document: d,
      options: {
        pageId: d.pages[0].id,
        width: 80,
        height: 80,
        view: { x: offset, y: offset, zoom },
        transparent: true,
        grid: false,
      },
      bounds: [
        x * zoom + offset,
        y * zoom + offset,
        (x + w) * zoom + offset,
        (y + h) * zoom + offset,
      ],
    })
  }
  rect('整数边界 1px 竖线', 8, 8, 1, 32)
  rect('整数边界 1px 横线', 8, 8, 32, 1)
  rect('半像素矩形', 8.5, 8.5, 20, 12)
  rect('四分之一像素', 8.25, 8.25, 1, 16)
  rect('八分之一像素', 8.125, 8.125, 1, 16)
  rect('任意小数像素', 8.1, 8.3, 20.4, 12.6)
  rect('125% 缩放', 8, 8, 1, 24, 1.25)
  rect('高密度 2x', 8.125, 8.125, 1, 16, 2)
  rect('小数平移', 8, 8, 20, 12, 1, 0.1)
  for (const y of [8, 8.5]) {
    const d = blank(`居中 1px 描边 y=${y}`),
      n = node('vector', 8, y, 32, 1)
    n.network = {
      fillRule: 'nonzero',
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 32, y: 0 },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b' }],
    }
    n.fills = []
    n.strokes = [{ ...stroke('#000000', 1), cap: 'butt' }]
    d.nodes[n.id] = n
    d.pages[0].children = [n.id]
    result.push({
      name: d.name,
      document: d,
      options: {
        pageId: d.pages[0].id,
        width: 80,
        height: 80,
        view: { x: 0, y: 0, zoom: 1 },
        transparent: true,
        grid: false,
      },
      bounds: [8, y - 0.5, 40, y + 0.5],
    })
  }
  return result
}
export function expectedCoverage(bounds: PixelCase['bounds'], x: number, y: number) {
  const [x0, y0, x1, y1] = bounds
  return (
    Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) *
    Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0))
  )
}
