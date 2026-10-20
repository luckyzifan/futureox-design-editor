import { expect, test, vi } from 'vitest'
import { FrameMeasurements } from './frame-measurements'
import { bindCanvasGrid, recordCanvasGrid, gridPhaseAgreement, GridMeasurements } from './grid-measurements'
import { pixelGridPathData } from '../pixel-grid'
import { residentFrameMessage } from './gpu/resident-frame'
import { readFileSync } from 'node:fs'
function fixture() { let now=0;const rows:any[]=[];const m=new FrameMeasurements((event,fields)=>rows.push({event,...fields}),()=>now,()=>10000+now);return {m,rows,at:(t:number)=>now=t} }
const view={x:1.5,y:-2.5,zoom:4}
test('RAF cadence, long frames and stalls are distinct from idle submissions',()=>{
 const f=fixture();f.m.raf(0);f.m.raf(16);f.m.raf(80);f.m.raf(400);f.at(1000);f.m.tick()
 expect(f.rows[0]).toMatchObject({uiFrames:4,softwareSubmits:0,uiLongFrames:2,uiStalls:1,uiIntervalP95Ms:1000,uiIntervalMaxMs:320})
 expect(JSON.stringify(f.rows)).not.toMatch(/failure|displayFps|x"|y"/)
})
test('worker timestamp cadence and input age ignore main IPC arrival delay; deduplicate same input',()=>{
 const f=fixture();f.m.request(1,view,{inputSequence:3,inputAt:5,inputTimeOrigin:10000});f.at(100);f.m.submit(1,view,2,10025);f.at(900);f.m.submit(1,view,2,10041);f.at(1000);f.m.tick()
 expect(f.rows[0]).toMatchObject({softwareSubmits:2,inputPresentCount:1,inputPresentMaxMs:20,submitIntervalMaxMs:16,sameCameraSubmits:1,transformMismatch:0})
})
test('ordering, mismatch and phase indicators do not claim visual jitter',()=>{
 const f=fixture();f.m.request(1,view);f.m.request(2,view);f.m.submit(2,view,2,10010);f.m.submit(1,{...view,x:1.75},2,10020);f.at(1000);f.m.tick()
 expect(f.rows[0]).toMatchObject({staleCameraSubmits:1,outOfOrderSubmits:1,transformMismatch:1,phaseChanges:1,changedCameraSubmits:1})
})
test('hidden time and reset remove stale camera/input correlation',()=>{
 const f=fixture();f.m.raf(0);f.at(20);f.m.visibility(false);f.at(5000);f.m.raf();f.m.visibility(true);f.m.raf();f.at(6000);f.m.tick()
 expect(f.rows.at(-1)).toMatchObject({windowMs:1000,uiFrames:1,uiStalls:0,uiIntervalMaxMs:0})
 f.m.request(9,view,{inputSequence:1,inputAt:0,inputTimeOrigin:10000});f.m.reset();f.m.submit(9,view,1,16001);f.at(7000);f.m.tick();expect(f.rows.at(-1).uncorrelatedSubmits).toBe(1)
})
test('sampler boundary preserves each event once and cross-boundary interval',()=>{
 const f=fixture();f.m.raf(999);f.at(1000);f.m.raf(1000);f.at(2000);f.m.raf(2000)
 expect(f.rows.map(r=>r.uiFrames)).toEqual([2,1]);expect(f.rows[1].uiIntervalMaxMs).toBe(1000)
})
test('request correlation evicts at 256 and pending age exposes no-submit case',()=>{
 const f=fixture();for(let i=1;i<=257;i++)f.m.request(i,view,{inputSequence:i,inputAt:i,inputTimeOrigin:10000})
 f.m.submit(1,view,1,10300);f.at(1000);f.m.tick();expect(f.rows[0]).toMatchObject({uncorrelatedSubmits:1,pendingInputAgeMs:743})
})
test('grid sinks scope and release; SVG world-integer phase agrees with GPU loop',()=>{
 const owner={},rows:any[]=[];const stop=bindCanvasGrid(owner,row=>rows.push(row));recordCanvasGrid({}, {gridKind:2});recordCanvasGrid(owner,{gridKind:2});stop();recordCanvasGrid(owner,{gridKind:2});expect(rows).toHaveLength(1)
 for(const x of [-17.3,-1.5,0,9.7]) {const camera={x,y:2.3,zoom:4.2};const path=pixelGridPathData(camera,100,100,true);const first=Number(path.match(/^M([^,]+)/)![1])*camera.zoom+x;const gpu=x-Math.floor(x/camera.zoom)*camera.zoom;expect(gridPhaseAgreement(first,gpu,2)).toBe(true)}
 expect(gridPhaseAgreement(0,0.25,2)).toBe(false)
})
test('production explicit wire carries numeric sequence only; actual post-submit hook and lifecycle remain attached',()=>{
 const wire=residentFrameMessage({view,width:10,height:10,dpr:1,items:[],diagnosticSequence:4} as any);expect(wire.diagnosticSequence).toBe(4)
 expect(residentFrameMessage({...wire,diagnosticSequence:'secret'} as any).diagnosticSequence).toBeUndefined()
 const presenter=readFileSync(new URL('./gpu/resident-presenter.ts',import.meta.url),'utf8');expect(presenter).toMatch(/queue.submit\(\[encoder.finish\(\)\]\)\s+const submittedEpoch/)
 const client=readFileSync(new URL('./client.ts',import.meta.url),'utf8');expect(client).toContain('this.frameMeasurements.submit(stats.diagnosticSequence');expect(client).toContain("document.removeEventListener('visibilitychange',visibility)")
})

