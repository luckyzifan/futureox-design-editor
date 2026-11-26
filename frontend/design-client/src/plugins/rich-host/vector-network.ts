import type { DesignNode } from '../../model'
import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

function validateLoop(loop: number[], segments: readonly { start: number; end: number }[]) {
  if (!loop.length || new Set(loop).size !== loop.length) return false
  const first = segments[loop[0]]
  const closesFrom = (start: number) => {
    let vertex = start
    for (const index of loop) {
      const segment = segments[index]
      if (segment.start === vertex) vertex = segment.end
      else if (segment.end === vertex) vertex = segment.start
      else return false
    }
    return vertex === start
  }
  return closesFrom(first.start) || closesFrom(first.end)
}

/** Project the authored cubic graph without sampling or rebuilding paths. */
export function readVectorNetwork(node: DesignNode) {
  const network = node.network
  if (node.kind !== 'vector' || node.booleanOperation || !network)
    throw new PluginApiError('unsupported_api', 'This layer has no directly editable vector network')
  const vertexIndices = new Map(network.vertices.map(({ id }, index) => [id, index]))
  const edgeIndices = new Map(network.edges.map(({ id }, index) => [id, index]))
  const vertices = network.vertices.map(({ x, y }) => ({ x, y }))
  const segments = network.edges.map(edge => {
    const start = vertexIndices.get(edge.from), end = vertexIndices.get(edge.to)
    if (start === undefined || end === undefined) throw new PluginApiError('invalid_node', 'Vector segments must reference existing vertices')
    const tangent = (handle: { x: number; y: number }, vertex: number) => ({
      x: handle.x - vertices[vertex].x, y: handle.y - vertices[vertex].y,
    })
    return {
      start, end,
      ...(edge.c1 ? { tangentStart: tangent(edge.c1, start) } : {}),
      ...(edge.c2 ? { tangentEnd: tangent(edge.c2, end) } : {}),
    }
  })

  const faces = network.filledFaces
  // An omitted Figma region list fills all enclosed space. It cannot
  // describe an explicit selection of no faces or an implicit even-odd rule.
  if (segments.length && !faces?.length && (faces || network.fillRule === 'evenodd'))
    throw new PluginApiError('unsupported_api', 'This fill rule needs explicit vector region loops')
  const loops = faces?.map(face => {
    const loop = face.map(id => {
      const index = edgeIndices.get(id)
      if (index === undefined) throw new PluginApiError('invalid_node', 'Vector faces must reference existing segments')
      return index
    })
    if (!validateLoop(loop, segments))
      throw new PluginApiError('unsupported_api', 'Vector region needs an ordered, closed segment loop')
    return loop
  }) ?? []
  const result = { vertices, segments, regions: loops.length ? [
    { windingRule: network.fillRule === 'evenodd' ? 'EVENODD' : 'NONZERO', loops },
  ] : [] }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PLUGIN_LIMITS.payloadBytes)
    throw new PluginApiError('plugin_limit', 'Vector network exceeds the plugin payload limit')
  return result
}
