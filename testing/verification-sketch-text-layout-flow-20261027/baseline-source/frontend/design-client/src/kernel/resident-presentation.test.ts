import { expect, test } from 'vitest'
import { blank } from '../model'
import type { PresentedFrame } from './Surface'
import { ResidentPresentation, type ResidentAcknowledgement } from './resident-presentation'
import { presentationContentMatches, presentationMatches } from './presentation'

const source = (): PresentedFrame => {
  const document = blank()
  return { document, pageId: document.pages[0].id, epoch: 1, view: { x: 0, y: 0, zoom: 1 },
    width: 1000, height: 720, pixelRatio: 2, managed: false, computeBackend: 'webgpu' }
}
const acknowledgement = (presentationId: string | undefined, view = { x: 12, y: 25, zoom: 1 }): ResidentAcknowledgement =>
  ({ presentationId, view, width: 1000, height: 720, dpr: 2, interaction: false, ids: [1, 2] })

test('only an acknowledged camera owns overlay coordinates, without certifying newer input', () => {
  const tracker = new ResidentPresentation(), frame = source(), id = tracker.stage(frame)
  const actual = tracker.resolve(acknowledgement(id))!
  expect(actual.view).toEqual({ x: 12, y: 25, zoom: 1 })
  expect(actual.preview).toBe(true)
  const requested = { ...frame, view: { x: 80, y: 90, zoom: 2 } }
  expect(presentationContentMatches(actual, requested)).toBe(true)
  expect(presentationMatches(actual, requested)).toBe(false)
})

test('camera-only previews reuse one context during arbitrarily long gestures', () => {
  const tracker = new ResidentPresentation(), frame = { ...source(), preview: true }
  const id = tracker.stage(frame)
  for (let x = 1; x < 1000; x++) expect(tracker.stage({ ...frame, view: { ...frame.view, x } })).toBe(id)
  expect(tracker.resolve(acknowledgement(id, { x: 900, y: 0, zoom: 1 }))?.view.x).toBe(900)
})

test('late replies retain their own document and cannot roll back a newer acknowledged context', () => {
  const tracker = new ResidentPresentation(), a = source(), b = { ...source(), epoch: 2 }
  const old = tracker.stage(a), current = tracker.stage(b)
  expect(tracker.resolve(acknowledgement(old))?.document).toBe(a.document)
  const next = tracker.resolve(acknowledgement(current))!
  expect(next.document).toBe(b.document)
  expect(presentationContentMatches(next, a)).toBe(false)
  expect(tracker.resolve(acknowledgement(old))).toBeUndefined()
  expect(tracker.resolve(acknowledgement('other-presenter:1'))).toBeUndefined()
})

test('native completion is a distinct acknowledgement from a reprojected preview', () => {
  const tracker = new ResidentPresentation(), frame = source()
  const preview = tracker.stage({ ...frame, preview: true }), exact = tracker.stage(frame)
  expect(exact).not.toBe(preview)
  expect(tracker.resolve(acknowledgement(preview, frame.view))?.preview).toBe(true)
  expect(tracker.resolve(acknowledgement(exact, frame.view))?.preview).toBe(false)
})

test('content contract matching preserves document, epoch, viewport and sampling guards', () => {
  const frame = source()
  for (const patch of [{ document: blank() }, { epoch: 2 }, { pageId: 'other' }, { width: 999 }, { pixelRatio: 1 }, { checkerboard: true }])
    expect(presentationContentMatches(frame, { ...frame, ...patch })).toBe(false)
})

const document=blank()
const frame=(x:number):PresentedFrame=>({document,pageId:document.pages[0].id,epoch:1,view:{x,y:0,zoom:1},width:100,height:80,pixelRatio:2,managed:false})
const ack=(presentationId:string, x:number):ResidentAcknowledgement=>({presentationId,view:{x,y:0,zoom:1},width:100,height:80,dpr:2,interaction:false,ids:[]})

test('a late snapshot keeps its pixel owner without allowing an old display acknowledgement',()=>{
  const presentation=new ResidentPresentation(),first=presentation.stage(frame(0))!
  presentation.resolve(ack(first,0))
  const resolveSnapshot=presentation.snapshotResolver()
  const second=presentation.stage(frame(12))!
  presentation.resolve(ack(second,12))
  expect(presentation.resolve(ack(first,0))).toBeUndefined()
  const captured=resolveSnapshot(ack(first,3.75))!
  expect(captured.document).toBe(document);expect(captured.view.x).toBe(3.75)
  expect(captured.preview).toBe(true)
  expect(resolveSnapshot(ack(second,12))).toBeUndefined()
  expect(presentation.resolve(ack(second,12))?.view.x).toBe(12)
})

test('capture ownership survives acknowledgement retirement without retaining a growing display history',()=>{
  const presentation=new ResidentPresentation(),first=presentation.stage(frame(0))!
  const resolveSnapshot=presentation.snapshotResolver()
  for(let i=1;i<=160;i++){
    const id=presentation.stage(frame(i))!
    expect(presentation.resolve(ack(id,i))?.view.x).toBe(i)
  }
  expect(resolveSnapshot(ack(first,0))?.view.x).toBe(0)
  expect(presentation.resolve(ack(first,0))).toBeUndefined()
})


