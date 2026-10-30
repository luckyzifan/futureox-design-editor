import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene } from './types'
import { renderFailureFields } from '../render-failure-telemetry'
import { renderErrorWithBudget } from '../render-diagnostics'
import { sanitizeFields, setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'

afterEach(() => { setGpuDiagnosticSink(undefined); vi.unstubAllEnvs() })
const scene = { version: 0, width: 16, height: 16, extent: { x: 0, y: 0, w: 16, h: 16 },
  floatCompositing: true, coherentSamples: true } as unknown as GpuScene
const driver = () => ({ name: 'webgpu', managed: true, linearLight: true, hdr: false,
  displayMath: false, captureDisplay: true, scratchBytes: 0,
  uploadLinear: vi.fn(), uploadAtlasLinear: vi.fn() } as unknown as Driver)

test('actual render entry snapshots flags/default before validation, then suppresses repeated frames', async () => {
  const rows: { event: string; fields: any }[] = []
  setGpuDiagnosticSink((event, fields) => rows.push({ event, fields }))
  const renderer = new GpuRenderer(driver(), true, true, undefined, true, true) as any
  renderer.scene = { floatCompositing: false, coherentSamples: false }
  for (let i = 0; i < 20; i++) await expect(renderer.renderAttempt(scene, false, true)).rejects.toThrow(/版本/)
  expect(rows).toHaveLength(1); expect(rows[0].event).toBe('runtime-config')
  const fields = rows[0].fields
  expect(fields).toMatchObject({ runtimeConfigVersion: 1, runtimeDriverCode: 2,
    runtimeImageAtlas: 1, runtimeImageMips: 1, runtimeDriverManaged: 1,
    runtimeFloatUpload: 1, runtimeFloatAtlasUpload: 1, runtimeHdr: 0,
    runtimeFloatCompositing: 1, runtimeCoherentSamples: 1,
    runtimeCompactImageFields: 1, runtimeImageAxesEnabled: 1, runtimeImageAxesEligible: 1, runtimeStreamImageFields: 1,
    runtimeReadback: 0, runtimePresent: 1, runtimeWorkingBudgetBytes: 1024 * 1024 ** 2,
    runtimeBudgetSource: 1, runtimeConfiguredBudgetMiB: 0 })
  expect(sanitizeFields(fields)).toEqual(fields)
  expect(Object.values(fields).every(Number.isSafeInteger)).toBe(true)
})

test('actual override and output changes are explicit; repeated configurations do not relog', async () => {
  const rows: any[] = []
  setGpuDiagnosticSink((_event, fields) => rows.push(fields))
  const renderer = new GpuRenderer(driver(), true, true, undefined, false, false, 4096) as any
  for (const [readback, present] of [[false, true], [true, false], [false, true]])
    await expect(renderer.renderAttempt(scene, readback, present)).rejects.toThrow(/版本/)
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({ runtimeImageAtlas: 0, runtimeImageMips: 0,
    runtimeReadback: 1, runtimePresent: 0, runtimeWorkingBudgetBytes: 4294967296,
    runtimeBudgetSource: 2, runtimeConfiguredBudgetMiB: 4096 })
  setGpuDiagnosticSink((_event, fields) => rows.push(fields))
  await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
  expect(rows).toHaveLength(3)
})

test('diagnostics disabled or a throwing sink does not change render validation or GPU work', async () => {
  const gpu = driver(), renderer = new GpuRenderer(gpu) as any
  await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
  expect(renderer.runtimeConfiguration).toBeUndefined()
  setGpuDiagnosticSink(() => { throw Error('diagnostic transport failure') })
  await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
  expect(gpu.uploadLinear).not.toHaveBeenCalled()
  setGpuDiagnosticSink(undefined)
  await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
  expect(renderer.runtimeConfiguration).toBeUndefined()
})

test('16 configuration event cap does not cap exact error-owned snapshots or leak later state', async () => {
  const rows: any[] = [], gpu = driver() as any
  setGpuDiagnosticSink((_event, fields) => rows.push(fields))
  const renderer = new GpuRenderer(gpu, true, true, undefined, false, false, 256) as any
  let oldError: Error | undefined
  for (let i = 0; i < 24; i++) {
    renderer.imageAtlas = !!(i & 1); renderer.imageMips = !!(i & 2)
    gpu.hdr = !!(i & 4); gpu.displayMath = !!(i & 8); gpu.captureDisplay = !!(i & 16)
    await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
    renderer.lastBudgetFailure = { requestedBytes: 16, workingBytes: 256 * 1024 ** 2,
      budgetBytes: 256 * 1024 ** 2, width: 1, height: 1, coherent: true }
    const error = renderer.budgetError('GPU 浮点图片内存预算超限')
    const fields = renderFailureFields(renderErrorWithBudget(error, 'PREVIEW_BUDGET: private text'))
    expect(fields.failureCode).toBe(21); expect(fields.runtimeImageAtlas).toBe(Number(!!(i & 1)))
    expect(fields.runtimeCaptureDisplay).toBe(Number(!!(i & 16)))
    if (!i) oldError = error
  }
  expect(rows).toHaveLength(16)
  expect(renderFailureFields(oldError)).toMatchObject({ runtimeImageAtlas: 0, runtimeCaptureDisplay: 0 })
  expect(renderFailureFields(new Error('GPU 浮点图片内存预算超限'))).not.toHaveProperty('runtimeConfigVersion')
  expect(JSON.stringify(rows)).not.toContain('private')
})

test('explicit 1024 MiB differs from default and independent renderers reset after disable/enable', async () => {
  const rows: any[] = [], sink = (_event: string, fields: unknown) => rows.push(fields)
  const a = new GpuRenderer(driver()) as any
  const b = new GpuRenderer(driver(), true, true, undefined, false, false, 1024) as any
  setGpuDiagnosticSink(sink)
  for (const renderer of [a, b]) await expect(renderer.render(scene)).rejects.toThrow(/版本/)
  expect(rows).toHaveLength(2)
  expect(rows[0].runtimeBudgetSource).toBe(1); expect(rows[1].runtimeBudgetSource).toBe(2)
  expect(rows[0].runtimeWorkingBudgetBytes).toBe(rows[1].runtimeWorkingBudgetBytes)
  expect(rows[1].runtimeConfiguredBudgetMiB).toBe(1024)
  expect(a.activeRuntimeConfiguration).toBeUndefined()
  expect(renderFailureFields(a.budgetError('GPU 浮点图片内存预算超限'))).not.toHaveProperty('runtimeConfigVersion')
  setGpuDiagnosticSink(undefined)
  await expect(a.render(scene)).rejects.toThrow(/版本/)
  setGpuDiagnosticSink(sink)
  await expect(a.render(scene)).rejects.toThrow(/版本/)
  expect(rows).toHaveLength(3)
})

test('compact and axes booleans track actual admission rule without raw environment strings', async () => {
  const rows:any[]=[];setGpuDiagnosticSink((_event,fields)=>rows.push(fields))
  const renderer=new GpuRenderer(driver()) as any
  vi.stubEnv('VITE_DESIGN_IMAGE_AXES','0')
  await expect(renderer.renderAttempt(scene)).rejects.toThrow(/版本/)
  expect(rows.at(-1)).toMatchObject({runtimeImageAxesEnabled:0,runtimeImageAxesEligible:0})
  vi.stubEnv('VITE_DESIGN_IMAGE_AXES','private-value')
  await expect(renderer.renderAttempt({...scene,compactImageFields:false})).rejects.toThrow(/版本/)
  expect(rows.at(-1)).toMatchObject({runtimeCompactImageFields:0,runtimeImageAxesEnabled:1,runtimeImageAxesEligible:0})
  expect(JSON.stringify(rows)).not.toContain('private-value')
})
