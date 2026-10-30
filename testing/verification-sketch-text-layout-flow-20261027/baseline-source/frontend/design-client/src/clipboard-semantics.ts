import { allActions, expressionVariables } from './prototype-logic'
import { cloneValue } from './draft'
import { node, uid, type DesignDocument, type DesignNode, type Matrix, type Point } from './model'
import { allParents, multiply, translate, worldMatrix } from './geometry'
import { instanceReferences } from './components'
import type { DesignDependencyMap } from './design-system'
import type { Prototype } from './prototype'
import type { AnimationClip } from './animation'

export type ClipboardSemantics = { prototype?: Prototype; animations: AnimationClip[]; variables: Set<string>; retainedTargets: Set<string> }
const nodeActions = new Set(['navigate', 'overlay', 'scroll-to'])

/** Mirrors the authored component dependency closure used by importDependencies,
 * without copying unrelated pages or resource dictionaries to the clipboard. */
function componentDependencies(source: DesignDocument, selected: DesignNode[]) {
  const parents = allParents(source), included = new Set(selected.map(n => n.id))
  const selectedComponents = new Set(selected.filter(n => n.component).map(n => n.id))
  const pending: string[] = []
  const reference = (id: string) => {
    if (selectedComponents.has(id)) return
    if (!source.nodes[id]?.component) throw new Error('剪贴板缺少组件定义')
    const parent = parents.get(id)
    pending.push(parent && source.nodes[parent]?.componentSet ? parent : id)
  }
  const references = (n: DesignNode) => {
    instanceReferences(source, n).forEach(reference)
    for (const property of Object.values(n.component?.properties || {}))
      if (property.kind === 'instance-swap') reference(String(property.defaultValue))
  }
  selected.forEach(references)
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const n = source.nodes[id]
    if (!n) throw new Error('剪贴板缺少组件定义')
    if (n.instanceOrigin) continue
    included.add(id); pending.push(...n.children); references(n)
  }
  return included
}

/** Reject semantics that cannot be represented in the selected closed graph.
 * This must execute before a system clipboard write (and before Cut removes it). */
export function captureClipboardSemantics(
  source: DesignDocument, nodes: DesignNode[], roots: string[],
  { cut = false, external = true }: { cut?: boolean; external?: boolean } = {},
): ClipboardSemantics {
  const selected = new Set(nodes.map(n => n.id)), variables = new Set<string>(), retainedTargets = new Set<string>()
  if (cut) for (const n of Object.values(source.nodes)) if (!selected.has(n.id) && instanceReferences(source,n).some(id => selected.has(id)))
    throw new Error('仍有选区外实例依赖所选主组件，剪切会断开组件关系；请一并选择实例或改用复制')
  const interactions: NonNullable<DesignDocument['prototype']>['interactions'] = {}
  for (const [id, events] of Object.entries(source.prototype?.interactions || {})) {
    if (selected.has(id)) {
      for (const event of events) {
        if (event.condition) variables.add(event.condition.variable)
        for (const action of allActions(event.actions)) {
          if (nodeActions.has(action.kind) && !selected.has(action.target!)) {
            if (external) throw new Error('所选图层的原型指向选区外目标，请一并选择目标后再复制；原图层已保留')
            retainedTargets.add(action.target!)
          }
          if (action.kind === 'set-variable') variables.add(action.target!)
          for (const ref of expressionVariables(action.expression)) variables.add(ref.id)
        }
      }
      interactions[id] = cloneValue(events)
    } else if (cut && events.some(event => allActions(event.actions).some(action => nodeActions.has(action.kind) && selected.has(action.target!)))) {
      throw new Error('选区外的原型交互仍指向这些图层，剪切会破坏原型；请一并选择关联图层或改用复制')
    }
  }
  // An internal duplicate does not create or replace a document-wide start.
  // Portable copies retain that semantic and still reject conflicting starts.
  const startNode = external && source.prototype?.startNode && selected.has(source.prototype.startNode) ? source.prototype.startNode : undefined
  const prototype = startNode || Object.keys(interactions).length ? { ...(startNode ? { startNode } : {}), interactions } : undefined
  const animations = (source.animations || []).flatMap(clip => {
    const tracks = clip.tracks.filter(track => selected.has(track.nodeId))
    return tracks.length ? [{ ...cloneValue(clip), tracks: cloneValue(tracks) }] : []
  })
  const parents = allParents(source)
  const animated = new Set((source.animations || []).flatMap(clip => clip.tracks.map(track => track.nodeId)))
  for (const root of roots) {
    let parent = parents.get(root)
    while (parent && source.nodes[parent]) {
      if (!selected.has(parent) && animated.has(parent))
        throw new Error('选中图层位于动画父级内，无法独立保留运动；请连同动画父级一起复制')
      parent = parents.get(parent)
    }
  }
  if (external) {
    const dependencies = componentDependencies(source, nodes)
    for (const id of dependencies) if (!selected.has(id) && (
      source.prototype?.startNode === id || source.prototype?.interactions[id]?.length || animated.has(id)
    )) throw new Error('依赖的主组件带有原型或动画，请将主组件一并选中以保真复制')
  }
  return { prototype, animations, variables, retainedTargets }
}

