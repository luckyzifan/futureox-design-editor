import { afterEach, describe, expect, it, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { TexturePrefix, PREFIX_SCRATCH_BYTES } from './texture-prefix'
import type { Driver, GpuScene, Texture } from './types'

const empty: GpuScene = {
  version: 8,
  width: 32,
  height: 32,
  extent: { x: 0, y: 0, w: 32, h: 32 },
  output: { x: 0, y: 0, w: 32, h: 32 },
  floatCompositing: true,
  coherentSamples: true,
  integratedBlur: true,
  background: '#ffffff',
  transparent: false,
  grid: false,
  view: { x: 0, y: 0, zoom: 1 },
  roots: [],
  nodes: {},
  vertices: [],
}

describe('prefix resource retirement', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('synchronizes the renderer ledger when finish retires scratch then readback rejects', async () => {
    const live = new Set<Texture>()
    let scratch = PREFIX_SCRATCH_BYTES,
      fail = true
    const driver = {
      name: 'webgpu',
      managed: true,
      linearLight: true,
      hdr: true,
      description: 'no-pixel resource model',
      lost: false,
      get scratchBytes() {
        return scratch
      },
      drawCalls: 0,
      triangles: 0,
      begin() {},
      pass() {},
      clear() {},
      create(width: number, height: number) {
        const texture = { width, height, bytes: width * height * 16, resource: {} } as Texture
        live.add(texture)
        return texture
      },
      destroy(texture: Texture) {
        if (!live.delete(texture)) throw new Error('double destroy')
      },
      async finish() {
        scratch = 0
        if (fail) throw new Error('readback unavailable')
        return {}
      },
      dispose() {
        live.clear()
      },
    } as unknown as Driver
    const renderer = new GpuRenderer(driver, true, false)
    await expect(renderer.render(empty, true, false)).rejects.toThrow('readback unavailable')
    const bytes = () => [...live].reduce((sum, texture) => sum + texture.bytes, scratch)
    expect((renderer as unknown as { bytes: number }).bytes).toBe(bytes())
    fail = false
    const result = await renderer.render(empty, true, false)
    expect(result.textureBytes).toBe(bytes())
    renderer.dispose()
  })

  it('retires a partially allocated scratch set and preserves the original error', () => {
    vi.stubGlobal('GPUShaderStage', { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 })
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 })
    const allocated: { bytes: number; destroyed: boolean; destroy(): void }[] = []
    let attempt = 0,
      fail = true
    const device = {
      createBindGroupLayout: () => ({}),
      createBindGroup: () => ({}),
      createBuffer({ size }: { size: number }) {
        attempt++
        if (fail && attempt === 2) throw new Error('allocation interrupted')
        const buffer = {
          bytes: size,
          destroyed: false,
          destroy() {
            this.destroyed = true
          },
        }
        allocated.push(buffer)
        return buffer
      },
    }
    const Constructor = TexturePrefix as unknown as new (
      device: unknown,
      uniform: unknown,
    ) => TexturePrefix
    const prefix = new Constructor(device, () => ({}))
    expect(prefix.scratchBytes).toBe(0)
    expect(() => prefix.reserveScratch()).toThrow('allocation interrupted')
    expect(prefix.scratchBytes).toBe(0)
    expect(allocated.every((buffer) => buffer.destroyed)).toBe(true)
    fail = false
    prefix.reserveScratch()
    expect(prefix.scratchBytes).toBe(PREFIX_SCRATCH_BYTES)
    expect(
      allocated
        .filter((buffer) => !buffer.destroyed)
        .reduce((sum, buffer) => sum + buffer.bytes, 0),
    ).toBe(PREFIX_SCRATCH_BYTES)
    prefix.releaseScratch()
    expect(prefix.scratchBytes).toBe(0)
    expect(allocated.every((buffer) => buffer.destroyed)).toBe(true)
  })
})