test('accepted input with no camera request still exposes pending age',()=>{const f=fixture();f.m.input(1,10020);f.at(1000);f.m.tick();expect(f.rows[0]).toMatchObject({pendingInputAgeMs:980,softwareSubmits:0})})
test('grid sampler batches bounded kinds and strips arbitrary content',()=>{
 vi.useFakeTimers();const rows:any[]=[];const sampler=new GridMeasurements((event,fields)=>rows.push({event,...fields}))
 for(let i=0;i<10000;i++)sampler.record({gridKind:2,gridVisible:i%2,secret:123})
 expect(rows).toHaveLength(0);vi.advanceTimersByTime(1000);expect(rows).toEqual([{event:'grid-state',gridKind:2,gridVisible:1}]);sampler.close();vi.useRealTimers()
})
test('production shared schema retains every frame scalar and rejects content keys',async()=>{
 const {sanitizeRecord}=await import('../../../design-desktop/src/render-terminal-diagnostics.mjs')
 const f=fixture();f.m.raf(0);f.at(1000);f.m.tick();const raw={v:1,session:1,source:'main',seq:1,at:1000,...f.rows[0]}
 expect(sanitizeRecord(raw)).toEqual(raw)
 expect(sanitizeRecord({...raw,document:'private',author:'private',geometry:[1,2]})).toEqual(raw)
})
test('batched or delayed IPC cannot inflate software submission cadence',()=>{
 const run=(receipts:number[])=>{const f=fixture();for(let i=0;i<receipts.length;i++){f.at(receipts[i]);f.m.submit(i+1,view,1,10000+i*100)}f.at(1000);f.m.tick();return f.rows[0]}
 const spaced=run([100,200,300]),burst=run([990,990,990])
 for(const row of [spaced,burst])expect(row).toMatchObject({softwareSubmits:3,softwareSubmitHz:10,softwareRateValid:1,submitIntervalCount:2,submitSampleSpanMs:200,submitIntervalMaxMs:100})
 expect(burst.softwareSubmitHz).toBe(spaced.softwareSubmitHz)
})
test('one submission or nonincreasing timestamps never fabricate a valid rate',()=>{
 const f=fixture();f.m.submit(1,view,1,10010);f.m.submit(1,view,1,10010);f.m.submit(1,view,1,10005);f.at(1000);f.m.tick()
 expect(f.rows[0]).toMatchObject({softwareRateValid:0,softwareSubmitHz:0,submitSampleSpanMs:0,submitIntervalCount:0})
 f.m.submit(2,view,1,10020);f.at(2000);f.m.tick();expect(f.rows[1]).toMatchObject({softwareRateValid:1,softwareSubmitHz:100,submitSampleSpanMs:10})
})
test('every 120-second saturation has an explicit capped flag, rates use uncapped span',()=>{
 const f=fixture();f.m.raf(0);f.m.request(1,view,{inputSequence:1,inputAt:0,inputTimeOrigin:10000});f.m.input(2,10001);f.m.submit(0,view,1,10000)
 f.at(130001);f.m.submit(1,view,1,140001)
 expect(f.rows[0]).toMatchObject({windowMs:120000,windowCapped:1,submitIntervalMaxMs:120000,submitIntervalCapped:1,submitSampleSpanMs:120000,submitSpanCapped:1,inputPresentMaxMs:120000,inputPresentCapped:1,pendingInputAgeMs:120000,pendingInputAgeCapped:1})
 expect(f.rows[0].softwareSubmitHz).toBeCloseTo(1000/130001)
 f.m.raf(130001);f.at(131001);f.m.tick();expect(f.rows[1]).toMatchObject({uiIntervalMaxMs:120000,uiIntervalCapped:1,windowCapped:0,submitSpanCapped:0})
})
