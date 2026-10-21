import { expect, test } from 'vitest'
import { workingSetBudget } from './working-set-budget'
import { GpuRenderer } from './renderer'
import type { Driver } from './types'
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
