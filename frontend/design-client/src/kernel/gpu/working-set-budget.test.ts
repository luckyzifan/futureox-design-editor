import { afterEach, expect, test, vi } from 'vitest'
import { workingSetBudget, usesNativeNavigationWorkingBudget } from './working-set-budget'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene } from './types'
afterEach(() => vi.unstubAllEnvs())
test('working-set admission grows with native target pixels, not a pretend VRAM query', () => {
  const MiB=1024*1024
  expect(workingSetBudget(512,512,false)).toBe(256*MiB)
  expect(workingSetBudget(2560,1440,true)).toBe(512*MiB)
  expect(workingSetBudget(5120,2880,true)).toBe(960*MiB)
  expect(workingSetBudget(8192,8192,true)).toBe(1024*MiB)
  expect(workingSetBudget(Infinity,1,true)).toBe(512*MiB)
  expect(workingSetBudget(8192,8192,false)).toBe(256*MiB)
})
test('an explicit host budget supports 4 GiB without uint32 wrap or target-based substitution', () => {
  const MiB = 1024 * 1024
  for (const configured of [256, 512, 1024, 1536, 2048, 4096]) {
    expect(workingSetBudget(512, 512, false, 0, configured)).toBe(configured * MiB)
    expect(workingSetBudget(8192, 8192, true, 8192 ** 2, configured)).toBe(configured * MiB)
  }
  expect(workingSetBudget(512, 512, false, 0, 4096)).toBe(4_294_967_296)
  for (const invalid of [0, 255, 4097, -1, 512.5, NaN, Infinity, '4096', null, true])
    expect(() => workingSetBudget(1, 1, false, 0, invalid as number)).toThrow('Invalid GPU working budget')
})
test('the renderer receives a host budget without preallocating or changing other cache budgets', () => {
  let allocations = 0
  const driver = { scratchBytes: 0, create() { allocations++; throw Error('Unexpected allocation') } } as unknown as Driver
  const baseline = new GpuRenderer(driver).memoryPolicy()
  const configured = new GpuRenderer(driver, true, true, undefined, false, false, 4096).memoryPolicy()
  expect(configured).toEqual({ ...baseline, workingBudgetBytes: 4_294_967_296 })
  expect(allocations).toBe(0)
})

const nativeOutput = { driverName: 'webgpu', managed: true, hdr: false, readback: false, present: true }
test('native navigation admission depends on actual SDR output, not a scene display/capture hint', () => {
  expect(usesNativeNavigationWorkingBudget('1', nativeOutput)).toBe(true)
  expect(usesNativeNavigationWorkingBudget('1', { ...nativeOutput, softwareRaster: false })).toBe(true)
  for (const flag of [undefined, null, false, true, 1, '0', 'true', '01'])
    expect(usesNativeNavigationWorkingBudget(flag, nativeOutput)).toBe(false)
})
test.each([
  { driverName: 'webgl2' }, { driverName: undefined }, { managed: false }, { managed: undefined },
  { hdr: true }, { hdr: undefined }, { readback: true }, { readback: undefined }, { readback: 0 },
  { present: false }, { present: undefined }, { present: 1 }, { softwareRaster: true }, { softwareRaster: 'false' },
])('native navigation budget rejects unknown/non-display output boundary %j', excluded => {
  expect(usesNativeNavigationWorkingBudget('1', { ...nativeOutput, ...excluded })).toBe(false)
})

/** Execute the real render entry through its budget decision, then stop at
 * preparation before any allocation/shader work. This is admission evidence,
 * not a GPU memory or pixel test. */
