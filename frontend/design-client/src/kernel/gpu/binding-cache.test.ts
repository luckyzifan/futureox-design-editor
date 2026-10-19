import { expect, test, vi } from 'vitest'
import { GpuBindingCache } from './binding-cache'

test('default views reuse resource identity and do not alias replacement textures', () => {
  const cache = new GpuBindingCache(), createView = vi.fn(() => ({} as GPUTextureView))
  const first = { createView } as unknown as GPUTexture, replacement = { createView } as unknown as GPUTexture
  expect(cache.view(first)).toBe(cache.view(first)); expect(createView).toHaveBeenCalledTimes(1)
  expect(cache.view(replacement)).not.toBe(cache.view(first)); expect(createView).toHaveBeenCalledTimes(2)
  cache.clear(); cache.view(first); expect(createView).toHaveBeenCalledTimes(3)
})

test('uniform contents can change while binding identities and offsets remain exact', () => {
  const cache = new GpuBindingCache(), layout = {}, uniforms = {}, curves = {}, texture = {}
  const create = vi.fn(() => ({} as GPUBindGroup)), resources = [layout, uniforms, curves, texture]
  const first = cache.group(resources, 0, create)
  cache.begin()
  expect(cache.group(resources, 0, create)).toBe(first)
  expect(cache.group(resources, 1024, create)).not.toBe(first)
  expect(cache.group([layout, {}, curves, texture], 0, create)).not.toBe(first)
  expect(cache.group([layout, uniforms, {}, texture], 0, create)).not.toBe(first)
  expect(cache.group([layout, uniforms, curves, {}], 0, create)).not.toBe(first)
  expect(cache.groupHits).toBe(1)
})

test('descriptor retention is bounded and revocation clears every old identity', () => {
  const cache = new GpuBindingCache(2), create = vi.fn(() => ({} as GPUBindGroup)), resources = [{}]
  const first = cache.group(resources, 0, create)
  cache.group(resources, 1, create); cache.group(resources, 2, create)
  expect(cache.size).toBe(2); expect(cache.group(resources, 0, create)).not.toBe(first)
  cache.clear(); expect(cache.size).toBe(0)
})
