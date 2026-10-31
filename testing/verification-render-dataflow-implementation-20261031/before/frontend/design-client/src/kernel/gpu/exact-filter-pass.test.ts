import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { parameters, type Texture } from './types'

afterEach(() => vi.unstubAllGlobals())

/** Real prepareFilters/pass dispatch, with an attachment-write emulator.
 * Shader arithmetic is deliberately not emulated or claimed GPU-validated:
 * arbitrary reducer result bits exercise only clear/load/channel semantics. */
async function fixture(timed = false) {
  vi.stubGlobal('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} })
  const descriptors: any[] = [], bindings: any[] = [], passes: any[] = [], commands: string[] = []
  const reducerBits = new Uint32Array([0x80000000, 0x00000001, 0xbf123456, 0x3f800000])
  const pixels = new Uint32Array([11, 22, 33, 44])
  const uniformBuffer = {}, curves = {}
  const texture = (): Texture => ({ width: 16, height: 12, bytes: 16 * 12 * 16,
    resource: { createView: () => ({}) } as unknown as GPUTexture })
  const target = texture(), source = texture()
  const driver = Object.assign(new WebGpuDriver(true), {
    managed: true, displayFilters: false, device: {
      createShaderModule: (descriptor: any) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
      createPipelineLayout: (descriptor: any) => descriptor,
      createRenderPipelineAsync: async (descriptor: any) => { descriptors.push(descriptor); return descriptor },
      createBindGroup: (descriptor: any) => { bindings.push(descriptor); return descriptor },
    }, layout: {}, curves, uniform: () => ({ buffer: uniformBuffer, offset: 0, size: 1024 }), blank: texture(),
    filterPipelines: [], timingQueries: timed ? {} : undefined, timingRows: [],
    encoder: { beginRenderPass(descriptor: any) {
      const record = { descriptor, channels: [] as number[], ended: false }; passes.push(record)
      commands.push('begin')
      if (descriptor.colorAttachments[0].loadOp === 'clear') pixels.fill(0)
      let pipeline: any, bound: any
      return {
        setPipeline(value: any) { pipeline = value },
        setBindGroup(_index: number, group: any) { if (bound) expect(group).toBe(bound); bound = group },
        setScissorRect() {},
        draw(vertices: number) {
          expect(vertices).toBe(3)
          const channel = pipeline.fragment.constants.FILTER_CHANNEL
          const attachment = pipeline.fragment.targets[0]
          expect(attachment.blend).toBeUndefined()
          const mask = attachment.writeMask ?? 15
          record.channels.push(channel); commands.push(`draw:${channel}`)
          for (let c = 0; c < 4; c++) if (mask & (1 << c)) pixels[c] = reducerBits[channel]
        },
        end() { record.ended = true; commands.push('end') },
      }
    } },
  }) as any
  await driver.prepareFilters()
  const u = parameters({ x: 0, y: 0, w: 16, h: 12 }); u[16] = 22; u[36] = 18.393984
  return { driver, target, source, u, descriptors, bindings, passes, pixels, reducerBits, commands }
}

test('exact RGBA axis keeps four bit-identical channel writes in one clear/store pass', async () => {
  const fused = await fixture(), reference = await fixture(true)
  fused.driver.pass(fused.target, fused.u, [fused.source])
  reference.driver.pass(reference.target, reference.u, [reference.source])
  expect(fused.descriptors.slice(0, 4).map(d => d.fragment.targets[0].writeMask)).toEqual([1, 2, 4, 8])
  expect(fused.descriptors.slice(0, 4).map(d => d.fragment.constants.FILTER_CHANNEL)).toEqual([0, 1, 2, 3])
  expect(fused.passes).toHaveLength(1)
  expect(fused.passes[0].channels).toEqual([0, 1, 2, 3])
  expect(fused.passes[0].descriptor.colorAttachments[0]).toMatchObject({ loadOp: 'clear', storeOp: 'store' })
  expect(fused.pixels).toEqual(reference.pixels)
  expect(fused.pixels).toEqual(fused.reducerBits)
  expect(fused.bindings).toHaveLength(1)
  expect(fused.driver.drawCalls).toBe(4)
  expect(fused.driver.mergedExactFilterPasses).toBe(1)
  expect(fused.commands).toEqual(['begin', 'draw:0', 'draw:1', 'draw:2', 'draw:3', 'end'])
  expect(reference.passes).toHaveLength(4)
  expect(reference.passes.map(p => p.descriptor.colorAttachments[0].loadOp)).toEqual(['clear', 'load', 'load', 'load'])
  expect(reference.passes.every(p => p.descriptor.timestampWrites && p.ended)).toBe(true)
})

test('successive axes end their passes before another texture is written', async () => {
  const f = await fixture()
  f.driver.pass(f.target, f.u, [f.source])
  f.u[37] = 1
  f.driver.pass(f.source, f.u, [f.target])
  expect(f.passes).toHaveLength(2)
  expect(f.passes.every(p => p.ended)).toBe(true)
  expect(f.commands.filter(c => c === 'end')).toHaveLength(2)
  expect(() => f.driver.pass(f.target, f.u, [f.target])).toThrow(/feedback/)
  expect(f.passes).toHaveLength(2)
})

test.each([1, 8, 0])('partial channel mask %i retains the original pass path', async channels => {
  const f = await fixture()
  f.driver.pass(f.target, f.u, [f.source], undefined, channels)
  expect(f.driver.mergedExactFilterPasses).toBe(0)
  expect(f.passes).toHaveLength(channels ? 1 : 0)
})

test.each([false, true])('scissored filtering preserves clearOutside=%s and per-channel load semantics', async clearOutside => {
  const f = await fixture()
  f.driver.pass(f.target, f.u, [f.source], { x: 1, y: 2, w: 3, h: 4 }, 15, undefined, clearOutside)
  expect(f.driver.mergedExactFilterPasses).toBe(0)
  expect(f.passes.map(p => p.descriptor.colorAttachments[0].loadOp)).toEqual([clearOutside ? 'clear' : 'load', 'load', 'load', 'load'])
})

test('scalar alpha uses its original single pipeline, never the RGBA batch', async () => {
  const f = await fixture(); f.target.scalarCoverage = true
  f.driver.pass(f.target, f.u, [f.source], undefined, 8)
  expect(f.driver.mergedExactFilterPasses).toBe(0)
  expect(f.passes).toHaveLength(1)
  expect(f.passes[0].channels).toEqual([3])
})
