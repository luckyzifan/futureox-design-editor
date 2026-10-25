import { compiled_scene_source_key } from '../../generated/design-kernel/design_kernel'
import type { GpuNode, GpuScene } from './types'
const identities=new WeakMap<GpuNode,{scope:string;source:number}>()
const programs=new WeakMap<GpuScene['vertices'],{curves:GpuScene['curves'];nodes:GpuScene['nodes']}>()
const synthetic=new WeakMap<GpuNode,Uint8Array>()
export function bindSourceIdentity(node:GpuNode,scope:string,source:number){
  if(!Number.isSafeInteger(source)||source<=0)throw Error('Invalid compiled source identity')
  if(scope)identities.set(node,{scope,source})
}
export function bindSourcePrograms(scene:GpuScene){
  // Decoded node dictionaries and nodes are immutable; program views are
  // privately owned by the frame and never edited after native compilation.
  programs.set(scene.vertices,{curves:scene.curves,nodes:scene.nodes})
}
/** Core-issued IDs bind material semantics and every referenced IEEE program
 * word. A hash or node-only JSON equality never grants this proof. */
export function sameCompiledSource(a:GpuNode,b:GpuNode,previous:GpuScene,next:GpuScene):boolean|undefined{
  const x=identities.get(a),y=identities.get(b)
  const bound=(scene:GpuScene,node:GpuNode)=>{
    const proof=programs.get(scene.vertices),original=proof?.nodes[node.id]
    if(!proof||proof.curves!==scene.curves||!original)return false
    const expected=identities.get(original),actual=identities.get(node)
    return !!expected&&!!actual&&expected.scope===actual.scope&&expected.source===actual.source
  }
  if(!bound(previous,a)||!bound(next,b))return
  return x&&y&&x.scope===y.scope?x.source===y.source:undefined
}
/** Synthetic scenes use the same Rust semantic normalizer; their caller still
 * compares exact program words before any device resource reuse. */
export function sameSourceSemantics(a:GpuNode,b:GpuNode){
  const key=(n:GpuNode)=>{let value=synthetic.get(n);if(!value){value=compiled_scene_source_key(JSON.stringify(n));synthetic.set(n,value)}return value}
  const x=key(a),y=key(b);return x.length===y.length&&x.every((v,i)=>v===y[i])
}
