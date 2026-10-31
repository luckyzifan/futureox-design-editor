import { useLayoutEffect, useEffect, useState, useRef, type RefObject } from 'react'
import { contentPlane } from './kernel/content-plane'
import type { Editor } from './engine'
import type { PropertyPreviewLease } from './property-preview'
import { paint } from './model'
import { commitPendingEdits } from './pending-edits'
import { desktopBridge } from './desktop'
import { clearWholeTextRunColor } from './text'

export type SampleColorModel = 'HEX' | 'RGB' | 'HSL' | 'HSB'
export const sampleColorModels: SampleColorModel[] = ['HEX','RGB','HSL','HSB']
const models = new WeakMap<Editor, SampleColorModel>()
export function sampleColorLabel(hex: string, model: SampleColorModel): string {
  const rgb = [1,3,5].map(at=>parseInt(hex.slice(at,at+2),16))
  if(model==='HEX')return hex.toUpperCase()
  if(model==='RGB')return `rgb(${rgb.join(', ')})`
  const [r,g,b]=rgb.map(v=>v/255), max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, light=(max+min)/2
  const hue=d===0?0:((max===r?(g-b)/d:max===g?(b-r)/d+2:(r-g)/d+4)*60+360)%360
  const saturation=model==='HSB'?(max===0?0:d/max):(d===0?0:d/(1-Math.abs(2*light-1)))
  return `${model.toLowerCase()}(${Math.round(hue)}, ${Math.round(saturation*100)}%, ${Math.round((model==='HSB'?max:light)*100)}%)`
}

type Request = {
  session: number; page: string; version: number
  lease?: PropertyPreviewLease
  finish: (color?: string) => void
}
const pending = new WeakMap<Editor, Request>()
export const hasCanvasColorPicker = (editor: Editor) => pending.has(editor)
export function cancelCanvasColorPicker(editor: Editor) { pending.get(editor)?.finish() }
export function acceptCanvasColor(editor: Editor, color:string) {
  if(!/^#[\da-f]{6}$/i.test(color))throw new Error('取样颜色无效')
  const r=pending.get(editor)
  if(!r)return
  if((r.lease && !editor.isPropertyPreviewCurrent(r.lease))||r.session!==editor.sessionGeneration||r.page!==editor.state.page||r.version!==editor.state.version){r.finish();return}
  r.finish(color)
}

/** A local picker reads the published canvas, not authored fill/stroke data.
 * Electron exposes EyeDropper in some builds without a working native chooser. */
export function requestCanvasColor(editor: Editor, signal?: AbortSignal, lease?: PropertyPreviewLease): Promise<{sRGBHex:string}> {
  if(editor.state.busy||(editor.interactionActive && (!lease || !editor.isPropertyPreviewCurrent(lease))))return Promise.reject(new Error('请结束当前操作后取色'))
  cancelCanvasColorPicker(editor)
  if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'))
  return new Promise((resolve,reject)=>{
    const owner:Request={session:editor.sessionGeneration,page:editor.state.page,version:editor.state.version,lease,finish(color){
      if(pending.get(editor)!==owner)return
      pending.delete(editor);signal?.removeEventListener('abort',abort)
      const restore=()=>{if(editor.state.tool==='eyedropper'&&editor.sessionGeneration===owner.session&&!pending.has(editor))editor.set({tool:'select'})}
      // Give the consumer its color before tool cleanup aborts its signal.
      if(color){resolve({sRGBHex:color});queueMicrotask(restore)}
      else{restore();reject(new DOMException('Cancelled','AbortError'))}
    }}
    const abort=()=>owner.finish()
    pending.set(editor,owner);signal?.addEventListener('abort',abort,{once:true})
    editor.set({tool:'eyedropper',message:'点击画布取色 · Esc 取消'})
  })
}

export async function pickSelectionColor(editor: Editor, signal?: AbortSignal) {
  if(!commitPendingEdits(editor))return
  const session=editor.sessionGeneration,version=editor.state.version,page=editor.state.page,
    ids=editor.topSelection(),selection=editor.state.selection.join(',')
  const {sRGBHex}=await requestCanvasColor(editor,signal)
  if(signal?.aborted||session!==editor.sessionGeneration||version!==editor.state.version||page!==editor.state.page||selection!==editor.state.selection.join(','))return
  if(ids.length)editor.updateProperties(ids,n=>{
    if(n.kind==='slice')return
    const at=n.fills.findIndex(p=>p.visible)
    if(at<0)n.fills.push(paint(sRGBHex))
    else n.fills[at]={...n.fills[at],kind:'solid',color:sRGBHex,transform:undefined}
    clearWholeTextRunColor(n)
  },'画布取色')
  else {
    const text=sampleColorLabel(sRGBHex,models.get(editor)||'HEX'), clipboard=desktopBridge()?.clipboard
    if(clipboard){const result=await clipboard.write({text});if(result.status!=='ok')throw new Error(result.status==='cancelled'?'复制颜色已取消':result.message)}
    else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text)
    else throw new Error('当前环境不能写入剪贴板')
    if(session===editor.sessionGeneration&&page===editor.state.page)editor.notify(`已复制 ${text}`)
    return
  }
  editor.notify(`已取样 ${sRGBHex.toUpperCase()}`)
}

