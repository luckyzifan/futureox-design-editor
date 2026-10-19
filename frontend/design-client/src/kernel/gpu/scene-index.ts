import type { GpuNode, GpuScene } from './types'

export type SceneIndex = {
  parents: Map<string, string>; roots: Set<string>; rootFor: Map<string, string>
  sources: Set<GpuNode>; images: Set<string>; hasReplay: boolean; hasFilters: boolean; hasPrefixFilter: boolean
}
const indices = new WeakMap<GpuScene['nodes'], {roots: GpuScene['roots']; index: SceneIndex}>()
export function sceneScale(m: number[]) {
  const [a,b,c,d]=m,s=a*a+b*b+c*c+d*d,det=a*d-b*c
  return Math.sqrt((s+Math.sqrt(Math.max(0,s*s-4*det*det)))/2)
}

/** Derived topology and capabilities of an immutable compiled scene. Exact
 * packets own the ordering; these lookup tables never choose painter order. */
export function sceneIndex(scene: GpuScene): SceneIndex {
  const known = indices.get(scene.nodes)
  if (known?.roots === scene.roots) return known.index
  const parents = new Map<string,string>(), roots = new Set(scene.roots), rootFor = new Map<string,string>()
  const sources = new Set<GpuNode>(), images = new Set<string>()
  let hasReplay = false, hasFilters = false, hasPrefixFilter = false
  for (const n of Object.values(scene.nodes)) {
    sources.add(n.previewSource || n)
    for (const child of n.children) parents.set(child,n.id)
    for (const paint of [...n.fills,...n.strokes.map(s=>s.paint)]) if (paint.kind==='image' && paint.image) images.add(paint.image)
    hasReplay ||= !!n.textureReplay
    for (const effect of n.effects) if (effect.visible) {
      hasFilters ||= ['blur','shadow','inner-shadow','background-blur','glass'].includes(effect.kind)
      if (effect.kind==='blur'||effect.kind==='shadow'||effect.kind==='glass') {
        const radius=(effect.kind==='glass'&&effect.glass?Math.max(1,effect.radius):effect.radius)*sceneScale(n.matrix)
        hasPrefixFilter ||= radius>=48&&radius<=2048
      }
    }
  }
  for (const root of scene.roots) {
    const stack=[root]
    while(stack.length){const id=stack.pop()!;if(rootFor.has(id))continue;rootFor.set(id,root);stack.push(...(scene.nodes[id]?.children||[]))}
  }
  const index={parents,roots,rootFor,sources,images,hasReplay,hasFilters,hasPrefixFilter}
  indices.set(scene.nodes,{roots:scene.roots,index});return index
}

/** Translation preserves topology, resources, scale, and effect policy. New
 * dynamic ancestors are excluded from paint caches by previewDynamic. */
export function inheritTranslatedIndex(source:GpuScene,nodes:GpuScene['nodes']) {
  indices.set(nodes,{roots:source.roots,index:sceneIndex(source)})
}
