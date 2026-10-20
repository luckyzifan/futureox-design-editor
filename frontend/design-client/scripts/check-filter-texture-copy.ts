/** Actual WebGPU raw copies, including payloads a sampling shader could alter. */
import { runProof } from './exact-prefix-proof-utils'
await runProof('futureox-filter-copy', [], async proof => {
  if (proof.prepareOnly) return { scope: 'GPU required for raw-copy verification' }
  return proof.browser(page => page.evaluate(async () => {
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const driver = await WebGpuDriver.create(true, false, true, true, false)
    try {
      await driver.prepareScene({ nodes: {} } as any)
      driver.begin(new Float32Array(0))
      const source = driver.create(7, 6), target = driver.create(8, 7)
      const edges = [0, 0x80000000, 1, 0x80000001, 0x7fc01234, 0xffc05678,
        0x7f800000, 0xff800000, 0x7f7fffff, 0xff7fffff, 0x3f800000, 0x00800000]
      const input = Uint32Array.from({ length: 7 * 6 * 4 }, (_, i) => edges[i % edges.length])
      const expected = new Uint32Array(8 * 7 * 4).fill(0x42280000)
      ;(driver as any).device.queue.writeTexture({ texture: source.resource }, input, { bytesPerRow: 7 * 16 }, [7, 6])
      ;(driver as any).device.queue.writeTexture({ texture: target.resource }, expected, { bytesPerRow: 8 * 16 }, [8, 7])
      target.finitePixels = true; target.uniformColor = true; target.transparentZero = true
      driver.copyRegion(target, source, { x: 1, y: 2, w: 4, h: 3 }, [2, 1])
      if (target.finitePixels || target.uniformColor || target.transparentZero)
        throw Error('Partial copy retained stale target value certificates')
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++)
        expected[((y + 1) * 8 + x + 2) * 4 + c] = input[((y + 2) * 7 + x + 1) * 4 + c]
      const floats = await driver.readSurface(target), actual = new Uint32Array(floats.buffer)
      const different = actual.reduce((count, value, i) => count + Number(value !== expected[i]), 0)
      if (different) throw Error(`Raw copy changed ${different} f32 component payloads`)
      let rejected = 0
      for (const [dst, src, rect, origin] of [
        [source, source, { x: 0, y: 0, w: 1, h: 1 }, [0, 0]],
        [target, source, { x: -1, y: 0, w: 1, h: 1 }, [0, 0]],
        [target, source, { x: 0, y: 0, w: 8, h: 1 }, [0, 0]],
        [target, source, { x: 0, y: 0, w: 1, h: 1 }, [8, 0]],
        [target, source, { x: 0, y: 0, w: 0, h: 1 }, [0, 0]],
        [target, source, { x: .5, y: 0, w: 1, h: 1 }, [0, 0]],
      ] as any[]) {
        try { driver.copyRegion(dst, src, rect, origin) } catch { rejected++ }
      }
      if (rejected !== 6) throw Error('Unsafe raw-copy input was not rejected')
      await driver.finish(target, { x: 0, y: 0, w: 8, h: 7 }, 8, 7, false, undefined, false)
      driver.destroy(source); driver.destroy(target)
      return { adapter: driver.stats().adapter, components: actual.length, different, rejected,
        scope: 'Raw bytes including signed zero, subnormals, infinities and NaN payloads; untouched destination pixels also compared' }
    } finally { driver.dispose() }
  }))
})
