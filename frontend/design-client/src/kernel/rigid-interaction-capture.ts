import type { Bounds, DesignDocument, Matrix } from '../model'
import { apply, bounds, boxPoints, unionBounds } from '../geometry'
import { interactionPoseMatrices, type InteractionPlan } from './interaction-layers'

/** Restrict a freshly native-rendered rotation to its proven output footprint.
 * This never rotates cached pixels. Non-rigid transforms and dependencies whose
 * output support cannot be bounded locally retain the full viewport capture. */
export function rigidInteractionCapture(plan:InteractionPlan,current:DesignDocument,
  roots:ReadonlyMap<string,Bounds>|undefined,localized:ReadonlySet<string>|undefined,
  fixed:ReadonlySet<string>|undefined,parents:ReadonlyMap<string,Matrix>|undefined,scale:number):Bounds|undefined {
  if(import.meta.env.VITE_DESIGN_LOCAL_ROTATION_CAPTURE==='0'||!roots||!localized||!Number.isFinite(scale)||scale<=0)return
  if(!plan.ids.every(id=>localized.has(id)&&!fixed?.has(id)&&roots.has(id)))return
  if(plan.ids.some(id=>!plan.document.nodes[id]||!current.nodes[id]))return
  for(const id of plan.ids){
    const pending=[id],seen=new Set<string>()
    while(pending.length){
      const next=pending.pop()!,node=plan.document.nodes[next]
      if(!node||seen.has(next))return
      seen.add(next)
      const effects=node.effects.filter(effect=>effect.visible)
      if(node.mask||node.repeat||node.textPath||node.connector||effects.some(effect=>
        !['blur','gaussian-blur','shadow','inner-shadow','color-controls'].includes(effect.kind)||effect.gradientBlur)||
        next!==id&&effects.length||effects.length>1&&!effects.every(effect=>['inner-shadow','color-controls'].includes(effect.kind)))return
      pending.push(...node.children)
    }
  }
  const poses=interactionPoseMatrices(Object.fromEntries(plan.ids.map(id=>[id,plan.document.nodes[id].transform])),
    Object.fromEntries(plan.ids.map(id=>[id,current.nodes[id]?.transform])),parents)
  if(!poses)return
  const output:Bounds[]=[]
  for(const id of plan.ids){
    const m=poses.get(id)!,[a,b,c,d]=m
    if(Math.abs(a*a+b*b-1)>1e-10||Math.abs(c*c+d*d-1)>1e-10||Math.abs(a*c+b*d)>1e-10||a*d-b*c<=0)return
    const source=roots.get(id)!,moved=bounds(boxPoints(source).map(point=>apply(m,point)))
    if(!Object.values(source).every(Number.isFinite)||!Object.values(moved).every(Number.isFinite))return
    output.push(source,moved)
  }
  const box=unionBounds(output),edge=2/scale
  return{x:box.x-edge,y:box.y-edge,width:box.width+2*edge,height:box.height+2*edge}
}
