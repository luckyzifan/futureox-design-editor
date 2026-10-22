import { expect, test, vi } from 'vitest'
import { ByteTentPrefix, ByteTentPrefixLease } from './byte-tent-prefix'
import { planByteTentPrefix, byteTentOracle, byteTentNumerator, byteTentPrefixOracle, byteTentRationalOracle,
  byteTentRoundEven } from './byte-tent-prefix-plan'

const options = (radius = 1920) => ({ radius, axis: 0 as const,
  source: { x: -20000, y: 12000, w: 4097, h: 17 }, output: { x: -21000, y: 12003, w: 11, h: 9 } })
test.each([1, 2, 3, 31, 512, 513, 1920, 2048])('integer tent r%i agrees with independent exact rational and prefix identities, including transparent edges', radius => {
  let seed = 0x784abcde
  const length = radius * 2 + 3
  const random = Uint8Array.from({ length }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24 })
  for (const alpha of [random, new Uint8Array(length).fill(255)])
    for (const center of [-radius - 2, -radius, -1, 0, 1, radius, length - 1, length, length + radius - 1]) {
      const direct = byteTentOracle(alpha, center, radius)
      expect(byteTentPrefixOracle(alpha, center, radius)).toBe(direct)
      expect(byteTentRationalOracle(alpha, center, radius)).toBe(direct)
    }
})
test.each([1920, 2048])('r%i retains a numerator above u32 rather than wrapping the old integer accumulator', radius => {
  const alpha = new Uint8Array(radius * 2 + 1).fill(255), numerator = byteTentNumerator(alpha, radius, radius)
  expect(numerator).toBe(6n * BigInt(radius) ** 2n * 255n)
  expect(numerator).toBeGreaterThan(0xffffffffn)
  expect(byteTentPrefixOracle(alpha, radius, radius)).toBe(255)
})
test('half ties round to an even byte, with the existing quantized intermediate between axes', () => {
  expect(byteTentOracle([3, 0, 0], 1, 1)).toBe(0)
  expect(byteTentOracle([5, 1, 0], 1, 1)).toBe(2)
  expect(byteTentRoundEven(1n, 2n)).toBe(0); expect(byteTentRoundEven(3n, 2n)).toBe(2)
  const horizontal = byteTentOracle([0, 1, 0], 1, 1)
  expect(byteTentOracle([0, horizontal, 0], 1, 1)).toBe(1)
  expect(byteTentRoundEven(16n, 36n)).toBe(0) // collapsing both axes would be wrong.
})
test.each([1920, 2048])('r%i exact half ties retain even rounding above the old GPU admission domain', radius => {
  for (const base of [128, 129]) {
    const alpha = new Uint8Array(radius * 2 + 1).fill(base)
    let remaining = radius * radius / 2
    for (let k = radius - 1; k >= 1; k--) {
      const amount = Math.min(base, Math.floor(remaining / k))
      alpha[k] -= amount; remaining -= amount * k
    }
    expect(remaining).toBe(0)
    const denominator = 6n * BigInt(radius) ** 2n, numerator = byteTentNumerator(alpha, radius, radius)
    expect(numerator % denominator).toBe(denominator / 2n)
    expect(byteTentOracle(alpha, radius, radius)).toBe(128)
    expect(byteTentPrefixOracle(alpha, radius, radius)).toBe(128)
    expect(byteTentRationalOracle(alpha, radius, radius)).toBe(128)
  }
})
test('band and per-band uniform allocations share the scratch cap, including both default axis jobs', () => {
  for (const axis of [0, 1] as const) {
    const p = planByteTentPrefix({ radius: 2048, axis, source: { x: 0, y: 0, w: 16384, h: 16384 },
      output: { x: -1024, y: 1024, w: 16384, h: 16384 } })!
    expect(p.bytes).toBe(p.prefixBytes + p.uniformBytes)
    expect(p.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(p.prefixBytes).toBe(p.length * p.bandLines * 16)
    expect(p.uniformBytes).toBe(p.bands * 256)
  }
  const p = planByteTentPrefix(options())!
  expect(p.output.x).toBeLessThan(p.source.x) // transparent output beyond source is admitted.
  expect(Object.isFrozen(p.source)).toBe(true)
})
test('fractional/global-limit/oversized/radius/budget inputs decline before allocation', () => {
  const base = options()
  for (const change of [{ radius: 0 }, { radius: 2049 }, { radius: 3.5 }, { axis: 2 },
    { source: { ...base.source, x: .25 } }, { output: { ...base.output, x: 1048500 } },
    { source: { ...base.source, w: 16385 } }, { scratchBudgetBytes: 0 }, { scratchBudgetBytes: 4 * 1024 * 1024 + 1 }])
    expect(planByteTentPrefix({ ...base, ...change } as any)).toBeUndefined()
})
test('lease accounting survives uncertain completion and cancellation cannot destroy in-flight buffers', async () => {
  const p = planByteTentPrefix(options())!, destroy = vi.fn(), lease = new ByteTentPrefixLease(p, [{ destroy } as any])
  let complete!: () => void
  lease.markSubmitted(); lease.markSubmitted()
  expect(() => lease.discardUnsubmitted()).toThrow('already retiring')
  const pending = lease.retireAfter(new Promise<void>(resolve => { complete = resolve }))
  expect(lease.bytes).toBe(p.bytes); expect(destroy).not.toHaveBeenCalled()
  expect(() => lease.discardUnsubmitted()).toThrow('already retiring')
  complete(); await pending
  expect(lease.bytes).toBe(0); expect(destroy).toHaveBeenCalledOnce()
  lease.disposeAfterDeviceLoss(); expect(destroy).toHaveBeenCalledOnce()
  const uncertain = new ByteTentPrefixLease(p, [{ destroy } as any])
  uncertain.markSubmitted()
  await expect(uncertain.retireAfter(Promise.reject(Error('not a completion proof')))).rejects.toThrow('not a completion proof')
  expect(uncertain.bytes).toBe(p.bytes); expect(destroy).toHaveBeenCalledTimes(1)
  expect(() => uncertain.discardUnsubmitted()).toThrow('already retiring')
  await uncertain.retireAfter(Promise.resolve()); expect(destroy).toHaveBeenCalledTimes(2)
  const abandoned = new ByteTentPrefixLease(p, [{ destroy } as any]); abandoned.discardUnsubmitted()
  expect(abandoned.bytes).toBe(0); expect(destroy).toHaveBeenCalledTimes(3)
})
test('format, lane, alias and available-byte rejection occurs before any buffer or command is allocated', () => {
  const allocate = vi.fn(), device = { createBuffer: allocate }, encoder = { beginComputePass: vi.fn() }
  const pipeline = new (ByteTentPrefix as any)(device, {}, {}, {}, {})
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 })
  try {
    const p = options(), source = { format: 'rgba8unorm', dimension: '2d', depthOrArrayLayers: 1,
      sampleCount: 1, width: p.source.w, height: p.source.h, usage: 4 }
    const target = { format: 'rgba8unorm', dimension: '2d', depthOrArrayLayers: 1,
      sampleCount: 1, width: p.output.w, height: p.output.h, usage: 16 }
    expect(pipeline.encode(encoder, source, source, p)).toBeUndefined()
    expect(pipeline.encode(encoder, { ...source, format: 'r8unorm' }, target, p)).toBeUndefined()
    expect(pipeline.encode(encoder, { ...source, format: 'r32float' }, target, p)).toBeUndefined()
    expect(pipeline.encode(encoder, { ...source, depthOrArrayLayers: 2 }, target, p)).toBeUndefined()
    expect(pipeline.encode(encoder, source, { ...target, format: 'rgba32float' }, p)).toBeUndefined()
    expect(pipeline.encode(encoder, source, target, p, 0)).toBeUndefined()
    expect(allocate).not.toHaveBeenCalled(); expect(encoder.beginComputePass).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
test('each encoded band owns a distinct uniform region while prefix scratch is reused in encoder order', () => {
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 })
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, UNIFORM: 64, COPY_DST: 8 })
  try {
    const buffers: any[] = [], groups: any[] = [], writes: any[] = [], passes: any[] = []
    const device = { createBuffer: (descriptor: any) => { const buffer = { ...descriptor, destroy: vi.fn() }; buffers.push(buffer); return buffer },
      createBindGroup: (descriptor: any) => { groups.push(descriptor); return descriptor },
      queue: { writeBuffer: (...args: any[]) => writes.push(args) } }
    const encoder = { beginComputePass: () => { const p = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }; passes.push(p); return p },
      beginRenderPass: (descriptor: any) => { const p = { descriptor, setPipeline: vi.fn(), setBindGroup: vi.fn(), setScissorRect: vi.fn(), draw: vi.fn(), end: vi.fn() }; passes.push(p); return p } }
    const p = { ...options(), scratchBudgetBytes: 100_000 }, plan = planByteTentPrefix(p)!
    expect(plan.bands).toBeGreaterThan(1)
    const source = { format: 'rgba8unorm', dimension: '2d', depthOrArrayLayers: 1,
      sampleCount: 1, width: p.source.w, height: p.source.h, usage: 4, createView: () => ({ source: true }) }
    const target = { format: 'rgba8unorm', dimension: '2d', depthOrArrayLayers: 1,
      sampleCount: 1, width: p.output.w, height: p.output.h, usage: 16, createView: () => ({ target: true }) }
    const pipeline = new (ByteTentPrefix as any)(device, {}, {}, {}, {})
    const lease = pipeline.encode(encoder, source, target, p)
    expect(lease.bytes).toBe(plan.bytes)
    expect(buffers.map(buffer => buffer.size)).toEqual([plan.prefixBytes, plan.uniformBytes])
    expect(groups).toHaveLength(2); expect(writes).toHaveLength(1)
    const words = writes[0][2] as Uint32Array, signed = new Int32Array(words.buffer)
    for (let band = 0; band < plan.bands; band++) {
      expect([...words.slice(band * 64 + 8, band * 64 + 12)]).toEqual([p.radius, p.axis, band, 1])
      expect([...signed.slice(band * 64 + 4, band * 64 + 6)]).toEqual([p.output.x - p.source.x, p.output.y - p.source.y])
      expect(passes[band * 2].setBindGroup.mock.calls[0][2]).toEqual([band * 256])
      expect(passes[band * 2 + 1].descriptor.colorAttachments[0].loadOp).toBe(band === 0 ? 'clear' : 'load')
      expect(passes[band * 2 + 1].setScissorRect).toHaveBeenCalledWith(0, band, target.width, 1)
    }
    expect(passes).toHaveLength(plan.bands * 2)
    lease.discardUnsubmitted(); expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true)
  } finally { vi.unstubAllGlobals() }
})
