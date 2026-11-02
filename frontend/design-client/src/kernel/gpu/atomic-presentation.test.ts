import { afterEach, expect, test, vi } from 'vitest'
import { descriptorPresenter } from '../descriptor-presenter.test-helper'
import type { ResidentFrame } from './resident-presenter'
afterEach(()=>vi.unstubAllGlobals())
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
function fixture(){
 const f=descriptorPresenter(()=>{},true),tile=f.presenter.capture(16,16,undefined,{owner:{},contract:'page'})
 const frame=(x:number):ResidentFrame=>({view:{x,y:0,zoom:1},width:16,height:16,dpr:1,
  cameraPreview:{anchor:tile.id},items:[{active:true,layer:1,gutter:0,tile:{key:'t',serial:1,gpuTile:tile.id,x:0,y:0,width:16,height:16,zoom:1}}]})
 return{...f,frame}
}
test('immutable images wait for actual GPU completion and one browser handoff bounds the mailbox',async()=>{
 const f=fixture();f.presenter.draw(f.frame(0));const submitted=f.queue.epoch
 expect(f.reports.some(row=>row.presented)).toBe(false)
 for(let x=1;x<=40;x++)f.presenter.draw(f.frame(x))
 expect(f.queue.epoch).toBe(submitted)
 const pending=(f.presenter as any).bitmapPending
 f.presenter.acceptPresentation(pending.token);expect((f.presenter as any).bitmapPending).toBe(pending)
 f.queue.completeThrough(submitted);await flush()
 const first=f.reports.at(-1) as any
 expect(first).toMatchObject({atomicPresentation:true,presented:{view:{x:0}}})
 expect(first.bitmap.width).toBe(16)
 f.presenter.acceptPresentation(first.presented.presentationToken+1000)
 expect(f.queue.epoch).toBe(submitted)
 first.bitmap.close();f.presenter.acceptPresentation(first.presented.presentationToken)
 expect(f.queue.epoch).toBeGreaterThan(submitted)
 expect(f.presenter.residentBytes).toBe(4*16*16*4) // tile, content backing, accepted and pending image
 f.queue.completeThrough(f.queue.epoch);await flush()
 const last=f.reports.at(-1) as any
 expect(last.presented.view.x).toBe(40)
 last.bitmap.close();f.presenter.acceptPresentation(last.presented.presentationToken)
 expect(f.presenter.residentBytes).toBe(3*16*16*4)
})
test('discarded handoffs cannot retire the image the browser is still displaying',async()=>{
 const f=fixture();f.presenter.draw(f.frame(0));f.queue.completeThrough(f.queue.epoch);await flush()
 const first=f.reports.at(-1) as any;first.bitmap.close();f.presenter.acceptPresentation(first.presented.presentationToken)
 const visible=(f.presenter as any).bitmapVisible
 f.presenter.draw(f.frame(8));f.queue.completeThrough(f.queue.epoch);await flush()
 const rejected=f.reports.at(-1) as any;rejected.bitmap.close();f.presenter.acceptPresentation(rejected.presented.presentationToken,false)
 expect((f.presenter as any).bitmapVisible).toBe(visible)
 expect((f.presenter as any).bitmapPending).toBeUndefined()
})
test('dispose revokes late immutable-image deliveries',async()=>{
 const f=fixture();f.presenter.draw(f.frame(0));f.presenter.dispose()
 f.queue.completeThrough(f.queue.epoch);await flush()
 expect(f.reports.some(row=>row.bitmap)).toBe(false)
 expect(f.presenter.payloadStats.closed).toBe(1)
})
test('reattachment cannot publish the old canvas transfer or reuse its handoff token',async()=>{
 const f=fixture();f.presenter.draw(f.frame(0));const oldEpoch=f.queue.epoch,oldToken=(f.presenter as any).bitmapPending.token
 const next=new (f.canvas.constructor as new(w:number,h:number)=>typeof f.canvas)(16,16)
 f.presenter.attachCanvas(next as unknown as OffscreenCanvas,true)
 f.queue.completeThrough(oldEpoch);await flush()
 expect(f.reports.some(row=>row.bitmap)).toBe(false)
 f.queue.completeThrough(f.queue.epoch);await flush()
 const current=f.reports.at(-1) as any
 expect(current.bitmap).toBeDefined();expect(current.presented.presentationToken).not.toBe(oldToken)
 current.bitmap.close();f.presenter.acceptPresentation(current.presented.presentationToken)
})
test('repeated accepted transfers keep only one visible image and release retirement credits',async()=>{
 const f=fixture()
 for(let i=0;i<50;i++){
  f.presenter.draw(f.frame(i));f.queue.completeThrough(f.queue.epoch);await flush()
  const image=f.reports.at(-1) as any;image.bitmap.close();f.presenter.acceptPresentation(image.presented.presentationToken)
  await flush()
  expect(f.presenter.residentBytes).toBe(3*16*16*4)
  expect(f.presenter.payloadStats.retiringBytes).toBe(0)
 }
})
