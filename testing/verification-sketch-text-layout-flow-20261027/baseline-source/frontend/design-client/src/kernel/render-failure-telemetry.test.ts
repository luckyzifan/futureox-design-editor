import { expect, test, vi, afterEach } from 'vitest'
import { markRenderFailure, renderFailureFields, inheritRenderFailure, withRenderFailureStage, RenderFailureAttempts } from './render-failure-telemetry'
import { renderErrorWithBudget } from './render-diagnostics'
import { QueueWaitStats } from './gpu/queue-wait-stats'
import { sanitizeFields, createRenderDiagnostics } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(()=>vi.unstubAllGlobals())
test('exact known error categories never export messages or infer from private substrings',()=>{
 const examples:[string,number,number][]=[['PREVIEW_CANCELLED',1,1],['DERIVATION_UNSUPPORTED',2,2],['GPU 图片总内存预算超限',3,22],['GPU 图片像素预算超限',3,24],['WebGPU 设备已丢失',4,30],['GPU texture feedback loop',5,32],['STALE_BASE',6,6]]
 for(const [text,category,code]of examples)expect(renderFailureFields(new Error(text))).toMatchObject({failureCategory:category,failureCode:code})
 const privateText='alice@example.test /private/project NodeSecret GPU 图片总内存预算超限 PREVIEW_CANCELLED '+ 'x'.repeat(1000)
 const e=new Error(privateText);e.name='private-constructor';e.stack=privateText
 expect(renderFailureFields(e)).toEqual({failureCategory:0,failureCode:0,failureStage:0,errorClassCode:1})
 expect(JSON.stringify(renderFailureFields(e))).not.toMatch(/alice|private|NodeSecret|GPU|CANCELLED/)
 expect(renderFailureFields(new TypeError('private invalid payload')).failureCategory).toBe(0)
 expect(renderFailureFields(new SyntaxError('private invalid JSON'))).toMatchObject({failureCategory:5,failureCode:60,errorClassCode:2})
 expect(renderFailureFields({message:'PREVIEW_CANCELLED',name:'GPUValidationError'})).toMatchObject({failureCategory:0,errorClassCode:0})
})
test('exact GPU classes and source tags preserve identity through asynchronous stage unwinding',async()=>{
 class Validation {message='private shader data'};vi.stubGlobal('GPUValidationError',Validation)
 const gpuError=new Validation();expect(renderFailureFields(gpuError)).toMatchObject({failureCategory:5,errorClassCode:5})
 const e=new Error('sensitive bytes')
 expect(markRenderFailure(e,{failureStage:9})).toBe(e)
 await expect(withRenderFailureStage(12,async()=>{throw e})).rejects.toBe(e)
 expect(renderFailureFields(e)).toMatchObject({failureStage:9,failureCategory:0})
 const wrapped=inheritRenderFailure(e,new Error('private wrapper'))
 expect(renderFailureFields(wrapped)).toMatchObject({failureStage:9})
 expect(renderFailureFields(new Error('next request'))).toMatchObject({failureStage:0})
})
test('budget wrappers preserve exact category and admission origin without leaking raw budget text',()=>{
 const e=markRenderFailure(new Error('GPU 浮点图片内存预算超限'),{failureStage:13})
 const wrapped=renderErrorWithBudget(e,'PREVIEW_BUDGET: private screenshot URI')
 expect(renderFailureFields(wrapped)).toMatchObject({failureStage:13,failureCategory:3,failureCode:21})
 expect(JSON.stringify(renderFailureFields(wrapped))).not.toContain('private')
})
test('request counters are independent, bounded and record recovered failures only as scalar summaries',async()=>{
 const first=new RenderFailureAttempts(),second=new RenderFailureAttempts()
 await expect(first.run(5,async()=>{throw new Error('private compile details')})).rejects.toThrow()
 first.run(6,()=>1);expect(first.fields()).toMatchObject({compileAttempts:1,hydrateAttempts:1,failureAttempts:1,lastFailureStage:5,lastFailureCategory:0})
 expect(second.fields()).toMatchObject({compileAttempts:0,failureAttempts:0,lastFailureStage:0})
 for(let i=0;i<65536;i++)first.run(11,()=>undefined)
 expect(first.fields()).toMatchObject({fallbackAttempts:65535,failureCountsCapped:true})
 const records:any[]=[],recorder=createRenderDiagnostics({enabled:true,detail:true,source:'worker',session:1,sink:r=>records.push(r)})
 recorder.record('failure-summary',{...first.fields(),recovered:true,error:'private',stack:'private'});recorder.flush();recorder.close()
 expect(records).toHaveLength(1);expect(JSON.stringify(records)).not.toContain('private')
 for(const value of [-1,1.1,NaN,Infinity,'1',{},65536])expect(sanitizeFields({failureAttempts:value})).toEqual({})
 expect(sanitizeFields({failureCategory:7,failureStage:14,failureCode:256,errorClassCode:8,rendererCode:4})).toEqual({})
 expect(sanitizeFields({recovered:1,failureCountsCapped:0})).toEqual({recovered:1,failureCountsCapped:0})
})
test('submit/fence instrumentation never replaces exceptions, adds waits, or leaks stage to next success',async()=>{
 const waits=new QueueWaitStats(),submitError=new Error('private submit error'),fenceError=new Error('private fence error')
 expect(()=>waits.submit(()=>{throw submitError})).toThrow(submitError)
 expect(renderFailureFields(submitError).failureStage).toBe(8)
 const work=vi.fn(async()=>{throw fenceError})
 await expect(waits.wait('admission',work,()=>false)).rejects.toBe(fenceError)
 expect(work).toHaveBeenCalledTimes(1);expect(renderFailureFields(fenceError).failureStage).toBe(9)
 await waits.wait('periodic',async()=>{},()=>false)
 expect(waits.snapshot(1,1)).toMatchObject({submitFailures:1,rejected:1,completed:1,pending:0})
})

