import type {Driver,GpuNode,GpuPaint,GpuScene,Rect} from './types'
import {intersect} from './types'

/** Production “refine full artboard” compiles an analytic snapshot with no
 * document color-management block. That scene is not coherent and has no
 * sRGB document space, so `sourceSolidLayerDisplay` never admits it. The
 * float compositor is still the driver (`float_compositing` is set for the
 * analytic profile). This gate is that path, and only that path. */
export function analyticViewportBatch(scene:GpuScene,driver:Pick<Driver,'name'|'managed'|'hdr'|'displayMath'>,displayOnly:boolean){
  return import.meta.env.VITE_DESIGN_ANALYTIC_VIEWPORT_BATCH!=='0'&&displayOnly&&driver.name==='webgpu'&&
    driver.managed===true&&!driver.hdr&&!driver.displayMath&&scene.coherentSamples!==true&&!scene.colorManagement&&
    !scene.softwareRaster&&!scene.interactionRetained&&!scene.resolve&&!scene.presentation
}

function finiteUnit(value:number){
  const rounded=Math.fround(value)
  return Number.isFinite(rounded)&&rounded>=0&&rounded<=1
}
function integerRect(rect:Rect){
  return [rect.x,rect.y,rect.w,rect.h].every(value=>Number.isSafeInteger(value)&&Math.abs(value)<=1_048_576)
}

/** Opaque solid area leaves already painted by managed `paintOver` + mode 47.
 * The quad is the same intersection as `exactSolidPaintRegion` against the
 * target. Anything else stays on the ordinary node path. */
export function analyticSolidQuad(node:GpuNode|undefined,target:Rect,color:(value:string)=>readonly number[],alpha:(value:string)=>number):Rect|undefined{
  const paint:GpuPaint|undefined=node?.fills[0]
  const path=node?.fill
  if(!node||!paint||!path?.area||path.area.count<=0||!Number.isSafeInteger(path.area.first)||path.area.first<0||path.area.first>16_777_216)return
  if(node.opacity!==1||node.blend!=='normal'||node.passthrough||node.mask||node.maskId||node.clip||
    node.children.length||node.effects.length||node.strokes.length||node.fills.length!==1)return
  if(!paint.visible||paint.kind!=='solid'||paint.blend!=='normal'||!finiteUnit(paint.opacity)||!finiteUnit(alpha(paint.color)))return
  const channels=color(paint.color)
  if(channels.length!==3||!channels.every(finiteUnit))return
  if(!integerRect(node.rect)||!integerRect(path.rect)||!integerRect(target))return
  const quad=intersect(intersect(node.rect,path.rect),target)
  return quad.w&&quad.h?quad:undefined
}

/** Half-open pixel rects. A shared edge does not cover the same pixel. */
export function rectsOverlap(a:Rect,b:Rect){
  return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h
}

export function unionRect(rects:readonly Rect[]):Rect{
  const x=Math.min(...rects.map(rect=>rect.x)),y=Math.min(...rects.map(rect=>rect.y))
  return {x,y,
    w:Math.max(...rects.map(rect=>rect.x+rect.w))-x,
    h:Math.max(...rects.map(rect=>rect.y+rect.h))-y}
}

/** Stop before a non-leaf or a rect that would read a destination this batch
 * has not written yet. One instanced pass samples the pre-batch copy. */
export function takeAnalyticSolids(nodes:readonly (GpuNode|undefined)[],target:Rect,color:(value:string)=>readonly number[],alpha:(value:string)=>number,max:number){
  const quads:Rect[]=[]
  let count=0
  while(count<nodes.length&&count<max){
    const quad=analyticSolidQuad(nodes[count],target,color,alpha)
    if(!quad||quads.some(previous=>rectsOverlap(previous,quad)))break
    quads.push(quad)
    count++
  }
  return {quads,count}
}

/** Rows match the solid-instance layout: path rect, program/opacity, unused,
 * straight RGBA factors, clipped quad. The fragment applies the same mulRN
 * product as mode 47; these factors are not premultiplied here. */
export function analyticSolidInstances(nodes:readonly GpuNode[],quads:readonly Rect[],color:(value:string)=>readonly number[],alpha:(value:string)=>number){
  const out=new Float32Array(nodes.length*20)
  nodes.forEach((node,index)=>{
    const paint=node.fills[0],path=node.fill,quad=quads[index],channels=color(paint.color)
    const at=index*20
    out[at]=path.rect.x;out[at+1]=path.rect.y;out[at+2]=path.rect.w;out[at+3]=path.rect.h
    out[at+4]=path.area!.first;out[at+5]=Math.fround(paint.opacity)
    out[at+12]=Math.fround(channels[0]);out[at+13]=Math.fround(channels[1]);out[at+14]=Math.fround(channels[2]);out[at+15]=Math.fround(alpha(paint.color))
    out[at+16]=quad.x;out[at+17]=quad.y;out[at+18]=quad.w;out[at+19]=quad.h
  })
  return out
}
