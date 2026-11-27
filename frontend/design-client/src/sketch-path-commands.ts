import type { Editor } from './engine'
import { uid, type DesignDocument, type DesignNode, type Network } from './model'

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
    n.network.edges = [...n.network.edges].reverse().map(edge => ({
      ...edge, from: edge.to, to: edge.from, c1: edge.c2, c2: edge.c1,
    }))
  }, '反转路径方向')
  return editor.state.doc !== before
}
