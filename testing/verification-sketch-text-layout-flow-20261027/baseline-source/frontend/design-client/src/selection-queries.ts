import type {DesignDocument,DesignNode} from './model'
import {allParents,scene} from './geometry'
export type SelectionQuery='fill'|'stroke'|'effect'|'text'|'font'|'instance'|'properties'|'matching'|'inverse'
function normalized(value:unknown):unknown {
  if(Array.isArray(value))return value.map(normalized)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='id').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalized(v)]))
  return value
}
function signature(n:DesignNode,kind:SelectionQuery){
  switch(kind){
    case 'fill':return [n.fills,n.styleRefs?.fills]
    case 'stroke':return [n.strokes,n.styleRefs?.strokes]
    case 'effect':return [n.effects,n.styleRefs?.effects]
    case 'font':return n.kind==='text'?[n.textStyle?.fontId||'default',n.textStyle?.weight||400]:undefined
    case 'text':return n.kind==='text'?[n.fontSize,n.textStyle,n.textRuns?.map(r=>({...r,start:undefined,end:undefined}))]:undefined
    case 'instance':return n.instance?.componentId
    default:return [n.kind,n.width,n.height,n.opacity,n.blend,n.fills,n.strokes,n.effects,n.radii,n.smoothing,n.fontSize,n.textStyle,n.bindings,n.styleRefs]
  }
}
/** Matching objects share their named/type path below a top-level container.
 * Occurrence indices disambiguate siblings and sections constrain the scope. */
function hierarchyKey(d:DesignDocument,id:string,parents:Map<string,string>):string|undefined{
  const path:unknown[]=[],section=(()=>{let p=parents.get(id);while(p&&d.nodes[p]){if(d.nodes[p].kind==='section')return p;p=parents.get(p)}return null})()
  let current=id
  while(true){
    const parent=parents.get(current),n=d.nodes[current]
    if(!parent||!d.nodes[parent]||d.nodes[parent].kind==='section')break
    const siblings=d.nodes[parent].children.filter(id=>d.nodes[id].kind===n.kind&&d.nodes[id].name===n.name)
    path.unshift([n.kind,n.name,siblings.indexOf(current)]);current=parent
  }
  return path.length?JSON.stringify([section,path]):undefined
}
export function querySelection(d:DesignDocument,page:string,selected:string[],kind:SelectionQuery):string[]{
  const entries=scene(d,page).filter(e=>!e.locked),ids=new Set(selected)
  if(kind==='inverse')return entries.filter(e=>e.depth===0&&!ids.has(e.id)).map(e=>e.id)
  const parents=allParents(d),key=(id:string)=>kind==='matching'?hierarchyKey(d,id,parents):signature(d.nodes[id],kind)
  const keys=new Set(selected.filter(id=>d.nodes[id]).map(key).filter(v=>v!==undefined).map(v=>JSON.stringify(normalized(v))))
  if(!keys.size)return [...selected]
  return entries.filter(e=>{const value=key(e.id);return value!==undefined&&keys.has(JSON.stringify(normalized(value)))}).map(e=>e.id)
}
