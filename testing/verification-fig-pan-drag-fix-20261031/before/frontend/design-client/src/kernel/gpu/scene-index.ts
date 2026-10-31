import { compiled_scene_plan_json } from '../../generated/design-kernel/design_kernel'
import type { GpuNode, GpuScene } from './types'

/** Core-authored logical topology; GPU objects and preview source bindings stay local. */
export type NativeScenePlan = {
  version: 1; nodes: string[]; roots: string[]; parents: [string,string][]; rootFor: [string,string][]
  unknownEffectSubtrees: string[]; imageUses: [string,number,number][]; features: number
  opaqueSolidGroups?: [string,string][]
  opaqueSolidRuns?: [string,number,number,string][]
  boundedPaintGroups?: string[]
  sampleIndependentNodes?: string[]
}
export type SceneIndex = {
  parents: Map<string, string>; roots: Set<string>; rootFor: Map<string, string>
  unknownEffectSubtrees: Set<string>; sources: Set<GpuNode>; images: Set<string>; hasReplay: boolean; hasFilters: boolean; hasPrefixFilter: boolean
  sampleIndependentNodes: Set<string>
}
const indices = new WeakMap<GpuScene['nodes'], { roots: GpuScene['roots']; index: SceneIndex }>()
const opaqueGroups=new WeakMap<GpuScene['nodes'],Map<readonly string[],string>>()
type SolidRun={start:number;end:number;color:string}
const opaqueRuns=new WeakMap<GpuScene['nodes'],Map<readonly string[],readonly SolidRun[]>>()
const boundedPaintGroups=new WeakMap<GpuScene['nodes'],Set<readonly string[]>>()
export function opaqueSolidRuns(scene:GpuScene,ids:readonly string[]){sceneIndex(scene);return opaqueRuns.get(scene.nodes)?.get(ids)}
export function boundedPaintGroup(scene:GpuScene,ids:readonly string[]){sceneIndex(scene);return boundedPaintGroups.get(scene.nodes)?.has(ids)===true}
const logicalPlans=new WeakMap<NativeScenePlan,Pick<SceneIndex,'parents'|'roots'|'rootFor'|'sampleIndependentNodes'|'unknownEffectSubtrees'>>()
export function opaqueSolidGroup(scene:GpuScene,ids:readonly string[]){sceneIndex(scene);return opaqueGroups.get(scene.nodes)?.get(ids)}
export function hasOpaqueSolidGroups(scene:GpuScene){
 sceneIndex(scene)
 if(opaqueGroups.get(scene.nodes)?.size)return true
 for(const [ids,runs]of opaqueRuns.get(scene.nodes)||[]){
  if(boundedPaintGroups.get(scene.nodes)?.has(ids)||runs[0]?.start===0&&runs.at(-1)?.end===ids.length&&runs.every((run,i)=>i===0||run.start===runs[i-1].end))return true
 }
 return false
}
export function sceneScale(m: number[]) {
  const [a,b,c,d]=m,s=a*a+b*b+c*c+d*d,det=a*d-b*c
  return Math.sqrt((s+Math.sqrt(Math.max(0,s*s-4*det*det)))/2)
}
/** Called only by the packet decoder after complete packet/resource validation. */
export function bindScenePlan(scene: GpuScene, plan: NativeScenePlan): SceneIndex {
  if (plan.version !== 1 || plan.roots.length !== scene.roots.length || plan.roots.some((id,i)=>id!==scene.roots[i]) ||
      plan.nodes.length !== Object.keys(scene.nodes).length || plan.nodes.some(id=>!Object.hasOwn(scene.nodes,id)))
    throw Error('Compiled scene plan identity mismatch')
  if (plan.sampleIndependentNodes?.some(id=>!Object.hasOwn(scene.nodes,id)))
    throw Error('Compiled sample plan identity mismatch')
  const sources = new Set(plan.nodes.map(id=>scene.nodes[id].previewSource || scene.nodes[id])), images = new Set<string>()
  for (const [id,kind,i] of plan.imageUses) {
    const node=scene.nodes[id], paint=kind===0?node?.fills[i]:kind===1?node?.strokes[i]?.paint:undefined
    if (!paint?.image) throw Error('Compiled scene image binding missing')
    images.add(paint.image)
  }
  const immutable=Object.isFrozen(plan)&&[plan.parents,plan.roots,plan.rootFor,plan.sampleIndependentNodes,plan.unknownEffectSubtrees].every(value=>value===undefined||Object.isFrozen(value))
  let logical=immutable?logicalPlans.get(plan):undefined
  if(!logical){
    logical={parents:new Map(plan.parents),roots:new Set(plan.roots),rootFor:new Map(plan.rootFor),
      sampleIndependentNodes:new Set(plan.sampleIndependentNodes||[]),unknownEffectSubtrees:new Set(plan.unknownEffectSubtrees)}
    if(immutable)logicalPlans.set(plan,logical)
  }
  const index = { ...logical, sources, images,
    hasReplay: !!(plan.features&1), hasFilters: !!(plan.features&2),
    hasPrefixFilter: !!(plan.features&4) || import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX==='1' && !!(plan.features&8) }
  const groups=new Map<readonly string[],string>()
  for(const [parent,color]of plan.opaqueSolidGroups||[]){
    const node=scene.nodes[parent]
    if(!node||!/^#[\da-f]{6}$/i.test(color))throw Error('Invalid compiled solid group')
    groups.set(node.children,color)
  }
  const runs=new Map<readonly string[],SolidRun[]>()
  for(const [parent,start,end,color]of plan.opaqueSolidRuns||[]){
    const ids=scene.nodes[parent]?.children
    const prior=ids&&runs.get(ids)
    if(!ids||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<(prior?.at(-1)?.end||0)||end-start<8||end>ids.length||!/^#[\da-f]{6}$/i.test(color))throw Error('Invalid compiled solid run')
    const next=prior||[];next.push({start,end,color});runs.set(ids,next)
  }
  const bounded=new Set<readonly string[]>()
  for(const parent of plan.boundedPaintGroups||[]){
    if(!scene.nodes[parent])throw Error('Invalid compiled bounded paint group')
    bounded.add(scene.nodes[parent].children)
  }
  boundedPaintGroups.set(scene.nodes,bounded)
  opaqueRuns.set(scene.nodes,runs)
  opaqueGroups.set(scene.nodes,groups)
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
  const groups=opaqueGroups.get(source.nodes);if(groups)opaqueGroups.set(nodes,groups)
  const runs=opaqueRuns.get(source.nodes);if(runs)opaqueRuns.set(nodes,runs)
  const bounded=boundedPaintGroups.get(source.nodes);if(bounded)boundedPaintGroups.set(nodes,bounded)
}
/** Preview annotations change only local source bindings, never core topology,
 * material dependencies or effect capabilities. */
export function rebindSceneIndex(source:GpuScene,target:GpuScene) {
  if(source.roots!==target.roots)throw Error('Preview changed compiled roots')
  const index={...sceneIndex(source),sources:new Set(Object.values(target.nodes).map(n=>n.previewSource||n))}
  indices.set(target.nodes,{roots:target.roots,index})
  const groups=opaqueGroups.get(source.nodes);if(groups)opaqueGroups.set(target.nodes,groups)
  const runs=opaqueRuns.get(source.nodes);if(runs)opaqueRuns.set(target.nodes,runs)
  const bounded=boundedPaintGroups.get(source.nodes);if(bounded)boundedPaintGroups.set(target.nodes,bounded)
}