function visible(element: HTMLElement) {
  for(let n:HTMLElement|null=element;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false}
  return true
}
const gpuReadback = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()
function pixelHex(pixel:ArrayLike<number>,canvas:HTMLCanvasElement) {
  let alpha=pixel[3]/255,rgb=[pixel[0]*alpha,pixel[1]*alpha,pixel[2]*alpha]
  for(let p:HTMLElement|null=canvas;p&&alpha<1;p=p.parentElement){
    const match=getComputedStyle(p).backgroundColor.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/)
    if(!match)continue
    const a=match[4]===undefined?1:Number(match[4]),weight=(1-alpha)*a
    rgb=rgb.map((v,i)=>v+Number(match[i+1])*weight);alpha+=weight
  }
  return '#'+rgb.map(v=>Math.round(Math.max(0,Math.min(255,v+255*(1-alpha)))).toString(16).padStart(2,'0')).join('')
}
export async function canvasContentPixelAt(host:HTMLElement,x:number,y:number):Promise<string> {
  const viewport=host.getBoundingClientRect()
  if(x<viewport.left||y<viewport.top||x>=viewport.right||y>=viewport.bottom)throw Error('请在画布内取色')
  for(const canvas of [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible="true"]')].reverse()){
    const r=canvas.getBoundingClientRect()
    if(!visible(canvas)||!r.width||!r.height||x<r.left||y<r.top||x>=r.right||y>=r.bottom)continue
    const reader=contentPlane(canvas)
    if(reader)return pixelHex(await reader.pixel((x-r.left)/r.width,(y-r.top)/r.height),canvas)
    break
  }
  return canvasPixelAt(host,x,y)
}
/** Read the already-published device pixel at a CSS pointer position. */
export function canvasPixelAt(host: HTMLElement, x:number, y:number): string {
  const viewport=host.getBoundingClientRect()
  if(x<viewport.left||y<viewport.top||x>=viewport.right||y>=viewport.bottom)throw new Error('请在画布内取色')
  for(const canvas of [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible="true"]')].reverse()){
    const r=canvas.getBoundingClientRect()
    if(!canvas.width||!canvas.height||!r.width||!r.height||x<r.left||y<r.top||x>=r.right||y>=r.bottom||!visible(canvas))continue
    const ix=Math.min(canvas.width-1,Math.max(0,Math.floor((x-r.left)*canvas.width/r.width)))
    const iy=Math.min(canvas.height-1,Math.max(0,Math.floor((y-r.top)*canvas.height/r.height)))
    let context=canvas.dataset.compositor ? null : canvas.getContext('2d')
    let pixel: Uint8ClampedArray
    if(context) pixel=context.getImageData(ix,iy,1,1).data
    else {
      // GPU canvases cannot acquire a second 2D context. Copy only the requested
      // published pixel; this readback is an eyedropper operation, never a frame.
      context=gpuReadback.get(canvas) || null
      if(!context){const copy=document.createElement('canvas');copy.width=copy.height=1;context=copy.getContext('2d',{willReadFrequently:true});if(context)gpuReadback.set(canvas,context)}
      if(!context)continue
      context.clearRect(0,0,1,1);context.drawImage(canvas,ix,iy,1,1,0,0,1,1)
      pixel=context.getImageData(0,0,1,1).data
    }
    return pixelHex(pixel,canvas)
  }
  throw new Error('当前画面尚无可读取的 sRGB 像素；请等待绘制完成')
}

