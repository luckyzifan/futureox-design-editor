import { cloneValue } from './draft'
import { insertInstance, remapReferences } from './components'
import { allParents, apply, inverse, multiply, worldMatrix } from './geometry'
import { identity, node, uid, type DesignDocument, type DesignNode, type Matrix } from './model'

export type GraphCopy = { nodes: Record<string, DesignNode>; roots: string[]; document: DesignDocument }
export type Duplication = { roots: string[]; ids: Map<string, string>; sourceRoots: string[]; reference: Map<string, Matrix> }

/** Copy inside one native document. Existing resource/variable references stay
 * local, copied component/interaction targets are remapped together. */
export function duplicateGraph(target: DesignDocument, content: GraphCopy,
  options: { page?: string; wrapAnimated?: boolean; transforms?: Map<string, Matrix> } = {}): Duplication {
  const source = content.document, parents = allParents(source)
  const master = content.roots.length === 1 ? source.nodes[content.roots[0]] : undefined
  const behavior = Object.keys(source.prototype?.interactions || {}).some(id => content.nodes[id]) ||
    source.animations?.some(clip => clip.tracks.some(track => content.nodes[track.nodeId]))
  // Duplicating an ordinary master creates a linked instance. A page copy or a
  // master carrying authored motion/behavior keeps its complete definition.
  if (!options.page && master?.component && !behavior) {
    const parent = parents.get(master.id)!, page = source.pages.find(page => page.children.includes(parent) || page.id === parent)
    const created = insertInstance(target, master.id, page?.id || source.pages[0].id,
      { x: 0, y: 0 }, target.nodes[parent] ? parent : undefined)
    const delta = options.transforms?.get(master.id) || identity()
    target.nodes[created].transform = delta.every((v, i) => v === identity()[i]) ? cloneValue(master.transform)
      : multiply(inverse(worldMatrix(target, parent)), multiply(delta, worldMatrix(source, master.id)))
    const list = target.nodes[parent]?.children || target.pages.find(page => page.id === parent)!.children
    list.splice(list.indexOf(created), 1); list.splice(list.indexOf(master.id) + 1, 0, created)
    return { roots: [created], ids: new Map([[master.id, created]]), sourceRoots: [master.id], reference: new Map([[created, worldMatrix(source, master.id)]]) }
  }
  const ids = new Map(Object.keys(content.nodes).map(id => [id, uid()]))
  const animated = new Set((source.animations || []).flatMap(clip => clip.tracks.map(track => track.nodeId)))
  for (const [id, value] of Object.entries(content.nodes)) {
    const copy = cloneValue(value)
    remapReferences(copy, ids, source)
    if(copy.connector)for(const endpoint of [copy.connector.from,copy.connector.to])if(endpoint.nodeId){
      const n=source.nodes[endpoint.nodeId];if(n&&endpoint.anchor)endpoint.point=apply(worldMatrix(source,n.id),{x:n.width*endpoint.anchor.x,y:n.height*endpoint.anchor.y})
      if(ids.has(endpoint.nodeId))endpoint.nodeId=ids.get(endpoint.nodeId)!
      else if(source.id!==target.id || options.page){delete endpoint.nodeId;delete endpoint.anchor}
    }
    copy.id = ids.get(id)!
    copy.children = copy.children.map(child => ids.get(child)!)
    if (copy.instanceOrigin) copy.instanceOrigin.owner = ids.get(copy.instanceOrigin.owner) || copy.instanceOrigin.owner
    // Clipboard roots are in world coordinates; an in-document duplicate keeps
    // the original parent coordinate system, including animated ancestors.
    if (content.roots.includes(id)) copy.transform = cloneValue(source.nodes[id].transform)
    target.nodes[copy.id] = copy
  }
  const roots: string[] = [], reference = new Map<string, Matrix>()
  for (const id of content.roots) {
    const copied = ids.get(id)!, original = source.nodes[id]
    const parent = options.page || parents.get(id)!
    const list = target.nodes[parent]?.children || target.pages.find(page => page.id === parent)?.children
    if (!list) throw new Error('复制目标容器不存在')
    const transform = options.transforms?.get(id) || identity()
    const unchanged = transform.every((value, i) => value === identity()[i])
    const sameParentSpace = parent === parents.get(id) ||
      (source.pages.some(page => page.id === parents.get(id)) && target.pages.some(page => page.id === parent))
    let root: string = copied
    if (animated.has(id) && (options.wrapAnimated || options.transforms?.has(id))) {
      const wrapper = node('group', 0, 0, original.width, original.height)
      wrapper.name = `${original.name} · 运动位置`.slice(0, 200)
      wrapper.fills = []; wrapper.strokes = []; wrapper.effects = []; wrapper.blend = 'pass-through'
      wrapper.children = [copied]
      wrapper.transform = unchanged && sameParentSpace ? identity() : multiply(inverse(worldMatrix(target, parent)), multiply(transform, worldMatrix(source, parents.get(id)!)))
      target.nodes[wrapper.id] = wrapper; root = wrapper.id
      reference.set(root, worldMatrix(source, parents.get(id)!))
    } else {
      target.nodes[copied].transform = unchanged && sameParentSpace ? cloneValue(original.transform)
        : multiply(inverse(worldMatrix(target, parent)), multiply(transform, worldMatrix(source, id)))
      reference.set(root, worldMatrix(source, id))
    }
    const at = options.page ? -1 : list.indexOf(id)
    list.splice(at < 0 ? list.length : at + 1, 0, root)
    roots.push(root)
  }
  if (source.prototype) {
    target.prototype ??= { interactions: {} }
    for (const [id, events] of Object.entries(source.prototype.interactions)) {
      if (!ids.has(id)) continue
      target.prototype.interactions[ids.get(id)!] = cloneValue(events).map(event => {
        for (const action of event.actions)
          if (action.target && ['navigate', 'overlay', 'scroll-to', 'change-to'].includes(action.kind))
            action.target = ids.get(action.target) || action.target
        return event
      })
    }
  }
  if (source.animations?.length) {
    target.animations ??= []
    for (const clip of source.animations) {
      const tracks = clip.tracks.filter(track => ids.has(track.nodeId)).map(track => ({ ...cloneValue(track), nodeId: ids.get(track.nodeId)! }))
      if (!tracks.length) continue
      if (options.page) target.animations.push({ ...cloneValue(clip), id: uid(), pageId: options.page, tracks })
      else target.animations.find(value => value.id === clip.id)!.tracks.push(...tracks)
    }
  }
  return { roots, ids, sourceRoots: [...content.roots], reference }
}