/** An ephemeral dependency carrier; it is never inserted into the authored graph.
 * Importing variables together with node bindings ensures both use the same map. */
export function clipboardDependencyNodes(nodes: DesignNode[], semantics: ClipboardSemantics): DesignNode[] {
  if (!semantics.variables.size) return nodes
  const carrier = node('rectangle')
  carrier.fills = []; carrier.strokes = []
  carrier.bindings = Object.fromEntries([...semantics.variables].map((id, index) => [`prototype.${index}`, id]))
  return [...nodes, carrier]
}

export function hasClipboardSemantics(semantics: ClipboardSemantics) {
  return !!semantics.prototype || semantics.animations.length > 0
}

/** Append behavior in the same Editor transaction as the pasted nodes. Keeping
 * a static transform wrapper around animated roots preserves the interpolation
 * curve; multiplying a general affine parent into each keyframe does not. */
export function applyClipboardSemantics(
  target: DesignDocument, source: DesignDocument, roots: string[], ids: Map<string, string>,
  design: DesignDependencyMap, semantics: ClipboardSemantics, pageId: string, offset: number | Point,
  { internal = false }: { internal?: boolean } = {},
) {
  for (const id of semantics.retainedTargets) {
    if (!internal) throw new Error('外部剪贴板不能引用未复制的原型目标')
    if (!target.nodes[id]) throw new Error('原型目标已不存在，请重新复制所需图层；当前设计已保留')
  }
  const rootIds = new Map(roots.map(id => [id, ids.get(id)!]))
  const delta = typeof offset === 'number' ? { x: offset, y: offset } : offset
  if (semantics.prototype) {
    const remapped = cloneValue(semantics.prototype)
    if (remapped.startNode) {
      remapped.startNode = ids.get(remapped.startNode)!
      if (target.prototype?.startNode && target.prototype.startNode !== remapped.startNode)
        throw new Error('目标设计已有原型起点，无法同时保留两个起点；请粘贴到新设计')
    }
    remapped.interactions = Object.fromEntries(Object.entries(remapped.interactions).map(([id, events]) => [ids.get(id)!, events.map(event => {
      if (event.condition) event.condition.variable = design.variables.get(event.condition.variable) || event.condition.variable
      for (const action of allActions(event.actions)) {
        if (nodeActions.has(action.kind) && !semantics.retainedTargets.has(action.target!)) action.target = ids.get(action.target!)!
        else if (action.kind === 'set-variable') action.target = design.variables.get(action.target!) || action.target
        for (const ref of expressionVariables(action.expression)) ref.id = design.variables.get(ref.id) || ref.id
      }
      return event
    })]))
    target.prototype = { ...target.prototype, ...remapped, interactions: { ...target.prototype?.interactions, ...remapped.interactions } }
  }
  if (!semantics.animations.length) return rootIds
  const page = target.pages.find(page => page.id === pageId)
  if (!page) throw new Error('粘贴动画的目标页面不存在')
  const animated = new Set(semantics.animations.flatMap(clip => clip.tracks.map(track => track.nodeId)))
  const parents = allParents(source)
  for (const root of roots) if (animated.has(root)) {
    const parent = parents.get(root)
    const parentWorld: Matrix = parent && source.nodes[parent] ? worldMatrix(source, parent, parents) : [1, 0, 0, 1, 0, 0]
    const transform = multiply(translate(delta.x, delta.y), parentWorld)
    if (transform.every((value, index) => value === [1, 0, 0, 1, 0, 0][index])) continue
    const localId = ids.get(root)!, local = target.nodes[localId]
    const wrapper = node('group', 0, 0, local.width, local.height)
    wrapper.name = `${local.name} · 动画变换`.slice(0, 200)
    wrapper.transform = transform; wrapper.children = [localId]
    wrapper.fills = []; wrapper.strokes = []; wrapper.effects = []; wrapper.blend = 'pass-through'
    const at = page.children.indexOf(localId)
    if (at < 0) throw new Error('动画根图层不在粘贴页面中')
    page.children[at] = wrapper.id
    target.nodes[wrapper.id] = wrapper
    local.transform = cloneValue(source.nodes[root].transform)
    rootIds.set(root, wrapper.id)
  }
  target.animations ??= []
  for (const clip of semantics.animations) {
    const imported = cloneValue(clip)
    imported.id = uid(); imported.pageId = pageId
    for (const track of imported.tracks) track.nodeId = ids.get(track.nodeId)!
    target.animations.push(imported)
  }
  return rootIds
}
