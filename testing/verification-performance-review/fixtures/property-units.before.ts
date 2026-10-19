import type { DesignDocument, Matrix } from './model'
import { allParents, worldMatrix } from './geometry'

function axis(m: Matrix) { return { x: Math.hypot(m[0], m[1]), y: Math.hypot(m[2], m[3]) } }
function materialScale(m: Matrix) {
  const [a, b, c, d] = m, x = a * a + b * b, y = c * c + d * d
  // Similarities have equal orthogonal axes. Avoid the cancellation in the
  // singular-value discriminant for this common rotation/Scale case.
  if (x === y && a * c + b * d === 0) return Math.hypot(a, b)
  const s = x + y, det = a * d - b * c
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) * .5)
}
/** Inspector units only: never rewrite a node just to display its properties. */
export function propertyUnits(doc: DesignDocument, id: string) {
  const parents = allParents(doc), parent = worldMatrix(doc, parents.get(id)!, parents), world = worldMatrix(doc, id, parents)
  const own = axis(doc.nodes[id].transform), global = axis(world), p = axis(parent)
  return { parentX: p.x, parentY: p.y, width: global.x / own.x, height: global.y / own.y,
    x: global.x, y: global.y, style: materialScale(world) }
}
export function dashInUnits(text: string, factor: number): string {
  if (!text.trim()) return ''
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean)
  if (tokens.some(token => !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token) || Number(token) < 0 || !Number.isFinite(Number(token) * factor))) throw Error('虚线参数无效')
  return factor === 1 ? text : tokens.map(token => String(Number(token) * factor)).join(' ')
}
