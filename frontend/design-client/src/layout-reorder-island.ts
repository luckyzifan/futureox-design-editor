import type { DesignDocument, DesignNode } from './model'

/** A flow reorder whose layout inputs live in one ancestor island.
 * Anything that can see another page, a component, text measurement or a
 * connector stays on the full document route. */
export function sameChildOrder(current: readonly string[], next: readonly string[]): boolean {
  return current.length === next.length && next.every((id, index) => id === current[index])
}

function blocks(node: DesignNode | undefined): boolean {
  return !!node && !!(node.component || node.componentSet || node.componentKey != null || node.instance ||
    node.instanceOrigin || node.booleanOperation || node.connector || node.repeat || node.textPath || node.graphic ||
    node.kind === 'text' || (node.board?.kind === 'code-block' && node.board.language) ||
    Object.keys(node.bindings || {}).length || Object.keys(node.styleRefs || {}).length ||
    Object.keys(node.variableModes || {}).length)
}

function reflows(node: DesignNode): boolean {
  const flow = !!node.layout && node.layout.mode !== 'none'
  return flow || node.sizing?.width === 'hug' || node.sizing?.height === 'hug'
}

function pageContaining(doc: DesignDocument, parents: ReadonlyMap<string, string>, id: string): string | undefined {
  const pages = new Set(doc.pages.map(page => page.id))
  let at: string | undefined = id
  const seen = new Set<string>()
  while (at && !seen.has(at)) {
    seen.add(at)
    const parent = parents.get(at)
    if (parent && pages.has(parent)) return parent
    if (!parent) return doc.pages.find(page => page.children.includes(at!))?.id
    at = parent
  }
  return undefined
}

function connectorHitsIsland(doc: DesignDocument, parents: ReadonlyMap<string, string>, island: ReadonlySet<string>): boolean {
  for (const node of Object.values(doc.nodes)) {
    const connector = node.connector
    if (!connector) continue
    for (const endpoint of [connector.from.nodeId, connector.to.nodeId]) {
      if (!endpoint) continue
      let at: string | undefined = endpoint
      const seen = new Set<string>()
      while (at && !seen.has(at)) {
        if (island.has(at)) return true
        seen.add(at)
        at = parents.get(at)
      }
    }
  }
  return false
}

/** Document containing only the reordered frame and every layout/hug ancestor
 * that can move because of it. Undefined means the caller must solve the full
 * document. */
export function layoutFlowIsland(
  doc: DesignDocument,
  parents: ReadonlyMap<string, string>,
  frameId: string,
  nextChildren: readonly string[],
): DesignDocument | undefined {
  const frame = doc.nodes[frameId]
  if (!frame || doc.animations?.length || doc.prototype) return undefined
  if (new Set(nextChildren).size !== nextChildren.length || nextChildren.some(id => !doc.nodes[id])) return undefined
  let root = frameId
  let at = parents.get(frameId)
  const seen = new Set<string>([frameId])
  while (at && !seen.has(at)) {
    seen.add(at)
    const node = doc.nodes[at]
    if (!node) break
    if (blocks(node)) return undefined
    if (reflows(node)) root = at
    at = parents.get(at)
  }
  const pageId = pageContaining(doc, parents, root)
  if (!pageId) return undefined
  const nodes: DesignDocument['nodes'] = {}
  const visit = (id: string): boolean => {
    if (nodes[id]) return true
    const source = doc.nodes[id]
    if (!source || blocks(source)) return false
    const node = id === frameId ? { ...source, children: [...nextChildren] } : source
    nodes[id] = node
    return node.children.every(visit)
  }
  if (!visit(root) || connectorHitsIsland(doc, parents, new Set(Object.keys(nodes)))) return undefined
  return {
    ...doc,
    nodes,
    pages: doc.pages.map(page => page.id === pageId ? { ...page, children: [root] } : { ...page, children: [] }),
    designSystem: undefined,
    prototype: undefined,
    animations: undefined,
  }
}

/** Copy solved island records onto the untouched base. Nodes outside the island
 * keep their identity, so a cold page does not become a new document body. */
export function applyIslandLayout(base: DesignDocument, island: DesignDocument, resolved: DesignDocument): DesignDocument {
  let nodes = base.nodes
  const write = () => {
    if (nodes === base.nodes) nodes = { ...base.nodes }
  }
  for (const id of Object.keys(island.nodes)) {
    const next = resolved.nodes[id]
    if (!next) {
      write()
      delete nodes[id]
      continue
    }
    if (next !== base.nodes[id]) {
      write()
      nodes[id] = next
    }
  }
  return nodes === base.nodes ? base : { ...base, nodes }
}
