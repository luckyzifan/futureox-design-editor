import { allParents, type ParentMap } from './geometry'
import type { DesignDocument } from './model'

/** Nearest instance ancestor; the node itself counts when it is an instance. */
function instanceOwner(doc: DesignDocument, id: string, parents: ParentMap): string | undefined {
  let at: string | undefined = id
  while (at && doc.nodes[at]) {
    if (doc.nodes[at].instance) return at
    at = parents.get(at)
  }
  return undefined
}

/** Source symbol reached through an instance, or from a child of one. */
export function componentSourceId(doc: DesignDocument, id: string, parents: ParentMap = allParents(doc)): string | undefined {
  const owner = instanceOwner(doc, id, parents)
  const componentId = owner ? doc.nodes[owner]?.instance?.componentId : undefined
  return componentId && doc.nodes[componentId]?.component ? componentId : undefined
}

/** Sketch "Select Containing Symbol": the source symbol for an instance or
 * instance child, or the component master that contains a layer inside a
 * master. A master itself has no containing symbol. */
export function containingSymbolId(doc: DesignDocument, id: string, parents: ParentMap = allParents(doc)): string | undefined {
  let at: string | undefined = id
  while (at && doc.nodes[at]) {
    const node = doc.nodes[at]
    if (node.instance) {
      const componentId = node.instance.componentId
      return componentId && doc.nodes[componentId]?.component ? componentId : undefined
    }
    if (node.component) return at === id ? undefined : at
    at = parents.get(at)
  }
  return undefined
}