test('same-document UI generations have distinct ACK identities and late ACKs cannot overwrite the newer UI',()=>{
 const presentation=new ResidentPresentation(),base={...source(),gpuOverlay:true,gpuOverlayIdentity:'ui-A'}
 const first=presentation.stage(base)!,second=presentation.stage({...base,gpuOverlayIdentity:'ui-B'})!
 expect(second).not.toBe(first)
 const old={...acknowledgement(first),gpuOverlay:true},current={...acknowledgement(second),gpuOverlay:true}
 expect(presentation.resolve(old)?.gpuOverlayIdentity).toBe('ui-A')
 expect(presentation.resolve(current)?.gpuOverlayIdentity).toBe('ui-B')
 expect(presentation.resolve(old)).toBeUndefined()
})


test('completed capture cohorts separate same-UI true-to-true ACKs even when slots are reused',()=>{
 const tracker=new ResidentPresentation(),base={...source(),preview:true,gpuOverlay:true,gpuOverlayIdentity:'same-ui'}
 const S={slots:[11]},C={slots:[11]},first=tracker.stage({...base,gpuOverlayCapture:S})!
 const second=tracker.stage({...base,gpuOverlayCapture:C})!
 expect(second).not.toBe(first)
 const actual=(presentationId:string)=>({...acknowledgement(presentationId),interaction:true,gpuOverlay:true,ids:[11,72]})
 expect(tracker.resolve(actual(first))?.gpuOverlayCapture).toBe(S)
 expect(tracker.resolve(actual(second))?.gpuOverlayCapture).toBe(C)
 expect(tracker.resolve(actual(first))).toBeUndefined()
 // Camera-only repaint of this same cohort still uses the bounded context.
 for(let x=0;x<200;x++)expect(tracker.stage({...base,view:{...base.view,x},gpuOverlayCapture:C})).toBe(second)
})

test('capture ACK coverage permits page tiles, ordering and duplicates but rejects a missing capture slot',()=>{
 const tracker=new ResidentPresentation(),base={...source(),gpuOverlay:true,gpuOverlayIdentity:'same-ui'}
 const first=tracker.stage({...base,gpuOverlayCapture:{slots:[11]}})!
 const C={slots:[21,22]},second=tracker.stage({...base,gpuOverlayCapture:C})!
 const actual=(presentationId:string,ids:number[])=>({...acknowledgement(presentationId),gpuOverlay:true,ids})
 expect(tracker.resolve(actual(second,[90,21,21]))).toBeUndefined()
 // Rejection must not advance the acknowledged serial.
 expect(tracker.resolve(actual(first,[11,90]))).toBeDefined()
 expect(tracker.resolve(actual(second,[90,22,21,22]))?.gpuOverlayCapture).toBe(C)
 expect(tracker.resolve(actual(first,[11,90]))).toBeUndefined()
})

test('historical capture readback keeps its own cohort without advancing or regressing display ACKs',()=>{
 const tracker=new ResidentPresentation(),base={...source(),gpuOverlay:true,gpuOverlayIdentity:'same-ui'}
 const S={slots:[11]},C={slots:[21]},first=tracker.stage({...base,gpuOverlayCapture:S})!
 const resolveSnapshot=tracker.snapshotResolver()
 const second=tracker.stage({...base,gpuOverlayCapture:C})!
 const actual=(presentationId:string,ids:number[])=>({...acknowledgement(presentationId),gpuOverlay:true,ids})
 expect(tracker.resolve(actual(second,[21]))?.gpuOverlayCapture).toBe(C)
 expect(resolveSnapshot(actual(first,[11]))?.gpuOverlayCapture).toBe(S)
 expect(resolveSnapshot(actual(first,[21]))).toBeUndefined()
 expect(resolveSnapshot(actual(second,[21]))).toBeUndefined()
 expect(tracker.resolve(actual(first,[11]))).toBeUndefined()
 expect(tracker.resolve(actual(second,[21]))?.gpuOverlayCapture).toBe(C)
})


test('ACK admission rejects only known retired or incomplete capture contexts',()=>{
 const tracker=new ResidentPresentation(),base={...source(),gpuOverlayCapture:{slots:[11]}}
 const first=tracker.stage(base)!,second=tracker.stage({...base,gpuOverlayCapture:{slots:[22]}})!
 const actual=(presentationId:string|undefined,ids:number[])=>({...acknowledgement(presentationId),ids})
 expect(tracker.rejectsAcknowledgement(actual(undefined,[]))).toBe(false)
 expect(tracker.rejectsAcknowledgement(actual('untracked-worker-frame',[]))).toBe(false)
 expect(tracker.rejectsAcknowledgement(actual(second,[11]))).toBe(true)
 expect(tracker.rejectsAcknowledgement(actual(first,[11]))).toBe(false)
 tracker.resolve(actual(second,[22]))
 expect(tracker.rejectsAcknowledgement(actual(first,[11]))).toBe(true)
 expect(tracker.rejectsAcknowledgement(actual(second,[22,55]))).toBe(false)
})
