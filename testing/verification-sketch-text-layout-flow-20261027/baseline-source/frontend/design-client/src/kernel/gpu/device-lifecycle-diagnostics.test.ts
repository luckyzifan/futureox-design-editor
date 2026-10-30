import { afterEach, expect, test, vi } from 'vitest'
import { beginDeviceRecovery, deviceDiagnosticFields, deviceLifecyclePhase as phase, deviceLostReason,
  recordDeviceCallback, recordDeviceLifecycle, registerDeviceDiagnosticOwner } from './device-lifecycle-diagnostics'
import { createRenderDiagnostics, sanitizeFields, sanitizeRecord, setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'

afterEach(() => { setGpuDiagnosticSink(undefined); vi.restoreAllMocks() })
test('actual device identity is shared across renderer/presenter scopes and retained across reattachment',()=>{
  const device={},driver={},presenter={}
  const first=registerDeviceDiagnosticOwner(driver,device,1),display=registerDeviceDiagnosticOwner(presenter,device,2)
  expect(display.deviceIncarnation).toBe(first.deviceIncarnation)
  expect(display.deviceWorkerScope).toBe(first.deviceWorkerScope)
  expect(display.deviceOwner).not.toBe(first.deviceOwner)
  expect(display.deviceScope).toBe(2)
  expect(registerDeviceDiagnosticOwner(driver,device,1)).toEqual(first)
  const replacement=registerDeviceDiagnosticOwner(driver,{},1)
  expect(replacement.deviceIncarnation).not.toBe(first.deviceIncarnation)
  expect(replacement.deviceOwner).not.toBe(first.deviceOwner)
  expect(deviceDiagnosticFields()).toEqual({})
})
test('stale attribution is discarded without mutating current ownership or invoking GPU work',()=>{
  const owner={},first=registerDeviceDiagnosticOwner(owner,{},1),rows:any[]=[]
  setGpuDiagnosticSink((event,fields)=>rows.push({event,...fields as object}))
  const current=registerDeviceDiagnosticOwner(owner,{},1)
  recordDeviceCallback(owner,first,phase.lost,{deviceLostReason:1})
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({event:'device-lifecycle',deviceIncarnation:first.deviceIncarnation,
    deviceCurrentIncarnation:current.deviceIncarnation,devicePhase:phase.callbackDiscarded,deviceCallbackDisposition:4})
  expect(deviceDiagnosticFields(owner)).toEqual(current)
})
test('numeric reason/scope schema excludes private content and unavailable retired counters',()=>{
  const fields={...registerDeviceDiagnosticOwner({}, {},1),devicePhase:phase.lost,deviceLostReason:deviceLostReason('unknown'),
    deviceCounterMask:7,devicePendingCaptures:1,devicePendingCapturePayloadBytes:1024,deviceLogicalPayloadBytes:2048,
    error:'secret document /asset/path',message:'private hardware',adapter:'private adapter'}
  const clean=sanitizeFields(fields)
  expect(clean).toMatchObject({deviceScope:1,devicePhase:3,deviceLostReason:1,deviceCounterMask:7})
  expect(clean).not.toHaveProperty('deviceRetiringPayloadBytes')
  expect(JSON.stringify(clean)).not.toMatch(/secret|private|asset/)
  expect(deviceLostReason('destroyed')).toBe(2);expect(deviceLostReason('private arbitrary reason')).toBe(1)
  for(const value of [-1,1.2,NaN,Infinity,'1',{},0x100000000])expect(sanitizeFields({deviceIncarnation:value})).toEqual({})
  expect(sanitizeFields({deviceScope:3,devicePhase:15,deviceLostReason:3,deviceCallbackDisposition:5,deviceCounterMask:16})).toEqual({})
  expect(sanitizeRecord({v:1,source:'worker',session:1,seq:1,at:1,event:'device-lifecycle',...fields})).not.toBeNull()
})
test('disabled and throwing sinks do not schedule work or replace caller outcomes',()=>{
  const owner={},before=registerDeviceDiagnosticOwner(owner,{},1),now=vi.fn(),schedule=vi.fn()
  const disabled=createRenderDiagnostics({enabled:false,now,schedule:schedule as unknown as typeof setTimeout})
  setGpuDiagnosticSink((event,fields)=>disabled.record(event,fields))
  recordDeviceLifecycle(owner,phase.created);expect(now).not.toHaveBeenCalled();expect(schedule).not.toHaveBeenCalled()
  setGpuDiagnosticSink(()=>{throw Error('observer failure')})
  expect(()=>recordDeviceLifecycle(owner,phase.disposed)).not.toThrow()
  expect(()=>recordDeviceCallback(owner,before,phase.lost,{deviceLostReason:1})).not.toThrow()
  const recovery=beginDeviceRecovery(owner,2,42)
  expect(()=>recovery.end(phase.recoveryFailed)).not.toThrow()
})
test('recovery tokens emit exactly one terminal outcome and never own the operation',async()=>{
  const owner={},records:any[]=[],trace:string[]=[];registerDeviceDiagnosticOwner(owner,{},1)
  setGpuDiagnosticSink((event,fields)=>records.push({event,...fields as object}))
  const token=beginDeviceRecovery(owner,2,42)
  const result=await (async()=>{trace.push('existing await');return true})()
  token.end(result?phase.recoveryReady:phase.recoveryNotHandled,owner)
  token.end(phase.recoveryFailed)
  expect(trace).toEqual(['existing await']);expect(records.map(r=>r.devicePhase)).toEqual([phase.recoveryStart,phase.recoveryReady])
  expect(records.every(r=>r.requestId===42)).toBe(true)
  const error=Error('original private failure'),failed=beginDeviceRecovery(owner,1,43)
  try{throw error}catch(e){failed.end(phase.recoveryFailed);expect(e).toBe(error)}
  expect(records.at(-1).devicePhase).toBe(phase.recoveryFailed)
})
test('lifecycle emission remains in the existing bounded ring',()=>{
  const rows:any[]=[],recorder=createRenderDiagnostics({enabled:true,detail:true,session:1,source:'worker',sink:r=>rows.push(r)})
  setGpuDiagnosticSink((event,fields)=>recorder.record(event,fields))
  for(let n=0;n<1000;n++)recordDeviceLifecycle(undefined,phase.recoveryStart,{deviceRecoveryId:n})
  recorder.flush();recorder.close()
  expect(rows.filter(r=>r.event==='device-lifecycle')).toHaveLength(512)
  expect(rows.find(r=>r.event==='summary').dropped).toBe(488)
})
