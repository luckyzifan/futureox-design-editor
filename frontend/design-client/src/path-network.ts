import { SVGPathData } from 'svg-pathdata'
import { uid, type Network } from './model'

// Keep synchronous vector editing independent of the full SVG document importer.
export function pathNetwork(data: string): Network {
  const commands = new SVGPathData(data)
    .toAbs()
    .normalizeHVZ(false, true, true)
    .normalizeST()
    .qtToC()
    .aToC().commands
  if (commands.length > 20000) throw new Error('SVG 路径超过 20000 段')
  const g: Network = { vertices: [], edges: [], fillRule: 'nonzero' }
  let pen = '',
    start = ''
  for (const c of commands) {
    if (c.type === SVGPathData.CLOSE_PATH) {
      if (pen && pen !== start) g.edges.push({ id: uid(), from: pen, to: start })
      pen = start
      continue
    }
    if (!('x' in c) || !('y' in c)) throw new Error('不支持的 SVG 路径命令')
    const id = uid()
    g.vertices.push({ id, x: c.x, y: c.y })
    if (c.type === SVGPathData.MOVE_TO) {
      start = id
      pen = id
      continue
    }
    if (!pen) throw new Error('SVG 路径缺少起点')
    g.edges.push({
      id: uid(),
      from: pen,
      to: id,
      ...(c.type === SVGPathData.CURVE_TO
        ? { c1: { x: c.x1, y: c.y1 }, c2: { x: c.x2, y: c.y2 } }
        : {}),
    })
    pen = id
  }
  return g
}
