import { bounds, unionBounds } from '../../commands/affine'
import { kernelBounds } from '../../kernel/picking'
import { node, type Bounds, type DesignNode, type Network, type Point } from '../../model'
import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

type Segment = { start: number; end: number }
export type FittedVectorNetwork = { network: Network; box?: Bounds }

const MAX_VERTICES = 2048
const MAX_SEGMENTS = 2048
const MAX_COORDINATE = 1e7

function validateLoop(loop: number[], segments: readonly Segment[]) {
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

function objectFields(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginApiError('invalid_value', `${label} must be an object`)
  const fields = value as Record<string, unknown>
  for (const key of Object.keys(fields))
    if (!keys.includes(key)) throw new PluginApiError('unsupported_api', `${label}.${key} is not supported`)
  return fields
}

function coordinate(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)
    throw new PluginApiError('invalid_value', `${label} must be a finite coordinate within ±${MAX_COORDINATE}`)
  return value
}

function point(value: unknown, label: string): Point {
  const { x, y } = objectFields(value, label, ['x', 'y'])
  return { x: coordinate(x, `${label}.x`), y: coordinate(y, `${label}.y`) }
}

function graphIndex(value: unknown, count: number, label: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= count)
    throw new PluginApiError('invalid_value', `${label} must reference an existing entry`)
  return value
}

function handle(value: unknown, vertex: Point, label: string): Point | undefined {
  if (value === undefined) return undefined
  const offset = point(value, label)
  if (offset.x === 0 && offset.y === 0) return undefined
  return {
    x: coordinate(vertex.x + offset.x, `${label} control x`),
    y: coordinate(vertex.y + offset.y, `${label} control y`),
  }
}

function hasCycle(segments: Segment[], vertexCount: number) {
  const parents = Array.from({ length: vertexCount }, (_, index) => index)
  const root = (index: number) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]]
      index = parents[index]
    }
    return index
  }
  for (const { start, end } of segments) {
    const a = root(start), b = root(end)
    if (a === b) return true
    parents[a] = b
  }
  return false
}

function authorFill(value: unknown, segments: Segment[], vertexCount: number): Pick<Network, 'fillRule' | 'filledFaces'> {
  if (value !== undefined && !Array.isArray(value))
    throw new PluginApiError('invalid_value', 'Vector regions must be an array')
  if (!value?.length) {
    // Implicit Figma fill covers every enclosed area. FD's implicit nonzero
    // rule can subtract enclosed areas when cycles have opposing orientations.
    if (hasCycle(segments, vertexCount))
      throw new PluginApiError('unsupported_api', 'Closed vector networks need an explicit region')
    return { fillRule: 'nonzero' }
  }
  if (value.length !== 1) throw new PluginApiError('unsupported_api', 'Only one vector region is supported')
  const { windingRule, loops } = objectFields(value[0], 'Vector region', ['windingRule', 'loops'])
  if (windingRule !== 'EVENODD' && windingRule !== 'NONZERO')
    throw new PluginApiError('invalid_value', 'Vector region windingRule must be EVENODD or NONZERO')
  if (!Array.isArray(loops) || !loops.length || !Array.isArray(loops[0]) || !loops[0].length)
    throw new PluginApiError('invalid_value', 'Vector region requires a nonempty loop')
  if (loops.length !== 1) throw new PluginApiError('unsupported_api', 'Only one loop per vector region is supported')
  if (loops[0].length > segments.length)
    throw new PluginApiError('invalid_value', 'Vector region cannot repeat segments')
  const loop = loops[0].map(index => graphIndex(index, segments.length, 'Vector loop index'))
  if (!validateLoop(loop, segments))
    throw new PluginApiError('invalid_value', 'Vector region needs an ordered, closed segment loop')

  // The kernel chooses faces from a graph by segment IDs. A degree-two ring
  // is one native face regardless of which direction the guest traced it.
  const counts = Array<number>(vertexCount).fill(0)
  for (const { start, end } of segments) { counts[start]++; counts[end]++ }
  if (loop.some(index => counts[segments[index].start] !== 2 || counts[segments[index].end] !== 2))
    throw new PluginApiError('unsupported_api', 'A filled vector loop must have no branches')
  return { fillRule: windingRule === 'EVENODD' ? 'evenodd' : 'nonzero', filledFaces: [loop.map(index => `e${index}`)] }
}

/** Convert guest indices and relative tangents to a fitted authored network. */
export function fitVectorNetwork(value: unknown): FittedVectorNetwork {
  const { vertices, segments, regions } = objectFields(value, 'Vector network', ['vertices', 'segments', 'regions'])
  if (!Array.isArray(vertices) || !Array.isArray(segments))
    throw new PluginApiError('invalid_value', 'Vector network requires vertices and segments arrays')
  if (vertices.length > MAX_VERTICES || segments.length > MAX_SEGMENTS)
    throw new PluginApiError('plugin_limit', `Vector network supports up to ${MAX_VERTICES} vertices and ${MAX_SEGMENTS} segments`)
  const anchors = vertices.map((value, index) => ({ id: `v${index}`, ...point(value, 'Vector vertex') }))
  const links: Segment[] = []
  const edges = segments.map((value, index) => {
    const segment = objectFields(value, 'Vector segment', ['start', 'end', 'tangentStart', 'tangentEnd'])
    const start = graphIndex(segment.start, anchors.length, 'Segment start')
    const end = graphIndex(segment.end, anchors.length, 'Segment end')
    links.push({ start, end })
    const from = anchors[start], to = anchors[end]
    const c1 = handle(segment.tangentStart, from, 'tangentStart')
    const c2 = handle(segment.tangentEnd, to, 'tangentEnd')
    return { id: `e${index}`, from: from.id, to: to.id, ...(c1 ? { c1 } : {}), ...(c2 ? { c2 } : {}) }
  })
  const network: Network = { vertices: anchors, edges, ...authorFill(regions, links, anchors.length) }
  if (!anchors.length) return { network }

  let box = bounds(anchors)
  if (edges.some(edge => edge.c1 || edge.c2)) {
    const shape = node('vector')
    shape.network = network
    const curves = kernelBounds(shape)
    if (!curves) throw new PluginApiError('kernel_unavailable', 'Vector kernel bounds are unavailable')
    box = unionBounds([box, curves])
  }
  if (box.width > MAX_COORDINATE || box.height > MAX_COORDINATE)
    throw new PluginApiError('invalid_value', 'Fitted vector exceeds the document size limit')
  const local = (point: Point): Point => ({
    x: coordinate(point.x - box.x, 'Fitted x'),
    y: coordinate(point.y - box.y, 'Fitted y'),
  })
  network.vertices = anchors.map(anchor => ({ id: anchor.id, ...local(anchor) }))
  network.edges = edges.map(edge => ({
    id: edge.id, from: edge.from, to: edge.to,
    ...(edge.c1 ? { c1: local(edge.c1) } : {}), ...(edge.c2 ? { c2: local(edge.c2) } : {}),
  }))
  return { network, box }
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
