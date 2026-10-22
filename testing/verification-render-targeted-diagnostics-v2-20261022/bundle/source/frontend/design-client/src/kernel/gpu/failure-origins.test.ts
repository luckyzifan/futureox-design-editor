import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene } from './types'
import { RenderFailureAttempts, renderFailureFields } from '../render-failure-telemetry'
import { renderErrorWithBudget } from '../render-diagnostics'
import { sanitizeFields, setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(() => setGpuDiagnosticSink(undefined))
const scene = () => ({ version:7, width:1, height:1, extent:{x:0,y:0,w:1,h:1},
  nodes:{}, roots:[], vertices:[], curves:[], floatCompositing:true, coherentSamples:true } as unknown as GpuScene)
const driver = () => ({name:'webgpu', managed:true, scratchBytes:0} as unknown as Driver)

test('primitive native failure preserves throw identity and separately proves the failed graph boundary', async () => {
  for (const original of ['Singular transform', 'private document text']) {
    const attempts = new RenderFailureAttempts()
    attempts.run(5,()=>undefined); attempts.run(6,()=>undefined)
    await expect(attempts.run(12,async()=>{throw original})).rejects.toBe(original)
    attempts.run(11,()=>false)
    expect(attempts.fields()).toMatchObject({compileAttempts:1,hydrateAttempts:1,graphAttempts:1,
      fallbackAttempts:1,failureAttempts:1,lastFailureStage:0,lastFailureBoundaryStage:12,
      lastFailureThrownKind:2,lastFailureClassCode:0})
    const fields = renderFailureFields(renderErrorWithBudget(original))
    expect(fields).toMatchObject({errorClassCode:1,failureStage:0,failureCode:original==='Singular transform'?80:0})
    expect(JSON.stringify({...fields,...attempts.fields()})).not.toContain('private')
  }
})

test('native material build reports fixed family before any upload without serializing cache inputs', () => {
  const records:any[]=[];setGpuDiagnosticSink((event,fields)=>records.push({event,fields}))
  const renderer=new GpuRenderer(driver()) as any, upload=vi.fn(), original='Singular transform'
  renderer.scene={coherentSamples:true}
  expect(()=>renderer.materialField(['gradient-grid','private image URI'],{x:0,y:0,w:1,h:1},
    ()=>{throw original},upload,undefined,0)).toThrow(original)
  expect(upload).not.toHaveBeenCalled()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({event:'failure-origin',fields:{failureOriginCode:6,failureBuildKind:3,
    failureBoundaryStage:12,failureThrownKind:2,failureCode:80}})
  expect(sanitizeFields(records[0].fields)).toEqual(records[0].fields)
  expect(JSON.stringify(records)).not.toContain('private')
})

test('real public render captures rejected allocation before finally clears active runtime ownership', async () => {
  const rows:any[]=[];setGpuDiagnosticSink((event,fields)=>rows.push({event,fields}))
  const gpu=driver(), renderer=new GpuRenderer(gpu) as any
  gpu.prepareScene=()=>{
    renderer.bytes=1024*1024**2;renderer.fieldBuilds=5;renderer.fieldUploadBytes=64;renderer.imageAxisFields=2;renderer.imageFieldBytes=128
    expect(renderer.overBudget(16,1,1)).toBe(true)
    throw renderer.budgetError('GPU 表面内存预算超限',1)
  }
  let rejected:unknown
  try { await renderer.render(scene()) } catch(error) { rejected=error }
  expect(rejected).toBeInstanceOf(Error);expect(renderer.activeRuntimeConfiguration).toBeUndefined()
  renderer.bytes=0
  const fields=renderFailureFields(renderErrorWithBudget(rejected,'PREVIEW_BUDGET: private'))
  expect(fields).toMatchObject({failureCode:20,failureStage:13,failureAllocationKind:1,
    failureLedgerTotalBytes:1073741824,failureWorkingBytes:1073741824,failureRequestedBytes:16,
    runtimeWorkingBudgetBytes:1073741824,runtimeBudgetSource:1,
    failureMaterialFieldBuilds:5,failureMaterialFieldUploadBytes:64,failureImageAxisFields:2,failureImageFieldBytes:128})
  expect(rows.some(row=>row.event==='failure-origin'&&row.fields.failureOriginCode===1)).toBe(true)
  expect(renderFailureFields(new Error('GPU 表面内存预算超限'))).not.toHaveProperty('failureAllocationKind')
})

test('async preparation primitive has precise origin and is rethrown unchanged', async () => {
  const rows:any[]=[];setGpuDiagnosticSink((event,fields)=>rows.push({event,fields}))
  const gpu=driver();gpu.prepareScene=async()=>{throw 'Nonfinite composed transform'}
  const renderer=new GpuRenderer(gpu) as any
  await expect(renderer.render(scene())).rejects.toBe('Nonfinite composed transform')
  expect(rows.find(row=>row.event==='failure-origin')?.fields).toMatchObject({failureOriginCode:1,
    failureBoundaryStage:12,failureThrownKind:2,failureCode:81})
  expect(renderer.activeRuntimeConfiguration).toBeUndefined()
})

test('material-field preflight and actual-byte admission remain distinguishable', () => {
  setGpuDiagnosticSink(()=>{})
  for (const actual of [false,true]) {
    const renderer=new GpuRenderer(driver()) as any, build=vi.fn(()=>new Float32Array(4)), upload=vi.fn()
    renderer.scene={coherentSamples:true};let calls=0
    renderer.overBudget=()=>{
      if (actual && ++calls===1) return false
      renderer.lastBudgetFailure={requestedBytes:16,workingBytes:1073741824,budgetBytes:1073741824,width:1,height:1}
      return true
    }
    let rejected:unknown
    try { renderer.materialField(['glass'],{x:0,y:0,w:1,h:1},build,upload) } catch(error) { rejected=error }
    expect(renderFailureFields(rejected)).toMatchObject({failureAllocationKind:actual?3:2,failureBuildKind:7})
    expect(build).toHaveBeenCalledTimes(actual?1:0);expect(upload).not.toHaveBeenCalled()
  }
})
