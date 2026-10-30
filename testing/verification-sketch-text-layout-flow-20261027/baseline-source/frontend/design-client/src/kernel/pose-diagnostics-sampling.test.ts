import { expect, test } from 'vitest'
import { PoseDiagnostics } from './pose-diagnostics'
import { sanitizeFields } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'

test('terminal preserves omitted sampling count without adding pointer logs', () => {
 let now=0;const rows:Record<string,number>[]=[]
 const trace=new PoseDiagnostics(row=>rows.push(sanitizeFields(row)),()=>now)
 for(let sequence=1;sequence<=10000;sequence++){now=sequence*8;trace.record(1,0,sequence,{poseDeferred:1})}
 trace.record(5,0,10000)
 expect(rows.length).toBe(33)
 expect(rows.at(-1)).toMatchObject({poseSubmittedCount:10000,poseSuppressedCount:9968,poseSuppressedCapped:0,posePendingCount:180})
})
test('250ms sampling suppression is separate from rejected or dropped inputs',()=>{
 let now=0;const rows:Record<string,number>[]=[];const trace=new PoseDiagnostics(row=>rows.push(row),()=>now)
 trace.record(1,0,1);trace.record(1,0,2);now=250;trace.record(1,0,3);trace.record(5,0,3)
 expect(rows.at(-1)).toMatchObject({poseSubmittedCount:3,poseSuppressedCount:1,poseRejectedCount:0,poseEvictedCount:0})
})
test('new gesture resets counts and terminal is emitted beyond ordinary cap',()=>{
 const rows:Record<string,number>[]=[];const trace=new PoseDiagnostics(row=>rows.push(row),()=>0)
 trace.record(1,0,1);trace.record(1,0,2);trace.record(5,0,2);trace.record(5,0,2)
 trace.record(1,0,3);trace.record(5,0,3)
 expect(rows.at(-1)).toMatchObject({poseGesture:2,poseSuppressedCount:0,poseSubmittedCount:1})
 expect(rows.filter(row=>row.poseStage===5)).toHaveLength(2)
})
test('counter saturates explicitly and accepts no arbitrary diagnostic fields',()=>{
 const rows:Record<string,number>[]=[];const trace=new PoseDiagnostics(row=>rows.push(sanitizeFields(row)),()=>0)
 trace.record(1,0,1)
 // Reach the numeric boundary without a billion-event stress test.
 ;(trace as unknown as {suppressed:number}).suppressed=1e9
 trace.record(1,0,2)
 trace.record(5,0,2,{secretDocumentContents:123})
 expect(rows.at(-1)).toMatchObject({poseSuppressedCount:1e9,poseSuppressedCapped:1})
 expect(rows.at(-1)).not.toHaveProperty('secretDocumentContents')
})
test('disabled tracing and throwing sink never change editing control flow',()=>{
 let calls=0;const off=new PoseDiagnostics(()=>{calls++},()=>0,false)
 off.record(1,0,1);off.record(5,0,1);expect(calls).toBe(0)
 const broken=new PoseDiagnostics(()=>{throw Error('sink')},()=>0)
 expect(()=>{broken.record(1,0,1);broken.record(1,0,2);broken.record(5,0,2)}).not.toThrow()
})
