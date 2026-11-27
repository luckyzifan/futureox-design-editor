import type { Editor } from './engine'
import { apply, inverse } from './geometry'
import { uid, type DesignDocument, type DesignNode, type Edge, type Network, type Point } from './model'
import type { PrototypeAction } from './prototype'

/** Open endpoints are vertices with degree one. A network with exactly two
 * endpoints is one open path; more endpoints means multiple open subpaths and
 * the single-path Close Path command must not guess which ends to join. */
function openEndpoints(network: Network) {
  const degree = new Map<string, number>()
  for (const edge of network.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return network.vertices.filter(vertex => (degree.get(vertex.id) ?? 0) === 1)
}

function pathNode(doc: DesignDocument, selection: readonly string[]): DesignNode | undefined {
  return selection.length === 1 ? doc.nodes[selection[0]] : undefined
}

export function closeablePath(doc: DesignDocument, selection: readonly string[]): boolean {
  const node = pathNode(doc, selection)
  if (!node || node.kind !== 'vector' || !node.network?.edges.length) return false
  const endpoints = openEndpoints(node.network)
  if (endpoints.length !== 2) return false
  const [a, b] = endpoints
  return !node.network.edges.some(edge =>
    (edge.from === a.id && edge.to === b.id) || (edge.from === b.id && edge.to === a.id))
}

export function reversiblePath(doc: DesignDocument, selection: readonly string[]): boolean {
  const node = pathNode(doc, selection)
  return !!node && node.kind === 'vector' && !!node.network?.edges.length
}

export function canCloseSelectionPath(editor: Editor): boolean {
  return closeablePath(editor.state.doc, editor.topSelection())
}

export function canReverseSelectionPath(editor: Editor): boolean {
  return reversiblePath(editor.state.doc, editor.topSelection())
}

/** Sketch Path > Close Path: join the two open ends with one straight edge. */
export function closeSelectionPath(editor: Editor): boolean {
  if (editor.state.busy || editor.interactionActive) return false
  const ids = editor.topSelection()
  if (!closeablePath(editor.state.doc, ids)) return false
  const network = editor.state.doc.nodes[ids[0]].network!
  const [a, b] = openEndpoints(network)
  // Continue a directed contour from its last vertex back to its first.
  const incoming = (id: string) => network.edges.some(edge => edge.to === id)
  const [from, to] = !incoming(a.id) && incoming(b.id) ? [b, a] : [a, b]
  const before = editor.state.doc
  editor.update(ids, n => {
    if (!n.network) return
    n.network.edges.push({ id: uid(), from: from.id, to: to.id })
  }, '闭合路径')
  return editor.state.doc !== before
}

/** Sketch Path > Reverse Order: swap each edge direction and walk the path
 * from the other end. Handles and filled faces keep their authored identity. */
export function reverseSelectionPath(editor: Editor): boolean {
  if (editor.state.busy || editor.interactionActive) return false
  const ids = editor.topSelection()
  if (!reversiblePath(editor.state.doc, ids)) return false
  const before = editor.state.doc
  editor.update(ids, n => {
    if (!n.network?.edges.length) return
    n.network.edges = reverseEdges(n.network.edges)
  }, '反转路径方向')
  return editor.state.doc !== before
}

function reverseEdges(edges: readonly Edge[]) {
  return [...edges].reverse().map(edge => ({ ...edge, from: edge.to, to: edge.from, c1: edge.c2, c2: edge.c1 }))
}

function directedChain(network: Network) {
  if (!network.edges.length || network.filledFaces?.length || network.vertices.length !== network.edges.length + 1)
    return
  const outgoing = new Map(network.edges.map(edge => [edge.from, edge]))
  const incoming = new Set(network.edges.map(edge => edge.to))
  if (outgoing.size !== network.edges.length || incoming.size !== network.edges.length) return
  const starts = network.vertices.filter(vertex => !incoming.has(vertex.id))
  if (starts.length !== 1) return
  const start = starts[0], edges: Edge[] = []
  let id = start.id
  while (outgoing.has(id) && edges.length < network.edges.length) {
    const edge = outgoing.get(id)!
    edges.push(edge)
    id = edge.to
  }
  const end = network.vertices.find(vertex => vertex.id === id)
  if (end && edges.length === network.edges.length && !outgoing.has(id)) return { start, end, edges }
}

function plainPathStroke(layer: DesignNode) {
  if (layer.kind !== 'vector' || !layer.network || !layer.visible || layer.opacity !== 1 || layer.blend !== 'normal' ||
      layer.children.length || layer.fills.length || layer.effects.length || layer.mask || layer.maskChain || layer.clip ||
      layer.component || layer.instance || layer.instanceOrigin || layer.connector || layer.repeat || layer.spatial ||
      layer.vectorGeometry || layer.vectorBrush || layer.pathOffset !== undefined || layer.sizing || layer.constraints ||
      layer.cornerRadius !== undefined || layer.radii.some(radius => radius !== 0) || layer.smoothing !== 0 ||
      Object.keys(layer.bindings ?? {}).length || Object.keys(layer.styleRefs ?? {}).length ||
      Object.keys(layer.variableModes ?? {}).length)
    return
  const [stroke] = layer.strokes
  if (layer.strokes.length !== 1 || !stroke.visible || stroke.width <= 0 || stroke.align !== 'center' ||
      stroke.dash.trim() || stroke.widthProfile?.length ||
      (stroke.startMarker && stroke.startMarker !== 'none') || (stroke.endMarker && stroke.endMarker !== 'none') ||
      stroke.paint.kind !== 'solid' || !stroke.paint.visible || stroke.paint.opacity !== 1 || stroke.paint.blend !== 'normal' ||
      !/^#[0-9a-f]{6}(?:ff)?$/i.test(stroke.paint.color))
    return
  return stroke
}

function hasPathAttachments(doc: DesignDocument, ids: readonly string[]) {
  const selected = new Set(ids)
  const hasId = (id?: string) => id !== undefined && selected.has(id)
  const hasTarget = (actions: PrototypeAction[]): boolean => actions.some(action =>
    (['navigate', 'overlay', 'scroll-to'].includes(action.kind) && hasId(action.target)) ||
    hasTarget(action.thenActions ?? []) || hasTarget(action.elseActions ?? []))
  const metadata = doc.designSystem?.sketchContainers?.nodeMetadata as Record<string, unknown> | undefined
  return ids.some(id => metadata?.[id] != null || doc.designSystem?.fontSources?.[id] != null) ||
    doc.reviews?.some(review => hasId(review.nodeId)) ||
    doc.animations?.some(clip => clip.tracks.some(track => hasId(track.nodeId))) ||
    hasId(doc.prototype?.startNode) ||
    Object.entries(doc.prototype?.interactions ?? {}).some(([id, events]) =>
      hasId(id) || events.some(event => hasTarget(event.actions))) ||
    Object.values(doc.nodes).some(node => hasId(node.connector?.from.nodeId) || hasId(node.connector?.to.nodeId))
}

function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y
}

function planJoin(editor: Editor) {
  if (editor.state.busy || editor.interactionActive || editor.state.tool !== 'select' || editor.state.selection.length !== 2)
    return
  const ids = editor.topSelection()
  if (ids.length !== 2 || ids[0] === ids[1]) return
  const { doc, page } = editor.state, parents = editor.parentMap()
  const parentId = parents.get(ids[0])
  if (!parentId || parentId !== parents.get(ids[1])) return
  const parent = doc.nodes[parentId]
  if (parent?.layout && parent.layout.mode !== 'none') return
  let owner: string | undefined = parentId
  while (owner && doc.nodes[owner]) {
    const layer = doc.nodes[owner]
    if (!layer.visible || layer.component || layer.componentSet || layer.instance || layer.instanceOrigin ||
        layer.repeat || layer.spatial || layer.booleanOperation)
      return
    owner = parents.get(owner)
  }
  if (owner !== page) return
  const siblings = parent?.children ?? doc.pages.find(item => item.id === page)?.children
  if (!siblings) return
  const [first, second] = ids.map(id => siblings.indexOf(id))
  // Keep the two operands in the same paint slot relative to other layers.
  if (first < 0 || second < 0 || Math.abs(first - second) !== 1) return
  const bottom = doc.nodes[siblings[Math.min(first, second)]], top = doc.nodes[siblings[Math.max(first, second)]]
  const lowerStroke = plainPathStroke(bottom), upperStroke = plainPathStroke(top)
  if (!lowerStroke || !upperStroke || top.exportSettings?.length || lowerStroke.width !== upperStroke.width ||
      lowerStroke.cap !== upperStroke.cap || lowerStroke.join !== upperStroke.join ||
      (lowerStroke.miterLimit ?? 4) !== (upperStroke.miterLimit ?? 4) || lowerStroke.paint.color !== upperStroke.paint.color)
    return
  const [a, b, c, d, x, y] = bottom.transform
  if (!bottom.transform.slice(0, 4).every((value, index) => value === top.transform[index])) return
  const lower = directedChain(bottom.network!), upper = directedChain(top.network!)
  if (!lower || !upper || bottom.network!.vertices.length + top.network!.vertices.length - 1 > 10000) return
  const offset = apply(inverse([a, b, c, d, 0, 0]), { x: top.transform[4] - x, y: top.transform[5] - y })
  const shift = (point: Point): Point => ({ x: point.x + offset.x, y: point.y + offset.y })
  const matches = [lower.start, lower.end].flatMap(from =>
    [upper.start, upper.end].filter(to => samePoint(from, shift(to))).map(to => ({ from, to })))
  if (matches.length !== 1) return
  const handles = upper.edges.flatMap(edge => [edge.c1, edge.c2].filter((point): point is Point => point !== undefined))
  const points = [...top.network!.vertices, ...handles]
  // Compare both control handles and anchors in the common parent space.
  if (points.some(point => !samePoint(apply(bottom.transform, shift(point)), apply(top.transform, point))) ||
      hasPathAttachments(doc, ids))
    return
  return { parentId, page, bottom, top, lower, upper, shift, match: matches[0] }
}

export function canJoinSelectionPaths(editor: Editor): boolean {
  return !!planJoin(editor)
}

function unusedId(id: string, used: Set<string>) {
  while (used.has(id)) id = uid()
  used.add(id)
  return id
}

export function joinSelectionPaths(editor: Editor): boolean {
  const plan = planJoin(editor)
  if (!plan) return false
  const { bottom, top, lower, upper, match, shift, parentId, page } = plan
  const lowerNetwork = bottom.network!, upperNetwork = top.network!
  const joinedVertices = [...lowerNetwork.vertices]
  const vertexIds = new Set(joinedVertices.map(vertex => vertex.id))
  const remapped = new Map([[match.to.id, match.from.id]])
  const curveModes = { ...lowerNetwork.curveModes }
  for (const vertex of upperNetwork.vertices) {
    if (vertex.id === match.to.id) continue
    const id = unusedId(vertex.id, vertexIds)
    remapped.set(vertex.id, id)
    joinedVertices.push({ id, ...shift(vertex) })
    const mode = upperNetwork.curveModes?.[vertex.id]
    if (mode) curveModes[id] = mode
  }
  const append = match.from.id === lower.end.id
  const reverse = append ? match.to.id === upper.end.id : match.to.id === upper.start.id
  const edgeIds = new Set(lower.edges.map(edge => edge.id))
  const mapped = (reverse ? reverseEdges(upper.edges) : upper.edges).map(edge => ({
    id: unusedId(edge.id, edgeIds), from: remapped.get(edge.from)!, to: remapped.get(edge.to)!,
    ...(edge.c1 ? { c1: shift(edge.c1) } : {}), ...(edge.c2 ? { c2: shift(edge.c2) } : {}),
  }))
  const network: Network = {
    ...lowerNetwork, vertices: joinedVertices, edges: append ? [...lower.edges, ...mapped] : [...mapped, ...lower.edges],
    ...(Object.keys(curveModes).length ? { curveModes } : {}),
  }
  const result = editor.change('连接路径', doc => {
    const siblings = doc.nodes[parentId]?.children ?? doc.pages.find(item => item.id === page)!.children
    doc.nodes[bottom.id].network = network
    siblings.splice(siblings.indexOf(top.id), 1)
    delete doc.nodes[top.id]
  }, [bottom.id])
  return result.status === 'committed'
}
