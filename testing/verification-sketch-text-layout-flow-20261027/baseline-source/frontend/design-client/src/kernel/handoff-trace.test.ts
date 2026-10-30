import {expect,test} from 'vitest'
import {HandoffTrace} from './handoff-trace'
import {createRenderDiagnostics,sanitizeRecord} from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
test.each([false,true])('bounded trace keeps causal scalar identities after terminal detail=%s',detail=>{
 const rows:any[]=[],terminal=createRenderDiagnostics({enabled:true,detail,session:9,sink:r=>rows.push(r),batchSink:rs=>rows.push(...rs),schedule:(()=>1) as unknown as typeof setTimeout,cancel:(()=>{}) as unknown as typeof clearTimeout})
 let now=0;const trace=new HandoffTrace(fields=>{terminal.record('handoff-trace',fields);terminal.flush()},true,detail,()=>now)
 for(let i=0;i<8;i++)trace.record(3,0,{handoffSourceOrder:i,interactionOwner:17,interactionGeneration:3,document:'PRIVATE',nodeId:'PRIVATE',matrix:[1,2,3],operationId:undefined} as any)
 expect(rows).toHaveLength(8);expect(rows.every(r=>sanitizeRecord(r)?.handoffOwner===trace.owner)).toBe(true)
 expect(rows.map(r=>r.handoffSourceOrder)).toEqual([0,1,2,3,4,5,6,7])
 expect(JSON.stringify(trace.snapshot())).not.toContain('PRIVATE')
 expect(rows.every(r=>r.interactionOwner===17&&r.interactionGeneration===3&&!('operationId' in r))).toBe(true)
 const budget=detail?64:16
 for(let i=8;i<1000;i++)trace.record(3,0,{handoffSourceOrder:i})
 expect(rows).toHaveLength(budget);expect(trace.snapshot().dropped).toBe(1000-budget)
 trace.record(7,5,{handoffSourceOrder:1000});expect(rows).toHaveLength(budget+1)
 expect(rows.at(-1).handoffDropped).toBe(1000-budget)
 for(let i=1001;i<1100;i++)trace.record(7,5,{handoffSourceOrder:i})
 expect(rows).toHaveLength(budget+1)
 now=1001;trace.record(3,0,{handoffSourceOrder:999});expect(rows.at(-1).handoffSourceOrder).toBe(999)
 expect(rows.at(-1).handoffDropped).toBe(1000-budget+99)
})
test.each([false,true])('retained ring is bounded and repeated decisions do not grow detail=%s',detail=>{
 let now=0;const trace=new HandoffTrace(()=>{},true,detail,()=>now)
 trace.record(1,1,{handoffOwnerKind:2,handoffPreviousOwnerKind:1})
 for(let i=0;i<10000;i++)trace.record(1,1,{handoffOwnerKind:2,handoffPreviousOwnerKind:2})
 expect(trace.snapshot().records).toHaveLength(1);expect(trace.snapshot().dropped).toBe(0)
 for(let i=0;i<1000;i++){now+=1001;trace.record(2,0,{handoffFloor:i})}
 expect(trace.snapshot().records).toHaveLength(detail?256:128)
 expect(trace.snapshot().ringDropped).toBe(1001-(detail?256:128));expect(trace.snapshot().dropped).toBe(0)
})
test('disabled diagnostics are inert and throwing sink cannot reject work',()=>{
 const off=new HandoffTrace(()=>{throw Error('must not call')},false)
 off.record(1,0,{handoffSourceOrder:1});expect(off.snapshot().records).toHaveLength(0)
 const broken=new HandoffTrace(()=>{throw Error('sink')},true)
 expect(()=>broken.record(1,0)).not.toThrow()
})
