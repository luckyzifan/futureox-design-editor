import {MATERIAL_MARGIN} from './kernel/source-overview-window'
import type {SourceCanvasBox,SourceCanvasItem} from './desktop'

export function includesMaterials(active:readonly string[]|undefined, wanted:readonly string[]) {
  return !!active && wanted.every(key=>active.includes(key))
}

export type PublishedMaterialScope = { revision: number; keys: readonly string[] }

function scopeSignature(keys: readonly string[]) {
  return [...keys].sort().join('\n')
}

/** A scope already published for this revision can be recalled without the
 * overlap sample. Another revision, an empty list, or a different key set waits. */
export function rememberedMaterialScope(input:{
  revision: number
  keys: readonly string[]
  remembered: readonly PublishedMaterialScope[]
}) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !input.keys.length) return false
  const wanted = scopeSignature(input.keys)
  return input.remembered.some(entry => entry.revision === input.revision && scopeSignature(entry.keys) === wanted)
}

/** Keep at most four scopes for the revision just published. Older revisions
 * are dropped so a reused revision number cannot recall another document. */
export function rememberPublishedScope(remembered: PublishedMaterialScope[], revision: number, keys: readonly string[]) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !keys.length || keys.length > 4096) return remembered
  const signature = scopeSignature(keys)
  const next = [{ revision, keys: [...keys] }, ...remembered.filter(entry => !(entry.revision === revision && scopeSignature(entry.keys) === signature))]
  remembered.splice(0, remembered.length, ...next.filter(entry => entry.revision === revision).slice(0, 4))
  return remembered
}

/** A viewport-driven scope that still overlaps a large presented set must not
 * publish immediately. Publishing replaces the host token and drops the tiles
 * already drawn for this revision. One later sample publishes a scope the
 * camera actually stayed on; a return to keys already on screen never starts
 * that publication. Disjoint regions and explicit page choices do not wait. */
export function deferOverlappingMaterialScope(input:{
  viewportDriven:boolean
  held:readonly string[]|undefined
  wanted:readonly string[]
}) {
  if(!input.viewportDriven||!input.held||input.held.length<6||!input.wanted.length)return false
  if(includesMaterials(input.held,input.wanted))return false
  const held=new Set(input.held)
  return input.wanted.some(key=>held.has(key))
}

/** Replace a costly pending conversion when a zoom now needs a small subset. */
export function smallerMaterialRequest(items:readonly SourceCanvasItem[],pending:readonly string[],next:readonly string[]) {
  if(!next.length||pending.length<6||next.length*3>pending.length||!includesMaterials(pending,next))return false
  const old=new Set(pending),needed=new Set(next)
  let previousBytes=0,nextBytes=0
  for(const item of items){
    if(old.has(item.key))previousBytes+=item.bytes
    if(needed.has(item.key))nextBytes+=item.bytes
  }
  return previousBytes>=12*1024*1024&&nextBytes*3<=previousBytes
}

/** Keep already prepared neighbours across a viewport edge. Explicit page
 * and material choices retain their requested scope. Source order and
 * ownership are still resolved by the native session. */
export function materialScope(items:readonly SourceCanvasItem[],indices:readonly number[],active:readonly string[]|undefined,
  viewport?:SourceCanvasBox) {
  const wanted=indices.map(i=>items[i]).filter((item):item is SourceCanvasItem=>!!item)
  const keys=new Set(wanted.map(item=>item.key))
  if(viewport && active && wanted.length){
    const pages=new Set(wanted.map(item=>item.pageId)),previous=new Set(active)
    const v=viewport,left=v.x-v.width,top=v.y-v.height,right=v.x+v.width*2,bottom=v.y+v.height*2
    let retainedBytes=0
    for(const item of items){
      const b=item.placed
      if(keys.size>=32)break
      if(!previous.has(item.key)||keys.has(item.key)||!pages.has(item.pageId)||
          b.x>=right||b.y>=bottom||b.x+b.width<=left||b.y+b.height<=top||
          retainedBytes+item.bytes>8*1024*1024)continue
      keys.add(item.key);retainedBytes+=item.bytes
    }
  }
  return [...keys].sort()
}

/** The PNG IHDR comes from the validated native catalogue. Avoid decoding
 * the entire data URL just to decide when a higher display rung is worthwhile. */
export function thumbnailScale(src:string|undefined,box:SourceCanvasBox){
  const prefix='data:image/png;base64,'
  if(!src)return 0
  if(!src.startsWith(prefix)||!(box.width>0&&box.height>0))return
  try{
    const header=atob(src.slice(prefix.length,prefix.length+32))
    if(header.length!==24||header.slice(12,16)!=='IHDR')return
    const size=(i:number)=>header.charCodeAt(i)*16777216+header.charCodeAt(i+1)*65536+header.charCodeAt(i+2)*256+header.charCodeAt(i+3)
    const w=size(16),h=size(20)
    if(w>0&&h>0&&w<=768&&h<=768&&w*h<=384*384)return Math.max(w/box.width,h/box.height)
  }catch{return}
}

// A parked neighbour may remain in an exact scene without occupying any
// texels of the navigation image. Fit the image to the live consumers.
export function visibleMaterialWindow(items:readonly SourceCanvasItem[],indices:readonly number[],viewport:SourceCanvasBox){
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity
  for(const index of indices){
    const b=items[index]?.placed
    if(!b)continue
    const x=Math.max(viewport.x,b.x-MATERIAL_MARGIN),y=Math.max(viewport.y,b.y-MATERIAL_MARGIN)
    const r=Math.min(viewport.x+viewport.width,b.x+b.width+MATERIAL_MARGIN),d=Math.min(viewport.y+viewport.height,b.y+b.height+MATERIAL_MARGIN)
    if(r<=x||d<=y)continue
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,r);bottom=Math.max(bottom,d)
  }
  if(right>left&&bottom>top)return {x:left,y:top,width:right-left,height:bottom-top}
}

/** Roots nearest the wheel on a large cold viewport. Publishing them as their
 * own snapshot blocks the full scope on the same exclusive host call, and the
 * multi-root build does not reuse that singleton cache. Callers keep the
 * catalogue pixels until the full scope itself is ready. */
export function firstVisibleMaterialKeys(items:readonly SourceCanvasItem[],indices:readonly number[],viewport:SourceCanvasBox,
  active:readonly string[]|undefined,anchor?:{x:number;y:number}){
  if(indices.length<8)return
  const center={x:viewport.x+viewport.width/2,y:viewport.y+viewport.height/2}
  const p=anchor&&anchor.x>=viewport.x&&anchor.y>=viewport.y&&anchor.x<=viewport.x+viewport.width&&anchor.y<=viewport.y+viewport.height?anchor:center
  const candidates=indices.map(i=>items[i]).filter((r):r is SourceCanvasItem=>!!r)
  const total=candidates.reduce((sum,r)=>sum+r.bytes,0)
  if(total<12*1024*1024)return
  const distance=({placed:b}:SourceCanvasItem)=>Math.hypot(Math.max(b.x-p.x,0,p.x-b.x-b.width),Math.max(b.y-p.y,0,p.y-b.y-b.height))
  candidates.sort((a,b)=>distance(a)-distance(b)||a.bytes-b.bytes)
  const first=candidates.slice(0,2)
  if(!first.length||first.reduce((sum,r)=>sum+r.bytes,0)>Math.min(total/3,12*1024*1024))return
  const keys=first.map(r=>r.key).sort()
  return includesMaterials(active,keys)?undefined:keys
}
