import type {GpuNode,GpuPaint,GpuScene,Rect} from './types'
import {fullSampleCoverage} from './horizontal-filter-cache'
import {exactBlendLattice} from './effect-region'

type Proofs={color:(value:string)=>readonly number[];image:(node:GpuNode,paint:GpuPaint)=>boolean;opaqueImage?:(node:GpuNode,paint:GpuPaint)=>boolean;imageFilters?:boolean;sourceLayers?:boolean}
function covers(rect:Rect|undefined,region:Rect){
 return !!rect&&rect.x<=region.x&&rect.y<=region.y&&rect.x+rect.w>=region.x+region.w&&rect.y+rect.h>=region.y+region.h
}
/** Only normal, bounded sources may disappear behind a complete overwrite.
 * This preserves the old zero/NaN behaviour: unknown images, HDR/overflow,
 * masks, backdrop reads and unsupported operators never grant this proof. */
function boundedPaint(p:GpuPaint,proofs:Proofs,node:GpuNode):boolean{
 if(!p.visible)return true
 if(p.blend!=='normal'||!Number.isFinite(p.opacity)||p.opacity<0||p.opacity>1)return false
 const color=(value:string)=>{const c=proofs.color(value);return c.length===4&&c.every(v=>Number.isFinite(v)&&v>=0&&v<=1&&!Object.is(v,-0))}
 if(p.kind==='solid')return color(p.color)
 if(p.kind==='image')return !!p.image&&proofs.image(node,p)
 if(p.kind!=='linear'||p.stops.length<2||p.stops.length>64)return false
 return p.stops.every((s,i)=>color(s.color)&&Number.isFinite(s.offset)&&s.offset>=0&&s.offset<=1&&(!i||s.offset-p.stops[i-1].offset>=1e-6))
}
function boundedPrefix(scene:GpuScene,ids:readonly string[],proofs:Proofs):boolean{
 const pending=[...ids],seen=new Set<string>()
 while(pending.length){
  const id=pending.pop()!,n=scene.nodes[id];if(!n)continue
  if(seen.has(id)||seen.size>=4096)return false;seen.add(id)
  if(n.mask||n.maskId||n.clip||n.captureReplay||n.textureReplay||
    (n.blend!=='normal'&&!(n.passthrough&&n.blend==='pass-through'))||!Number.isFinite(n.opacity)||n.opacity<0||n.opacity>1||
    ![...n.matrix,...n.inverse,...n.size].every(v=>Number.isFinite(v)&&Math.abs(v)<=4_000_000)||
    n.fills.some(p=>p.visible)&&n.size.some(v=>v<=0)||
    !n.fills.every(p=>boundedPaint(p,proofs,n))||!n.strokes.every(s=>boundedPaint(s.paint,proofs,n)))return false
  const visible=n.effects.filter(e=>e.visible)
  if(visible.length){
   if(visible.length!==1||n.children.length||n.fills.length!==1||
     !(n.fills[0].kind==='solid'||proofs.sourceLayers&&n.fills[0].kind==='linear'||proofs.imageFilters&&n.fills[0].kind==='image'))return false
   const e=visible[0],sigma=e.radius*Math.max(Math.hypot(n.matrix[0],n.matrix[1]),Math.hypot(n.matrix[2],n.matrix[3]))
   // Positive normalized box convolution of bounded finite pixels remains
   // finite, including the admitted display arithmetic and streamed recipe.
   const shadow=proofs.sourceLayers && (e.kind==='shadow'||e.kind==='inner-shadow') && e.spread===0 &&
     [e.x,e.y,e.opacity].every(Number.isFinite) && e.opacity>=0&&e.opacity<=1 && proofs.color(e.color).every(v=>v>=0&&v<=1)
   if((e.kind!=='gaussian-blur'&&!shadow)||e.gradientBlur||!Number.isFinite(sigma)||sigma<0||sigma>1024)return false
  }
  pending.push(...n.children)
 }
 return true
}
/** Caller supplies a genuinely transparent initial painter and no clip/skip
 * scope. A four-phase interval certificate must cover its ENTIRE rectangle,
 * including retained halo pixels; a node AABB or opaque authored colour alone
 * is insufficient. All document/source nodes remain intact. */
export function opaquePainterStart(scene:GpuScene,ids:readonly string[],region:Rect,proofs:Proofs):number{
 if(scene.softwareRaster||!scene.coherentSamples||scene.resolve||scene.presentation||
    !exactBlendLattice([region])||region.w<=0||region.h<=0||region.w>8192||region.h>8192||
    !(scene.curves instanceof Float32Array)||!(scene.curves.buffer instanceof ArrayBuffer))return 0
 for(let i=ids.length-1;i>0;i--){
  const n=scene.nodes[ids[i]]
  if(!n||n.opacity!==1||n.blend!=='normal'||n.passthrough||n.mask||n.maskId||n.clip||n.children.length||
    (n.strokes.length&&!proofs.sourceLayers)||
    n.effects.some(e=>e.visible)||n.captureReplay||n.textureReplay)continue
  const paints=n.fills.filter(p=>p.visible)
  if(paints.length!==1)continue
  const p=paints[0]
  if(p.opacity!==1||p.blend!=='normal'||!boundedPaint(p,proofs,n)||
    !(p.kind==='solid'?proofs.color(p.color)[3]===1:p.kind==='image'?proofs.opaqueImage?.(n,p):p.kind==='linear'&&p.stops.every(s=>proofs.color(s.color)[3]===1)))continue
  if(!(proofs.sourceLayers&&n.fill.count&&covers(n.fill.opaqueRect,region))&&!fullSampleCoverage(n.fill,scene.curves,region))continue
  if(!boundedPrefix(scene,ids.slice(0,i+1),proofs))return 0
  return i
 }
 return 0
}

/** Reuse the parent target for neutral source groups only when none of the
 * descendants reads its initial backdrop. Keep masked groups isolated unless
 * the source path certificate covers this entire destination, including halo. */
export function sourcePainterOrder(scene:GpuScene,ids:string[],region:Rect):string[]{
 const checked=new Map<string,boolean>()
 const independent=(id:string):boolean=>{
  const known=checked.get(id);if(known!==undefined)return known
  if(checked.size>=4096)return false
  checked.set(id,false)
  const n=scene.nodes[id]
  const result=!n || (!n.captureReplay&&!n.textureReplay&&(n.blend==='normal'||!!n.passthrough&&n.blend==='pass-through')&&
    !n.effects.some(e=>e.visible&&(e.kind==='background-blur'||e.kind==='glass'))&&n.children.every(independent))
  checked.set(id,result);return result
 }
 let changed=false
 const result:string[]=[]
 const append=(id:string)=>{
  const n=scene.nodes[id],mask=n?.maskId?scene.nodes[n.maskId]:undefined
  const identityMask=!n?.maskId||!!mask&&mask.maskType==='shape'&&mask.opacity===1&&
    !mask.children.length&&mask.fill.count>0&&covers(mask.fill.opaqueRect,region)
  if(n&&n.children.length&&!n.mask&&identityMask&&(!n.clip||covers(n.fill.opaqueRect,region))&&
      n.opacity===1&&!n.fills.some(p=>p.visible)&&!n.strokes.length&&!n.effects.some(e=>e.visible)&&independent(id)){
    changed=true
    for(const child of n.children)if(child!==n.maskId)append(child)
  }else result.push(id)
 }
 ids.forEach(append)
 return changed?result:ids
}
