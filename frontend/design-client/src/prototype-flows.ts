import { allParents } from './geometry'
import { uid, validFlowName, type DesignDocument } from './model'

export type PrototypeFlow = { id: string; name: string; startNode: string }

function ownerPage(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string>) {
  let parent = parents.get(id)
  while (parent && doc.nodes[parent]) parent = parents.get(parent)
  return parent
}

/** Sections and import groups can contain page-level frames. A frame within
 * another frame is an interaction source, with the outer frame as its start. */
export function outerPrototypeFrame(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string> = allParents(doc)): string | undefined {
  let current: string | undefined = id
  let outer: string | undefined
  while (current && doc.nodes[current]) {
    const node = doc.nodes[current]
    if (node.kind === 'frame' && !node.instanceOrigin) outer = current
    current = parents.get(current)
  }
  return current ? outer : undefined
}

export function prototypeFlowsOnPage(doc: DesignDocument, pageId: string): PrototypeFlow[] {
  const prototype = doc.prototype
  if (!prototype) return []
  const parents = allParents(doc)
  const flows = (prototype.flows ?? []).filter(flow => ownerPage(doc, flow.startNode, parents) === pageId)
  const legacy = prototype.startNode
  // An empty ID represents the existing single start until it is edited.
  // Authored flow IDs are always nonempty.
  if (legacy && doc.nodes[legacy]?.kind === 'frame' && !doc.nodes[legacy].instanceOrigin &&
      ownerPage(doc, legacy, parents) === pageId && !flows.some(flow => flow.startNode === legacy))
    flows.unshift({ id: '', name: 'Flow 1', startNode: legacy })
  return flows
}

export function addPrototypeFlow(doc: DesignDocument, pageId: string, startNode: string) {
  const parents = allParents(doc)
  if (doc.nodes[startNode]?.locked || ownerPage(doc, startNode, parents) !== pageId ||
      outerPrototypeFrame(doc, startNode, parents) !== startNode) throw new Error('请选择可编辑的顶层画框')
  const flows = prototypeFlowsOnPage(doc, pageId)
  if (flows.some(flow => flow.startNode === startNode)) return
  const names = new Set(flows.map(flow => flow.name))
  let sequence = 1
  while (names.has(`Flow ${sequence}`)) sequence++
  const prototype = doc.prototype ??= { interactions: {} }
  ;(prototype.flows ??= []).push({ id: uid(), name: `Flow ${sequence}`, startNode })
}

export function updatePrototypeFlow(doc: DesignDocument, pageId: string, id: string, patch: Partial<Pick<PrototypeFlow, 'name' | 'startNode'>>) {
  const flows = prototypeFlowsOnPage(doc, pageId)
  const flow = flows.find(flow => flow.id === id)
  if (!flow) throw new Error('原型流程已不存在')
  const { name = flow.name, startNode = flow.startNode } = patch
  if (!validFlowName(name) || (startNode !== flow.startNode && (
    doc.nodes[startNode]?.locked || outerPrototypeFrame(doc, startNode) !== startNode ||
    ownerPage(doc, startNode, allParents(doc)) !== pageId || flows.some(candidate => candidate.startNode === startNode)
  ))) throw new Error('无效或重复的原型起点')
  const prototype = doc.prototype!
  if (id) Object.assign(prototype.flows!.find(item => item.id === id)!, { name: name.trim(), startNode })
  else {
    ;(prototype.flows ??= []).unshift({ id: uid(), name: name.trim(), startNode })
    delete prototype.startNode
  }
}

export function removePrototypeFlow(doc: DesignDocument, pageId: string, id: string) {
  if (!prototypeFlowsOnPage(doc, pageId).some(flow => flow.id === id)) return
  const prototype = doc.prototype!
  if (!id) delete prototype.startNode
  else {
    prototype.flows = prototype.flows!.filter(flow => flow.id !== id)
    if (!prototype.flows.length) delete prototype.flows
  }
}

export function defaultPrototypeStart(doc: DesignDocument, preferred?: string, pageId?: string) {
  if (preferred !== undefined) return preferred
  const legacy = doc.prototype?.startNode
  if (pageId) {
    const first = prototypeFlowsOnPage(doc, pageId)[0]
    if (first) return first.startNode
    if (legacy && ownerPage(doc, legacy, allParents(doc)) === pageId) return legacy
    return doc.pages.find(page => page.id === pageId)?.children[0]
  }
  return legacy ?? doc.prototype?.flows?.[0]?.startNode ?? doc.pages[0]?.children[0]
}

export function invalidatedFlowStarts(before: DesignDocument, after: DesignDocument): string[] {
  return (before.prototype?.flows ?? []).flatMap(({ startNode }) => {
    const node = after.nodes[startNode]
    return node?.kind !== 'frame' || node.instanceOrigin ? [startNode] : []
  })
}
