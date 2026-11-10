import type {Rect} from './types'
export type GaussianRegion={source:Rect;output:Rect;radii:[number,number,number];factor?:2|4|8;fullOutput?:Rect}
/** Unmanaged byte mode 22 already sums an integer uniform box from the radius.
 *  Radii in (512, 1024] belong to the existing regional admission. They must
 *  not call uniform_box and must not require the managed float prefix. */
export function unmanagedByteGaussianBox(managed:boolean|undefined,hdr:boolean|undefined,displayMath:boolean|undefined,channels:number,radius:number,format:string|undefined,scalar:boolean|undefined,binary:boolean|undefined){
  return managed===false&&hdr!==true&&displayMath!==true&&channels===15&&scalar!==true&&binary!==true&&format==='rgba8unorm'&&Number.isInteger(radius)&&radius>512&&radius<=1024
}
/** Complete six-pass support, with the first source kept virtual. Every stored
 * intermediate obeys the pre-existing 16 MP surface ceiling. */
export function gaussianRegionRects(plan:GaussianRegion):Rect[]|undefined{
 const {source,output,radii}=plan
 if(!Array.isArray(radii)||radii.length!==3||!radii.every(r=>Number.isSafeInteger(r)&&r>0&&r<=1024))return
 if(plan.factor!==undefined){
  const f=plan.factor,o=plan.fullOutput
  if(![2,4,8].includes(f)||!o||![o.x,o.y,o.w,o.h].every(Number.isSafeInteger)||o.w<1||o.h<1||o.w>1024||o.h>1024||
    [o.x,o.y,o.x+o.w,o.y+o.h].some(v=>Math.abs(v)>1048576))return
  const x=Math.floor(o.x/f)-2,y=Math.floor(o.y/f)-2,right=Math.ceil((o.x+o.w)/f)+2,bottom=Math.ceil((o.y+o.h)/f)+2
  if(output.x!==x||output.y!==y||output.w!==right-x||output.h!==bottom-y||radii.some(r=>r<32||r>512))return
 }else if(plan.fullOutput!==undefined)return
 if(![source,output].every(r=>[r.x,r.y,r.w,r.h].every(Number.isSafeInteger)&&r.w>0&&r.h>0&&r.w<=8192&&r.h<=8192&&
   [r.x,r.y,r.x+r.w,r.y+r.h].every(v=>Math.abs(v)<=1048576)))return
 const support=radii.reduce((a,b)=>a+b,0)
 if(source.x!==output.x-support||source.y!==output.y-support||source.w!==output.w+support*2||source.h!==output.h+support*2)return
 const regions=[{...source}]
 for(const r of radii)for(const axis of [0,1]){
  const previous=regions.at(-1)!,next={...previous}
  if(axis===0){next.x+=r;next.w-=2*r}else{next.y+=r;next.h-=2*r}
  if(next.w<1||next.h<1||next.w*next.h>16777216)return
  regions.push(next)
 }
 return regions
}
