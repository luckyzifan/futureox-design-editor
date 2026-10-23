import type { DesignNode, VectorGeometry } from './model'
import { equalValue } from './document-patch'

export type SourceNodeEdit={patch:Record<string,unknown>;geometryScale?:[number,number]}
// This is a transport proof, not a second mutation implementation. The native
// source owner applies and validates the actual f64 geometry operation.
function scaled(a:VectorGeometry,b:VectorGeometry,sx:number,sy:number):boolean{
  if(a.fillRule!==b.fillRule||(a.stroke===undefined)!==(b.stroke===undefined))return false
  const pairs=[[a.fill,b.fill],...(a.stroke&&b.stroke?[[a.stroke,b.stroke]]:[])]
  return pairs.every(([old,next])=>old.length===next.length&&old.every((command,i)=>{
    const value=next[i]
    if(command==='close'||value==='close')return command===value
    const [key,coords]=Object.entries(command)[0],entry=Object.entries(value)[0]
    return key===entry[0]&&coords.length===entry[1].length&&coords.every((v:number,j:number)=>Object.is(v*(j%2?sy:sx),entry[1][j]))
  }))
}
export function sourceNodeEdit(before:DesignNode,after:DesignNode):SourceNodeEdit|null{
  const patch:Record<string,unknown>={}
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
    const a=before[key as keyof DesignNode],b=after[key as keyof DesignNode]
    if(!Object.is(a,b)&&!equalValue(a,b))patch[key]=b??null
  }
  // Boolean output geometry is derived from the retained operands. Persist
  // the authored operand edits, not a materialized network/render-cache blob.
  if(before.booleanOperation&&before.booleanOperation===after.booleanOperation&&equalValue(before.children,after.children)){
    delete patch.network;delete patch.vectorGeometry
  }
  if(!Object.keys(patch).length)return null
  const sx=after.width/before.width,sy=after.height/before.height
  if(patch.vectorGeometry&&before.vectorGeometry&&after.vectorGeometry&&[sx,sy].every(v=>Number.isFinite(v)&&v>0)&&scaled(before.vectorGeometry,after.vectorGeometry,sx,sy)){
    delete patch.vectorGeometry
    return {patch,geometryScale:[sx,sy]}
  }
  return {patch}
}
