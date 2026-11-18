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
test('only a pose waiting to submit its display copy holds the next raster', async () => {
 const f=fixture()
 const frame=f.frame(0),slot=frame.items[0].tile.gpuTile
 f.presenter.draw({...frame,interaction:true,input:{sequence:1,at:1}})
 expect(f.presenter.hasDeferredPosePresentation(slot)).toBe(false)
 f.presenter.draw({...frame,interaction:true,input:{sequence:2,at:2}})
 expect(f.presenter.hasDeferredPosePresentation(slot)).toBe(true)
 expect(f.presenter.hasDeferredPosePresentation(slot+1)).toBe(false)
 f.queue.completeThrough(f.queue.epoch);await flush()
 const previous=f.reports.at(-1) as any
 previous.bitmap.close()
 f.presenter.acceptPresentation(previous.presented.presentationToken)
 expect(f.presenter.hasDeferredPosePresentation(slot)).toBe(false)
 f.queue.completeThrough(f.queue.epoch);await flush()
 const current=f.reports.at(-1) as any
 expect(current.input.sequence).toBe(2)
 current.bitmap.close()
 f.presenter.acceptPresentation(current.presented.presentationToken)
})
test('a queued exact snapshot waits for the browser to hand off the previous frame', async () => {
 const f = fixture()
 const previous = {...f.frame(0), interaction:true, input:{sequence:4,at:1}}
 const exact = {...f.frame(0), interaction:true, input:{sequence:5,at:2}}
 f.presenter.draw(previous)
 const previousEpoch = f.queue.epoch
 f.presenter.draw(exact)
 let resumed = false
 const pending = f.presenter.waitForQueuedFrame(exact)?.then(() => { resumed = true })
 expect(pending).toBeDefined()
 f.queue.completeThrough(previousEpoch)
 await flush()
 expect(resumed).toBe(false)
 expect(f.queue.epoch).toBe(previousEpoch)
 const image = f.reports.at(-1) as any
 image.bitmap.close()
 f.presenter.acceptPresentation(image.presented.presentationToken)
 await pending
 const snapshot = f.presenter.snapshot()
 expect(snapshot?.frame).toBe(exact)
 expect(f.queue.epoch).toBeGreaterThan(previousEpoch)
 if (snapshot) f.presenter.release([snapshot.gpuTile])
 f.presenter.dispose()
})
test('a cancelled snapshot wait leaves the existing presentation available', async () => {
 const f = fixture()
 f.presenter.draw(f.frame(0))
 const next = f.frame(1)
 f.presenter.draw(next)
 const controller = new AbortController()
 const waiting = f.presenter.waitForQueuedFrame(next, controller.signal)
 expect(waiting).toBeDefined()
 controller.abort()
 await waiting
 const other = f.presenter.waitForQueuedFrame(next)
 expect(other).toBeDefined()
 f.presenter.dispose()
 await other
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

test('a copied overview tile holds its capture reservation through the browser handoff',async()=>{
 const f=descriptorPresenter(()=>{},true)
 const tile=f.presenter.capture(256,256,undefined,{owner:{},contract:'page'})
 f.presenter.draw({view:{x:0,y:0,zoom:1},width:256,height:256,dpr:1,
   cameraPreview:{anchor:tile.id},items:[{active:true,layer:1,gutter:0,tile:{key:'page',serial:1,gpuTile:tile.id,x:0,y:0,width:256,height:256,zoom:1}}]})
 f.queue.completeThrough(f.queue.epoch);await flush()
 const frame=f.reports.at(-1) as any
 expect(frame.presented.navigationBackingBytes).toBe(1024*1024)
 frame.bitmap.close();f.presenter.acceptPresentation(frame.presented.presentationToken)
 const pending=f.presenter.captureNavigationTile(tile.id,719)
 await expect(f.presenter.captureNavigationTile(tile.id,720)).rejects.toThrow(/unavailable/)
 f.queue.completeThrough(f.queue.epoch);const result=await pending
 expect(result.navigationToken).toBe(719)
 expect(f.presenter.payloadStats).toMatchObject({pendingCaptures:1,captureReservedBytes:256*256*4})
 f.presenter.releaseNavigationTransfer(720)
 expect(f.presenter.payloadStats.pendingCaptures).toBe(1)
 result.bitmap.close();f.presenter.releaseNavigationTransfer(719);await flush()
 expect(f.presenter.payloadStats).toMatchObject({pendingCaptures:0,captureReservedBytes:0})
})

test('complete interaction viewport can become a tile without replacing the browser image', () => {
  const f = fixture(), previous = f.frame(0)
  f.presenter.draw(previous)
  const before = f.queue.epoch
  const exact = { ...previous, cameraPreview: undefined, interaction: true, input: { sequence: 9, at: 2 } }
  const old = (f.presenter as any).bitmapPending
  const snapshot = f.presenter.captureInteractionViewport(exact)
  expect(snapshot?.frame).toBe(exact)
  expect(f.queue.epoch).toBe(before + 1)
  expect((f.presenter as any).bitmapPending).toBe(old)
  expect(f.reports.some(row => row.bitmap)).toBe(false)
  f.presenter.release([snapshot!.gpuTile])
  const partial = { ...exact, items: [{ ...exact.items[0], clip: { left: 0, top: 0, width: 8, height: 16 } }] }
  expect(f.presenter.captureInteractionViewport(partial)).toBeUndefined()
  expect(f.presenter.captureInteractionViewport({ ...exact, interaction: false })).toBeUndefined()
  expect(f.queue.epoch).toBe(before + 1)
  f.presenter.dispose()
})


test('a released pose supersedes queued motion without discarding the submitted browser image', async () => {
  const f = fixture()
  const base = f.frame(0), slot = base.items[0].tile.gpuTile
  const old = { ...base, interaction: true, input: { owner: 'gesture', sequence: 1, at: 1 } }
  f.presenter.draw(old)
  const before = f.queue.epoch
  const later = { ...old, input: { ...old.input, sequence: 2 } }
  f.presenter.draw(later)
  f.presenter.cancelQueuedPoseRepaint(later, slot, 'gesture', 3)
  f.queue.completeThrough(before)
  await flush()
  const image = f.reports.at(-1) as any
  expect(image.input.sequence).toBe(1)
  image.bitmap.close()
  f.presenter.acceptPresentation(image.presented.presentationToken)
  expect(f.queue.epoch).toBe(before)
  f.presenter.draw({ ...later, input: { ...later.input, sequence: 3 } })
  expect(f.queue.epoch).toBeGreaterThan(before)
  f.presenter.dispose()
})


test('an exact composed viewport is copied on the same pixel lattice and resampled after zoom', async () => {
  const f = fixture()
  const original = { ...f.frame(0), cameraPreview: undefined }
  const pose = { ...original, interaction: true, input: { sequence: 4, at: 2 } }
  const capture = f.presenter.captureInteractionViewport(pose)!
  const tile = { ...original.items[0].tile, gpuTile: capture.gpuTile }
  const exact = { ...original, interaction: false, items: [{ ...original.items[0], tile }] }
  f.presenter.draw(exact)
  f.queue.completeThrough(f.queue.epoch)
  await flush()
  const first = f.reports.at(-1) as any
  expect(first.compositorDraws).toBe(0)
  first.bitmap.close()
  f.presenter.acceptPresentation(first.presented.presentationToken)
  f.presenter.draw({ ...exact, view: { ...exact.view, zoom: 1.25 } })
  f.queue.completeThrough(f.queue.epoch)
  await flush()
  const zoomed = f.reports.at(-1) as any
  expect(zoomed.presented.view.zoom).toBe(1.25)
  expect(zoomed.compositorDraws).toBeGreaterThan(0)
  zoomed.bitmap.close()
  f.presenter.acceptPresentation(zoomed.presented.presentationToken)
  f.presenter.dispose()
})
