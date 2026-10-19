import type { DesignNode, Network } from './model'
import { toNetwork } from './geometry'
import { kernelSvgPaths } from './kernel/picking'
import { pathNetwork } from './path-network'

/** Tangent-matched quarter-ellipse cubic control length. This editing draft is
 * an approximation; the unedited authored ellipse must keep its native Arc. */
export const ELLIPSE_EDIT_KAPPA = (4 / 3) * Math.tan(Math.PI / 8)

/** A detached editing overlay. Calling this never converts the document node.
 * Stable primitive vertex IDs keep pointer/handle ownership across rerenders. */
export function editableNetwork(source: DesignNode): Network {
  if (source.network) return structuredClone(source.network)
  const vertexId = (index: number) => `${source.id}:edit:v${index}`
  const edgeId = (index: number) => `${source.id}:edit:e${index}`
  if (source.kind === 'ellipse' && !source.arc) {
    const rx = source.width / 2, ry = source.height / 2
    const kx = rx * ELLIPSE_EDIT_KAPPA, ky = ry * ELLIPSE_EDIT_KAPPA
    return {
      vertices: [
        { id: vertexId(0), x: source.width, y: ry },
        { id: vertexId(1), x: rx, y: source.height },
        { id: vertexId(2), x: 0, y: ry },
        { id: vertexId(3), x: rx, y: 0 },
      ],
      edges: [
        { id: edgeId(0), from: vertexId(0), to: vertexId(1), c1: { x: source.width, y: ry + ky }, c2: { x: rx + kx, y: source.height } },
        { id: edgeId(1), from: vertexId(1), to: vertexId(2), c1: { x: rx - kx, y: source.height }, c2: { x: 0, y: ry + ky } },
        { id: edgeId(2), from: vertexId(2), to: vertexId(3), c1: { x: 0, y: ry - ky }, c2: { x: rx - kx, y: 0 } },
        { id: edgeId(3), from: vertexId(3), to: vertexId(0), c1: { x: rx + kx, y: 0 }, c2: { x: source.width, y: ry - ky } },
      ],
      fillRule: 'evenodd',
    }
  }
  const paths = source.arc || source.cornerRadius ? kernelSvgPaths(source) : null
  if ((source.arc || source.cornerRadius) && !paths) throw new Error('参数化图形需要已就绪的矢量内核')
  // An explicitly edited vector uses cubic control points. Until the first real
  // vector edit the retained native arc remains authoritative for every render.
  const draft = paths ? pathNetwork(paths.stroke) : toNetwork(source)
  const ids = new Map(draft.vertices.map((vertex, index) => [vertex.id, vertexId(index)]))
  return {
    vertices: draft.vertices.map((vertex, index) => ({ ...vertex, id: vertexId(index) })),
    edges: draft.edges.map((edge, index) => ({ ...edge, id: edgeId(index), from: ids.get(edge.from)!, to: ids.get(edge.to)! })),
    fillRule: draft.fillRule,
  }
}

/** Call only after a real geometry edit, within the editor's single gesture
 * transaction. Enter/Esc, selection and a motionless pointer must not call it. */
export function materializeEditableNetwork(source: DesignNode, edited: Network): DesignNode {
  const result: DesignNode = { ...structuredClone(source), kind: 'vector', network: structuredClone(edited) }
  delete result.arc
  delete result.cornerRadius
  return result
}
