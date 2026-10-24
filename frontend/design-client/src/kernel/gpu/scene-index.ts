import { compiled_scene_plan_json } from '../../generated/design-kernel/design_kernel'
import type { GpuNode, GpuScene } from './types'

/** Core-authored logical topology; GPU objects and preview source bindings stay local. */
export type NativeScenePlan = {
  version: 1; nodes: string[]; roots: string[]; parents: [string,string][]; rootFor: [string,string][]
  unknownEffectSubtrees: string[]; imageUses: [string,number,number][]; features: number
}
export type SceneIndex = {
  parents: Map<string, string>; roots: Set<string>; rootFor: Map<string, string>
  unknownEffectSubtrees: Set<string>; sources: Set<GpuNode>; images: Set<string>; hasReplay: boolean; hasFilters: boolean; hasPrefixFilter: boolean
}
const indices = new WeakMap<GpuScene['nodes'], { roots: GpuScene['roots']; index: SceneIndex }>()
export function sceneScale(m: number[]) {
  const [a,b,c,d]=m,s=a*a+b*b+c*c+d*d,det=a*d-b*c
  return Math.sqrt((s+Math.sqrt(Math.max(0,s*s-4*det*det)))/2)
}
/** Called only by the packet decoder after complete packet/resource validation. */
export function bindScenePlan(scene: GpuScene, plan: NativeScenePlan): SceneIndex {
  if (plan.version !== 1 || plan.roots.length !== scene.roots.length || plan.roots.some((id,i)=>id!==scene.roots[i]) ||
      plan.nodes.length !== Object.keys(scene.nodes).length || plan.nodes.some(id=>!Object.hasOwn(scene.nodes,id)))
    throw Error('Compiled scene plan identity mismatch')
  const sources = new Set(plan.nodes.map(id=>scene.nodes[id].previewSource || scene.nodes[id])), images = new Set<string>()
  for (const [id,kind,i] of plan.imageUses) {
    const node=scene.nodes[id], paint=kind===0?node?.fills[i]:kind===1?node?.strokes[i]?.paint:undefined
    if (!paint?.image) throw Error('Compiled scene image binding missing')
    images.add(paint.image)
  }
  const index = { parents: new Map(plan.parents), roots: new Set(plan.roots), rootFor: new Map(plan.rootFor),
    unknownEffectSubtrees: new Set(plan.unknownEffectSubtrees), sources, images,
    hasReplay: !!(plan.features&1), hasFilters: !!(plan.features&2),
    hasPrefixFilter: !!(plan.features&4) || import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX==='1' && !!(plan.features&8) }
  indices.set(scene.nodes,{roots:scene.roots,index}); return index
}
export function sceneIndex(scene: GpuScene): SceneIndex {
  const known=indices.get(scene.nodes)
  if(known?.roots===scene.roots)return known.index
  // Synthetic or structurally changed adapter scenes use the same Rust planner.
  // Production packets arrive already bound and never round-trip through JSON.
  return bindScenePlan(scene,JSON.parse(compiled_scene_plan_json(JSON.stringify({ roots: scene.roots, nodes: scene.nodes }))))
}
/** Rigid translation keeps topology/effect scale and original source ownership. */
export function inheritTranslatedIndex(source: GpuScene, nodes: GpuScene['nodes']) {
  indices.set(nodes,{roots:source.roots,index:sceneIndex(source)})
}
/** Preview annotations change only local source bindings, never core topology,
 * material dependencies or effect capabilities. */
export function rebindSceneIndex(source:GpuScene,target:GpuScene) {
  if(source.roots!==target.roots)throw Error('Preview changed compiled roots')
  const index={...sceneIndex(source),sources:new Set(Object.values(target.nodes).map(n=>n.previewSource||n))}
  indices.set(target.nodes,{roots:target.roots,index})
}
