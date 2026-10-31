import type { PresentedFrame } from './Surface'
type Reader = {
  pixel: (u:number,v:number)=>Promise<number[]>
  capture: ()=>Promise<{bitmap:ImageBitmap;frame?:PresentedFrame}>
}
const readers=new WeakMap<HTMLCanvasElement,Reader>()
export function registerContentPlane(canvas:HTMLCanvasElement,reader:Reader){readers.set(canvas,reader);return()=>readers.delete(canvas)}
export function contentPlane(canvas:HTMLCanvasElement){return readers.get(canvas)}
export async function captureContentPlane(canvas:HTMLCanvasElement):Promise<{bitmap:ImageBitmap;frame?:PresentedFrame}>{
  const reader=readers.get(canvas)
  return reader?reader.capture():{bitmap:await createImageBitmap(canvas)}
}
