// Pressure fixtures explicitly retain a 256 MiB override; the default is tested separately.
import { describe, expect, it } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

function allocator(reserved: number) {
  let created = 0
  const driver = {
    managed: true,
    scratchBytes: reserved,
    create(width: number, height: number): Texture {
      created++
      return { width, height, bytes: width * height * 16, resource: {} } as Texture
    },
    destroy() {},
  } as unknown as Driver
  const renderer = new GpuRenderer(driver, undefined, undefined, undefined, undefined, undefined, 256) as unknown as {
    acquire(rect: { x: number; y: number; w: number; h: number }): unknown
  }
  return { renderer, created: () => created }
}

describe('prefix scratch shares the compositor budget', () => {
  it('admits the exact remaining capacity and refuses one more live texture', () => {
    const { renderer, created } = allocator(1024 * 1024)
    // 4096 * 4080 * RGBA32F + 1 MiB scratch = exactly 256 MiB.
    renderer.acquire({ x: 0, y: 0, w: 4096, h: 4080 })
    expect(created()).toBe(1)
    expect(() => renderer.acquire({ x: 0, y: 0, w: 1, h: 1 })).toThrow('GPU 表面内存预算超限')
    expect(created()).toBe(1)
  })
  it('refuses allocation before the driver allocates memory, including the first surface', () => {
    const { renderer, created } = allocator(1024 * 1024)
    expect(() => renderer.acquire({ x: 0, y: 0, w: 4096, h: 4081 })).toThrow('GPU 表面内存预算超限')
    expect(created()).toBe(0)
  })
  it('preserves the full previous capacity when the original backend has no scratch', () => {
    const { renderer, created } = allocator(0)
    renderer.acquire({ x: 0, y: 0, w: 4096, h: 4096 })
    expect(created()).toBe(1)
  })
})