async function observedBudget(flag: string | undefined, {
  capture = false, coherent = true, readback = false, present = true, hdr = false,
  managed = true, driverName = 'webgpu', software = false, sceneExtra = {}, configured,
  width = 1710, height = 1776,
}: { capture?: boolean; coherent?: boolean; readback?: boolean; present?: boolean; hdr?: boolean;
  managed?: boolean; driverName?: string; software?: boolean; sceneExtra?: Partial<GpuScene>;
  configured?: number; width?: number; height?: number } = {}) {
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', flag)
  const stop = Error('budget observed before GPU preparation'), prepare = vi.fn(async () => { throw stop }), create = vi.fn()
  const driver = { name: driverName, managed, hdr, captureDisplay: capture, scratchBytes: 0,
    create, prepareScene: prepare } as unknown as Driver
  const renderer = new GpuRenderer(driver, true, false, undefined, false, false, configured)
  const scene = { version: 7, width, height, extent: { x: 0, y: 0, w: width, h: height },
    view: { x: 0, y: 0, zoom: 64 }, transparent: false, background: '#fff', grid: false,
    nodes: {}, roots: [], vertices: [], curves: [], coherentSamples: coherent, floatCompositing: managed,
    softwareRaster: software, ...sceneExtra } as GpuScene
  await expect(renderer.render(scene, readback, present)).rejects.toBe(stop)
  expect(prepare).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled()
  return renderer.memoryPolicy()
}

test('coherent resident and bitmap presentation use the existing native working strategy consistently', async () => {
  const expected = workingSetBudget(1710, 1776, true)
  for (const capture of [false, true]) {
    const budget = await observedBudget('1', { capture })
    expect(budget.workingBudgetBytes).toBe(expected)
    // GUI/interaction residency is an independent existing policy.
    expect(budget.interactionBudgetBytes).toBe((capture ? 512 : 64) * 1024 * 1024)
  }
  for (const sceneExtra of [{ resolve: { width: 1710, height: 1776, offsetX: 0, offsetY: 0, scale: 1 } },
    { presentation: { width: 1710, height: 1776, offsetX: 0, offsetY: 0, scale: 1 } }])
    expect((await observedBudget('1', { sceneExtra })).workingBudgetBytes).toBe(expected)
  expect((await observedBudget('1', { width: 5120, height: 2880 })).workingBudgetBytes)
    .toBe(workingSetBudget(5120, 2880, true))
})

test('flag-off scene hints, readback/export transport, HDR, software and other drivers retain their prior coherent budget', async () => {
  const hints = { displayTentRadius: true, displayImageSource: true, nativeInteraction: true }
  expect((await observedBudget(undefined, { capture: true, sceneExtra: hints })).workingBudgetBytes).toBe(256 * 1024 * 1024)
  for (const excluded of [{ readback: true }, { present: false }, { hdr: true }, { managed: false },
    { software: true }, { driverName: 'webgl2' }])
    expect((await observedBudget('1', { ...excluded, sceneExtra: hints })).workingBudgetBytes).toBe(256 * 1024 * 1024)
  expect((await observedBudget('1', { readback: true,
    sceneExtra: { resolve: { width: 1710, height: 1776, offsetX: 0, offsetY: 0, scale: .5 } } })).workingBudgetBytes)
    .toBe(256 * 1024 * 1024)
})

test('the established noncoherent capture budget stays unchanged, including its old transport exceptions', async () => {
  for (const flag of [undefined, '0', '1']) for (const readback of [false, true])
    expect((await observedBudget(flag, { capture: true, coherent: false, readback })).workingBudgetBytes)
      .toBe(workingSetBudget(1710, 1776, true))
  expect((await observedBudget(undefined, { capture: false, coherent: false })).workingBudgetBytes).toBe(256 * 1024 * 1024)
})

test('explicit host limits still override new native display admission without changing cache policies or preallocating', async () => {
  for (const configured of [256, 512, 1024, 4096]) {
    const budget = await observedBudget('1', { configured })
    expect(budget.workingBudgetBytes).toBe(configured * 1024 * 1024)
    expect(budget.interactionBudgetBytes).toBe(64 * 1024 * 1024)
  }
})
