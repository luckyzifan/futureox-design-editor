/** Real production driver comparison: old paint/over/resolve versus fused image
 * resolve. Compare raw f32 bits after every sample, not just SDR screenshots. */
import { runProof } from './exact-prefix-proof-utils'

await runProof('futureox-image-resolve-fusion', [], async proof => {
  if (proof.prepareOnly) return { scope: 'Real GPU required; no CPU surrogate' }
  return proof.browser(page => page.evaluate(async () => {
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const { parameters } = await import('/src/kernel/gpu/types.ts')
    const { IMAGE_RESOLVE_STEP_MODE } = await import('/src/kernel/gpu/image-resolve-step.ts')
    const driver = await WebGpuDriver.create(true, false, true, true, false)
    const records = []
    let different = 0, components = 0
    try {
      await driver.prepareScene({ nodes: { image: {
        fill: { count: 0 }, fills: [{ kind: 'image', blend: 'normal' }],
        strokes: [], effects: [], blend: 'normal',
      } } } as any)
      const cases = [
        { name: 'ordinary-dense', w: 71, h: 39, pattern: 0, axes: false },
        { name: 'signed-hdr-dense', w: 73, h: 41, pattern: 1, axes: false },
        { name: 'subnormal-dense', w: 67, h: 33, pattern: 2, axes: false },
        { name: 'zero-alpha-hdr', w: 71, h: 31, pattern: 3, axes: false },
        { name: 'max-finite-dense', w: 69, h: 35, pattern: 4, axes: false },
        { name: 'ordinary-axes', w: 79, h: 37, pattern: 0, axes: true },
        { name: 'signed-hdr-axes', w: 81, h: 43, pattern: 1, axes: true },
        { name: '117-strip-axes', w: 3484, h: 58, pattern: 0, axes: true },
      ]
      for (const fixture of cases) {
        driver.begin(new Float32Array(0))
        const textures: any[] = []
        const own = <T>(texture: T): T => { textures.push(texture); return texture }
        const { w, h } = fixture, r = { x: -19, y: 23, w, h }, ir = { x: 0, y: 0, w: 13, h: 11 }
        const pixels = new Float32Array(ir.w * ir.h * 4), bits = new Uint32Array(pixels.buffer)
        for (let i = 0; i < pixels.length; i++) {
          const channel = i % 4, p = Math.floor(i / 4)
          if (fixture.pattern === 2) bits[i] = [1, 0x80000001, 0x007fffff, 0x80000000, 0][(i * 7 + p) % 5]
          else if (fixture.pattern === 4 && channel !== 3) bits[i] = [0x7f7fffff, 0xff7fffff, 0, 0x80000000][(i + p) % 4]
          else pixels[i] = channel === 3 ? [1, .5, 0, -.25][p % 4]
            : fixture.pattern === 1 ? (i % 2 ? -1 : 1) * 2 ** ((i % 40) - 20)
            : (i * 37 % 251) / 251
          if (fixture.pattern === 3) pixels[i] = channel === 3 ? 0 : [4, -3, .125][channel]
        }
        const image = own(driver.uploadLinear(pixels, ir.w, ir.h))
        const empty = own(driver.create(w, h)); driver.clear(empty)
        let oldResolved: any, newResolved: any
        for (let sample = 0; sample < 4; sample++) {
          const mask = own(driver.createBinaryCoverage(w, h))
          const coverage = new Uint8Array(w * h * 4)
          for (let i = 0; i < coverage.length; i++) coverage[i] = ((Math.floor(i / 4) + sample * 3) % 7) ? 255 : 0
          ;(driver as any).device.queue.writeTexture({ texture: mask.resource }, coverage,
            { bytesPerRow: w * 4 }, [w, h])
          const span = Math.max(w, h), field = new Float32Array(fixture.axes ? span * 2 * 4 : w * h * 4)
          if (fixture.axes) {
            for (let x = 0; x < w; x++) field.set([x % 15 - 1, [0, .125, .5, .999, 1][(x + sample) % 5], x % 11 ? 1 : 0, -1], x * 4)
            for (let y = 0; y < h; y++) field.set([y % 13 - 1, [0, .25, .75, 1][(y + sample) % 4], y % 9 ? 1 : 0, 0], (span + y) * 4)
          } else {
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
              field.set([(x + y) % 15 - 1, (y + sample) % 13 - 1,
                [0, .125, .5, .999, 1][(x + sample) % 5],
                [0, .25, .75, 1][(y + sample) % 4]], (y * w + x) * 4)
          }
          const coordinates = own(driver.uploadParameters(field, fixture.axes ? span : w, fixture.axes ? 2 : h))
          const paint = own(driver.create(w, h)), over = own(driver.create(w, h))
          const nextOld = own(driver.create(w, h)), nextNew = own(driver.create(w, h))
          const u = parameters(r, r, ir, r)
          u[16] = 2; u[28] = 3; u[32] = 1; u[241] = 1; u.set([r.x, r.y], 204)
          driver.pass(paint, u, [mask, image, mask, coordinates])
          const normal = parameters(r, r, r); normal.set([3, 0, 1, 0], 16)
          driver.pass(over, normal, [paint, empty])
          const resolve = parameters(r, r, r); resolve[16] = 48; resolve[17] = sample
          driver.pass(nextOld, resolve, [over, oldResolved || empty])
          const fused = u.slice(); fused[16] = IMAGE_RESOLVE_STEP_MODE; fused[17] = sample
          driver.pass(nextNew, fused, [mask, image, newResolved || empty, coordinates])
          const reference = await driver.readSurface(nextOld), candidate = await driver.readSurface(nextNew)
          const a = new Uint32Array(reference.buffer), b = new Uint32Array(candidate.buffer)
          let differences = 0
          const examples = []
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
            differences++
            if (examples.length < 8) examples.push({ index: i, reference: a[i], candidate: b[i] })
          }
          components += a.length; different += differences
          records.push({ name: fixture.name, sample, components: a.length, differences, examples })
          oldResolved = nextOld; newResolved = nextNew
        }
        await driver.finish(newResolved, r, w, h, false, undefined, false)
        for (const texture of textures) driver.destroy(texture)
      }
      if (different) throw Error(`Fused image output differs in ${different} components: ${JSON.stringify(records.filter(r => r.differences))}`)
      return { adapter: driver.stats().adapter, cases: cases.length, samples: records.length,
        components, different, records,
        scope: 'Actual production WebGPU paint -> transparent-over -> ordered resolve compared to fused entry; raw float bits after every sample' }
    } finally { driver.dispose() }
  }))
})
