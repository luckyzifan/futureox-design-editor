// Invoke from an owned WebGPU validation page. Compares the accelerated
// production path with the unchanged exact channel reducer, including crops,
// negative values, transparent taps and both filter axes. No document fixture.
import { initializeKernelModule } from '../module'
import { VectorEngine, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { WebGpuDriver } from './webgpu'
import { createGpu } from './factory'
import { decodeScenePacket } from './scene-packet'
import { parameters } from './types'
import type { TexturePrefix } from './texture-prefix'

export async function checkLargeBlurFilters() {
  await initializeKernelModule()
  const driver = await WebGpuDriver.create(true, true, true, true, false)
  const rows = []
  try {
    await driver.prepareFilters(true)
    for (const radius of [48, 48.25, 306.0758972167969, 512.125, 1224.3035888671875, 2048]) {
      for (const axis of [0, 1]) {
        driver.begin(new Float32Array())
        const w = axis ? 2 : 3072, h = axis ? 3072 : 2
        const values = Float32Array.from({ length: w * h * 4 }, (_, i) =>
          i % 17 === 0 ? 0 : Math.fround(((i * 7919) % 3071) / 4096 * (i % 7 === 0 ? -1 : 1)))
        const source = driver.uploadLinear(values, w, h)
        const rational = rational_tent_kernel_rgba(radius), certified = certified_tent_kernel_rgba(radius)
        const kernel = driver.uploadRgba8(rational, rational.length / 4, 1)
        const certificate = driver.uploadRgba8(certified, certified.length / 4, 1)
        const output = axis ? { x: 0, y: 1532, w: 2, h: 8 } : { x: 1532, y: 0, w: 8, h: 2 }
        const u = parameters(output, { x: 0, y: 0, w, h },
          { x: 0, y: 0, w: kernel.width, h: 1 }, { x: 0, y: 0, w: certificate.width, h: 1 })
        u[16] = 22; u.set([radius, axis, 0, 1], 36)
        const fast = driver.create(output.w, output.h), reference = driver.create(output.w, output.h)
        const inputs = [source, kernel, certificate]
        driver.prepareFilterPass(fast, u, inputs, 15, { kind: 'tent', radius }, 16 * 1024 * 1024)
        driver.pass(fast, u, inputs, undefined, 15, { kind: 'tent', radius })
        const actual = await driver.readSurface(fast)
        driver.pass(reference, u, inputs)
        const expected = await driver.readSurface(reference)
        const a = new Uint32Array(actual.buffer), b = new Uint32Array(expected.buffer)
        const mismatches = a.reduce((count, value, i) => count + Number(value !== b[i]), 0)
        const internals = driver as unknown as { device: GPUDevice; prefix: TexturePrefix }
        const encoder = internals.device.createCommandEncoder()
        internals.prefix.encodeCountersReadback(encoder)
        internals.device.queue.submit([encoder.finish()])
        const counters = await internals.prefix.readCounters()
        rows.push({ radius, axis, values: a.length, mismatches, ...counters })
        for (const texture of [source, kernel, certificate, fast, reference]) driver.destroy(texture)
        await driver.abortFrameAndReleaseFilterScratch()
        if (mismatches || !counters.acceptedLines) throw Error(`Exact large-filter regression: ${JSON.stringify(rows.at(-1))}`)
      }
    }
    return { status: 'passed', comparedChannels: rows.reduce((n, row) => n + row.values, 0), rows }
  } finally { driver.dispose() }
}

export async function checkStreamedLeafPixels() {
  await initializeKernelModule()
  const color = { documentSpace: 'srgb' as const, referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const rows = []
  for (const kind of ['blur', 'shadow', 'group-blur', 'group-shadow', 'background-blur', 'background-blur-edge']) {
    const background = kind.startsWith('background-blur')
    const doc = { schemaVersion: 5, id: 'stream-check', name: 'stream check', colorManagement: color,
      pages: [{ id: 'p', name: 'p', children: ['r'], background: '#334455' }],
      nodes: { r: { id: 'r', kind: background ? 'rectangle' : 'ellipse',
        width: background ? 1000 : 90, height: background ? 1000 : 120,
        transform: [1, 0, 0, 1, 8.375, -12.125],
        fills: [{ kind: 'solid', color: '#e53172', opacity: background ? 1 : .73 }],
        effects: [{ kind: background ? 'background-blur' : kind.replace('group-', ''), color: '#2b74ff', radius: 32, x: 0, y: 0, spread: 0, opacity: .7 }],
        opacity: background ? 1 : .83 } } }
    if (kind.startsWith('group-')) {
      const span = { ...doc.nodes.r, id: 'span', effects: [], opacity: .65, transform: [1, 0, 0, 1, 0, 0] }
      Object.assign(doc.nodes, { span, second: { ...span, id: 'second', transform: [1, 0, 0, 1, 20, 10],
        fills: [{ kind: 'solid', color: '#31ac72', opacity: .43 }] } })
      Object.assign(doc.nodes.r, { kind: 'group', fills: [], children: ['span', 'second'] })
    }
    const engine = new VectorEngine()
    const outputs: Uint32Array[] = []
    try {
      engine.load_document(JSON.stringify(doc))
      for (const optimized of [false, true]) {
        const options = { pageId: 'p', width: 128, height: 96, grid: false, transparent: false,
          view: { x: kind === 'background-blur-edge' ? -8 : background ? -100 : -50.25,
            y: background ? -100 : -40.75, zoom: 2 },
          rasterProfile: 'figmaSubpixel',
          ...(!background || optimized ? { gpuViewport: { x: 0, y: 0, w: 128, h: 96 } } : {}) }
        const scene = decodeScenePacket(engine.compile_gpu_packet(JSON.stringify(options)))
        const renderer = await createGpu('webgpu', optimized, false, color, undefined, true, true)
        try {
          const pixels = (await renderer.render(scene, true, false)).linear
          if (!pixels) throw Error('Missing linear GPU readback')
          outputs.push(new Uint32Array(pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength)))
        } finally { renderer.dispose() }
      }
      const mismatches = outputs[0].reduce((n, bits, i) => n + Number(bits !== outputs[1][i]), 0)
      rows.push({ kind, channels: outputs[0].length, mismatches })
      if (mismatches) throw Error(`Streamed effect changed pixels: ${JSON.stringify(rows.at(-1))}`)
    } finally { engine.free() }
  }
  return { status: 'passed', rows }
}