export function useCanvasColorPicker(editor: Editor, host: RefObject<HTMLElement|null>) {
  const [hover,setHover]=useState<{x:number;y:number;color:string}|null>(null)
  const [model,setModel]=useState<SampleColorModel>(models.get(editor)||'HEX')
  const pointer=useRef<{x:number;y:number}|null>(null)
  useLayoutEffect(()=>{
    const r=pending.get(editor)
    if(r&&(editor.state.tool!=='eyedropper'||r.session!==editor.sessionGeneration||r.page!==editor.state.page||r.version!==editor.state.version))r.finish()
    if(editor.state.tool!=='eyedropper'){setHover(null);pointer.current=null}
  },[editor,editor.state.tool,editor.state.page,editor.state.version,editor.sessionGeneration])
  useEffect(()=>{
    let alive=true,previewBusy=false,sampling=false,queued:{x:number;y:number}|null=null
    const pumpPreview=async()=>{
      if(previewBusy||sampling)return
      previewBusy=true
      try{while(alive&&queued&&editor.state.tool==='eyedropper'&&!sampling){
        const p=queued;queued=null
        try{const target=host.current;if(!target)return;const color=await canvasContentPixelAt(target,p.x,p.y)
          if(alive&&!queued&&!sampling&&editor.state.tool==='eyedropper'){const r=target.getBoundingClientRect();setHover({x:p.x-r.left,y:p.y-r.top,color})}
        }catch{if(alive&&!queued)setHover(null)}
      }}finally{previewBusy=false}
    }
    const preview=(x:number,y:number)=>{
      if(!host.current)return
      pointer.current={x,y}
      queued={x,y};void pumpPreview()
    }
    const sample=async(x:number,y:number)=>{
      if(!host.current||sampling)return
      sampling=true;queued=null
      if(!pending.has(editor))void pickSelectionColor(editor).catch(e=>{if(e?.name!=='AbortError')editor.notify(String(e))})
      const session=editor.sessionGeneration,version=editor.state.version,page=editor.state.page
      try{const color=await canvasContentPixelAt(host.current,x,y)
        if(alive&&session===editor.sessionGeneration&&version===editor.state.version&&page===editor.state.page&&editor.state.tool==='eyedropper')acceptCanvasColor(editor,color)
      }catch(e){if(alive)editor.notify(String(e))}finally{sampling=false;if(alive&&queued)void pumpPreview()}
    }
    const move=(event:PointerEvent)=>{
      if(editor.state.tool!=='eyedropper'||!host.current)return
      preview(event.clientX,event.clientY)
    }
    const down=(event:PointerEvent)=>{
      if(pending.get(editor)?.lease && (!host.current?.contains(event.target as Node) || (event.target as Element)?.closest?.('[data-property-preview]')))return
      if(editor.state.tool!=='eyedropper'||event.button!==0||!host.current)return
      event.preventDefault();event.stopImmediatePropagation()
      sample(event.clientX,event.clientY)
    }
    const key=(event:KeyboardEvent)=>{
      const lease=pending.get(editor)?.lease
      if(lease && (event.target as Element)?.closest?.('[data-property-preview]'))return
      if(lease && event.key==='Escape') {event.preventDefault();event.stopImmediatePropagation();cancelCanvasColorPicker(editor);editor.cancelProperty(lease);return}
      if(editor.state.tool==='eyedropper'&&host.current&&(event.key.startsWith('Arrow')||event.key==='Enter')){
        event.preventDefault();event.stopImmediatePropagation()
        const r=host.current.getBoundingClientRect(),p=pointer.current||{x:r.left+r.width/2,y:r.top+r.height/2}
        if(event.key==='Enter')sample(p.x,p.y)
        else{
          const step=1/(globalThis.devicePixelRatio||1)
          preview(Math.max(r.left,Math.min(r.right-step,p.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0))),
            Math.max(r.top,Math.min(r.bottom-step,p.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0))))
        }
        return
      }
      if(editor.state.tool==='eyedropper'&&event.key==='Tab'){
        event.preventDefault();event.stopImmediatePropagation()
        const current=sampleColorModels.indexOf(models.get(editor)||'HEX'), next=sampleColorModels[(current+(event.shiftKey?3:1))%4]
        models.set(editor,next);setModel(next);return
      }
      if(event.key==='Escape'&&(pending.has(editor)||editor.state.tool==='eyedropper')){event.preventDefault();event.stopImmediatePropagation();cancelCanvasColorPicker(editor);if(editor.state.tool==='eyedropper')editor.set({tool:'select'})}
    }
    window.addEventListener('pointermove',move,true);window.addEventListener('pointerdown',down,true);window.addEventListener('keydown',key,true)
    return()=>{alive=false;queued=null;window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerdown',down,true);window.removeEventListener('keydown',key,true);cancelCanvasColorPicker(editor)}
  },[editor,host])
  return hover?{...hover,label:sampleColorLabel(hover.color,model),model}:null
}
