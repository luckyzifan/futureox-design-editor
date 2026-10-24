import { compiled_scene_source_key } from '../../generated/design-kernel/design_kernel'
import type { GpuNode } from './types'
const identities=new WeakMap<GpuNode,{scope:string;source:number}>()
const synthetic=new WeakMap<GpuNode,Uint8Array>()
export function bindSourceIdentity(node:GpuNode,scope:string,source:number){
  if(!Number.isSafeInteger(source)||source<=0)throw Error('Invalid compiled source identity')
  if(scope)identities.set(node,{scope,source})
}
/** Core-issued IDs bind material semantics and every referenced IEEE program
 * word. A hash or node-only JSON equality never grants this proof. */
export function sameCompiledSource(a:GpuNode,b:GpuNode):boolean|undefined{
  const x=identities.get(a),y=identities.get(b)
  return x&&y&&x.scope===y.scope?x.source===y.source:undefined
}
/** Synthetic scenes use the same Rust semantic normalizer; their caller still
 * compares exact program words before any device resource reuse. */
export function sameSourceSemantics(a:GpuNode,b:GpuNode){
  const key=(n:GpuNode)=>{let value=synthetic.get(n);if(!value){value=compiled_scene_source_key(JSON.stringify(n));synthetic.set(n,value)}return value}
  const x=key(a),y=key(b);return x.length===y.length&&x.every((v,i)=>v===y[i])
}
