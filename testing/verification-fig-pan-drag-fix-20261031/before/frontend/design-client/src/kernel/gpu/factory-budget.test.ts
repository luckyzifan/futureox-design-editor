import { afterEach, expect, test, vi } from 'vitest'
import { createGpu } from './factory'
import { WebGpuDriver } from './webgpu'

afterEach(() => vi.restoreAllMocks())

test('the GPU factory passes the host budget to the real renderer without eager surface allocation', async () => {
  const create = vi.fn(), dispose = vi.fn()
  const driver = { scratchBytes: 0, create, dispose } as unknown as WebGpuDriver
  const device = vi.spyOn(WebGpuDriver, 'create').mockResolvedValue(driver)
  const renderer = await createGpu('webgpu', true, true, undefined, undefined, false, true, false, false, false, 4096)
  expect(renderer.memoryPolicy().workingBudgetBytes).toBe(4_294_967_296)
  expect(device).toHaveBeenCalledExactlyOnceWith(true, false, false, true, false)
  expect(create).not.toHaveBeenCalled()
  renderer.dispose()
  expect(dispose).toHaveBeenCalledOnce()
})

test('an invalid budget rejects before allocating a GPU device', async () => {
  const device = vi.spyOn(WebGpuDriver, 'create')
  await expect(createGpu('webgpu', true, true, undefined, undefined, false, true, false, false, false, 4097))
    .rejects.toThrow('Invalid GPU working budget')
  expect(device).not.toHaveBeenCalled()
})
