import type {DesignDocument,DesignNode} from './model'
import {allParents,scene,type ParentMap} from './geometry'
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
export type MatchingKeyCache={keys:Map<string,string|undefined>;twins:Map<string,Map<string,number>>}
export function createMatchingKeyCache():MatchingKeyCache{return{keys:new Map(),twins:new Map()}}
function twinIndex(d:DesignDocument,parent:string,id:string,cache?:MatchingKeyCache):number{
  const n=d.nodes[id]
  if(!cache)return d.nodes[parent].children.filter(child=>d.nodes[child].kind===n.kind&&d.nodes[child].name===n.name).indexOf(id)
  let table=cache.twins.get(parent)
  if(!table){
    table=new Map();const counts=new Map<string,number>()
    for(const child of d.nodes[parent].children){
      const item=d.nodes[child],key=`${item.kind}\0${item.name}`,index=counts.get(key)??0
      counts.set(key,index+1);table.set(child,index)
    }
    cache.twins.set(parent,table)
  }
  return table.get(id)??-1
}
function hierarchyKey(d:DesignDocument,id:string,parents:ParentMap,cache?:MatchingKeyCache):string|undefined{
  if(cache?.keys.has(id))return cache.keys.get(id)
  const path:unknown[]=[],section=(()=>{let p=parents.get(id);while(p&&d.nodes[p]){if(d.nodes[p].kind==='section')return p;p=parents.get(p)}return null})()
  let current=id
  while(true){
    const parent=parents.get(current),n=d.nodes[current]
    if(!parent||!d.nodes[parent]||d.nodes[parent].kind==='section')break
    path.unshift([n.kind,n.name,twinIndex(d,parent,current,cache)]);current=parent
  }
  const result=path.length?JSON.stringify([section,path]):undefined
  cache?.keys.set(id,result)
  return result
}
export function matchingLayerKey(d:DesignDocument,id:string,parents:ParentMap=allParents(d),cache?:MatchingKeyCache){
  return d.nodes[id]?hierarchyKey(d,id,parents,cache):undefined
}
export function selectionHasMatchingLayers(d:DesignDocument,selected:readonly string[],parents:ParentMap=allParents(d)){
  return selected.some(id=>matchingLayerKey(d,id,parents)!==undefined)
}
/** Deepest hit at or below the shallow target that matches the current nested selection. */
export function shiftMatchingClickTarget(d:DesignDocument,page:string,selected:readonly string[],shallowId:string|null,leafId:string|null,parents:ParentMap=allParents(d)):string|null{
  if(!shallowId||!leafId||leafId===shallowId)return shallowId
  const keys=new Set(selected.map(id=>matchingLayerKey(d,id,parents)).filter((key):key is string=>!!key))
  if(!keys.size)return shallowId
  const seen=new Set<string>()
  let at:string|undefined=leafId
  while(at&&!seen.has(at)){
    seen.add(at)
    const key=matchingLayerKey(d,at,parents)
    if(key&&keys.has(key))return at
    if(at===shallowId)break
    const parent=parents.get(at)
    if(!parent||parent===page||!d.nodes[parent])break
    at=parent
  }
  return shallowId
}
export function querySelection(d:DesignDocument,page:string,selected:string[],kind:SelectionQuery):string[]{
  const entries=scene(d,page).filter(e=>!e.locked),ids=new Set(selected)
  if(kind==='inverse')return entries.filter(e=>e.depth===0&&!ids.has(e.id)).map(e=>e.id)
  const parents=allParents(d),key=(id:string)=>kind==='matching'?hierarchyKey(d,id,parents):signature(d.nodes[id],kind)
  const keys=new Set(selected.filter(id=>d.nodes[id]).map(key).filter(v=>v!==undefined).map(v=>JSON.stringify(normalized(v))))
  if(!keys.size)return [...selected]
  return entries.filter(e=>{const value=key(e.id);return value!==undefined&&keys.has(JSON.stringify(normalized(value)))}).map(e=>e.id)
}