test('PREVIEW_BUDGET wrappers preserve generic admission code200 at every worker wrapping site',()=>{
 const raw=markRenderFailure(new Error('private allocation details'),{failureStage:13,failureCategory:3,failureCode:200})
 for(const message of ['PREVIEW_BUDGET: Error: private allocation details','PREVIEW_BUDGET: webgpu: private allocation details','PREVIEW_CPU_FALLBACK: private allocation details']){
  const wrapper=renderErrorWithBudget(raw,message)
  expect(renderFailureFields(wrapper)).toMatchObject({failureCategory:3,failureStage:13,failureCode:200})
  expect(JSON.stringify(renderFailureFields(wrapper))).not.toContain('private')
  const again=renderErrorWithBudget(wrapper,'PREVIEW_BUDGET: second private wrapper')
  expect(renderFailureFields(again)).toMatchObject({failureCategory:3,failureStage:13,failureCode:200})
 }
 for(const [message,category,code] of [['PATCH_GUARD_SCHEMA',5,61],['STALE_AUTHORED_PATCH_BASE',6,62],['PATCH_GUARD_UNSUPPORTED',2,63]] as const){
  expect(renderFailureFields(new Error(message))).toMatchObject({failureCategory:category,failureCode:code})
  expect(renderFailureFields(new Error('private-prefix '+message))).toMatchObject({failureCategory:0,failureCode:0})
 }
})

// Rust compile_gpu_scene rejects extent area before the renderer byte gate.
test('native compiler surface-area rejection keeps a distinct exact code and compile stage',()=>{
 const e=markRenderFailure(new Error('GPU surface budget exceeded'),{failureStage:5})
 expect(renderFailureFields(e)).toMatchObject({failureCategory:3,failureCode:64,failureStage:5})
 expect(renderFailureFields(new Error('GPU 表面内存预算超限'))).toMatchObject({failureCategory:3,failureCode:20})
 expect(renderFailureFields(inheritRenderFailure(e,new Error('private wrapper')))).toMatchObject({failureCode:64,failureStage:5})
 expect(renderFailureFields(new Error('private GPU surface budget exceeded'))).toMatchObject({failureCategory:0,failureCode:0})
})


test('dependency halo and watchdog failures remain distinguishable without raw error text',()=>{
 expect(renderFailureFields(new Error('Combined filter dependency halo exceeds 2048 device pixels'))).toMatchObject({failureCategory:3,failureCode:136})
 expect(renderFailureFields(new Error('画布瓦片预览超时，请重试'))).toMatchObject({failureCategory:3,failureCode:137})
 expect(sanitizeFields({renderResetCode:1,privateMessage:'private'})).toEqual({renderResetCode:1})
 expect(sanitizeFields({renderResetCode:6})).toEqual({})
})

test('bounded shadow admission keeps radius, packet capacity and ownership failures distinct',()=>{
 for(const [message,category,code] of [
  ['Exact large blur radius must be in (2048,4096]',2,138],
  ['Large exact filter packet exceeds 64 KiB',3,139],
  ['Invalid bounded shadow coefficient packet',5,140],
 ] as const) expect(renderFailureFields(new Error(message))).toMatchObject({failureCategory:category,failureCode:code})
})
