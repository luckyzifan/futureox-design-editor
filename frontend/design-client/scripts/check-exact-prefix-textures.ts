/** Real RGBA32F two-axis, fallback and uniform-rollover tests using current modules. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  initSync,
  rational_tent_kernel_rgba,
  certified_tent_kernel_rgba,
} from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'
await runProof('forma-prefix-textures', [], async (proof) => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  initSync({ module: wasm })
  const fixtures: any[] = []
  fixtures.push({
    name: 'two-axis-minsub',
    w: 3,
    h: 3,
    r: 1,
    origin: [0, 0],
    channels: 15,
    values: Array.from({ length: 36 }, (_, i) => (Math.floor(i / 4) === 4 ? 1 : 0)),
    centerExpected: 1,
  })
  for (const r of [1, 2, 7, 48, 96, 512]) {
    const w = 17,
      h = 11
    const values = Array.from(
      { length: w * h * 4 },
      (_, i) =>
        (((102 + (i % 39)) << 23) | ((i * 13171) & 0x7fffff) | (i % 7 === 0 ? 0x80000000 : 0)) >>>
        0,
    )
    fixtures.push({
      name: `finite-radius-${r}`,
      w,
      h,
      r,
      origin: r % 2 ? [1048576, -1048576] : [-17, 39],
      channels: 15,
      values,
    })
  }
  const w = 13,
    h = 7,
    mixed = Array.from({ length: w * h * 4 }, (_, i) => {
      const pixel = Math.floor(i / 4),
        channel = i % 4
      if (channel === 0) return pixel % 2 ? 0x3f800000 : 0x3eaaaaab
      if (channel === 1) return pixel % 2 ? 42 << 23 : 1 << 23
      if (channel === 2)
        return pixel === 3
          ? 0x7fc01234
          : pixel === 37
            ? 0xff801237
            : pixel === 80
              ? 0x7f800000
              : 0x3f000000
      return pixel % 2 ? 0x80000001 : 0x80000000
    })
  fixtures.push({
    name: 'mixed-decline-payload',
    w,
    h,
    r: 2,
    origin: [-53, 7],
    channels: 15,
    values: mixed,
  })
  fixtures.push({
    name: 'alpha-only-clears-rgb',
    w,
    h,
    r: 2,
    origin: [31, -47],
    channels: 8,
    values: mixed,
  })
  // Exercise the production scan across multiple 256-lane chunks and the
  // actual high-zoom 117 axis length, including its partial final chunk.
  for (const [w, h, r] of [[520, 3, 48], [3484, 2, 1224.3035888671875]]) {
    fixtures.push({ name: `multi-chunk-${w}`, w, h, r, origin: [-13, 37], channels: 15,
      maxBandLines: 255,
      values: Array.from({length: w*h*4}, (_, i) =>
        ((127 << 23) | ((i * 13171) & 0x7fffff) | (i % 7 === 0 ? 0x80000000 : 0)) >>> 0) })
  }
  for (const f of fixtures) {
    f.kernel = Array.from(rational_tent_kernel_rgba(f.r))
    f.certified = Array.from(certified_tent_kernel_rgba(f.r))
  }

  const prepared = {
    cases: fixtures.length,
    wasmSha256: sha256(wasm),
    fixtureSha256: sha256(JSON.stringify(fixtures)),
    uniformArenaBytes: 4096,
    maxBandLines: 2,
  }
  await proof.write('fixtures.json', fixtures)
  if (proof.prepareOnly) return prepared
  const result = await proof.browser((page) =>
    page.evaluate(
      async ({ fixtures }) => {
        const { TexturePrefix, PREFIX_SCRATCH_BYTES } = await import(
          '/src/kernel/gpu/texture-prefix.ts'
        )
        const { prefixModule } = await import('/src/kernel/gpu/prefix-module.ts')
        const { exactFilterWgsl } = await import('/src/kernel/gpu/exact-filter.ts')
        const candidate = prefixModule(true),
          reference = exactFilterWgsl(true),
          rollover = true
        const adapter = await navigator.gpu?.requestAdapter()
        if (!adapter) throw new Error('Real WebGPU required')
        const device = await adapter.requestDevice()
        const errors: string[] = []
        device.addEventListener('uncapturederror', (e) => errors.push(e.error.message))
        let activeEncoder: GPUCommandEncoder | undefined
        let uniformRollovers = 0
        const arena = new Float32Array(rollover ? 1024 : 2 * 1024 * 1024),
          uniformBuffer = device.createBuffer({
            size: arena.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
        let offset = 0
        const uniform = (data: Float32Array) => {
          if (offset + 256 > arena.length) {
            if (!activeEncoder) throw new Error('missing active encoder')
            device.queue.writeBuffer(uniformBuffer, 0, arena.subarray(0, offset))
            device.queue.submit([activeEncoder.finish()])
            activeEncoder = device.createCommandEncoder()
            offset = 0
            uniformRollovers++
          }
          arena.set(data, offset)
          const binding = { buffer: uniformBuffer, offset: offset * 4, size: 1024 }
          offset += 256
          return binding
        }
        let prefix: any
        try {
          prefix = await TexturePrefix.create(device, uniform, candidate)
          const module = device.createShaderModule({ code: reference })
          const compilation = (await module.getCompilationInfo()).messages.filter(
            (m) => m.type === 'error',
          )
          if (compilation.length) throw new Error(compilation.map((m) => m.message).join('\n'))
          const refLayout = device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform', minBindingSize: 1024 },
              },
              ...[1, 2, 3].map((binding) => ({
                binding,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'unfilterable-float' as const },
              })),
            ],
          })
          const refPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [refLayout] })
          const refPipelines = []
          for (let c = 0; c < 4; c++)
            refPipelines.push(
              await device.createRenderPipelineAsync({
                layout: refPipelineLayout,
                vertex: { module, entryPoint: 'quad' },
                fragment: {
                  module,
                  entryPoint: 'fragment',
                  constants: { FILTER_CHANNEL: c },
                  targets: [{ format: 'rgba32float', writeMask: 1 << c }],
                },
                primitive: { topology: 'triangle-list' },
              }),
            )
          const createTexture = (width: number, height: number) =>
            device.createTexture({
              size: [width, height],
              format: 'rgba32float',
              usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST,
            })
          const params = (f: any, axis: number) => {
            const u = new Float32Array(256)
            u.set([...f.origin, f.w, f.h], 0)
            u.set([...f.origin, f.w, f.h], 4)
            u.set([f.r, axis, 0, 1], 36)
            return u
          }
          const refEncode = (
            target: GPUTexture,
            source: GPUTexture,
            kernel: GPUTexture,
            certifiedKernel: GPUTexture,
            u: Float32Array,
            channels: number,
          ) => {
            const group = device.createBindGroup({
              layout: refLayout,
              entries: [
                { binding: 0, resource: uniform(u) },
                { binding: 1, resource: source.createView() },
                { binding: 2, resource: kernel.createView() },
                { binding: 3, resource: certifiedKernel.createView() },
              ],
            })
            const encoder = activeEncoder!
            let drawn = false
            for (let c = 0; c < 4; c++) {
              if (!(channels & (1 << c))) continue
              const pass = encoder.beginRenderPass({
                colorAttachments: [
                  {
                    view: target.createView(),
                    loadOp: drawn ? 'load' : 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                  },
                ],
              })
              pass.setPipeline(refPipelines[c])
              pass.setBindGroup(0, group)
              pass.draw(3)
              pass.end()
              drawn = true
            }
          }
          const readTexture = async (texture: GPUTexture) => {
            const stride = Math.ceil((texture.width * 16) / 256) * 256,
              size = stride * texture.height
            const readback = device.createBuffer({
              size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
            const encoder = device.createCommandEncoder()
            encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: stride }, [
              texture.width,
              texture.height,
            ])
            device.queue.submit([encoder.finish()])
            await readback.mapAsync(GPUMapMode.READ)
            const padded = new Uint32Array(readback.getMappedRange()),
              out = new Uint32Array(texture.width * texture.height * 4)
            for (let y = 0; y < texture.height; y++)
              out.set(
                padded.subarray((y * stride) / 4, (y * stride) / 4 + texture.width * 4),
                y * texture.width * 4,
              )
            readback.unmap()
            readback.destroy()
            return out
          }
          const records = []
          let different = 0
          let protocolFailures = 0
          let accepted = 0,
            declined = 0
          for (const f of fixtures) {
            offset = 0
            const textures = [
              createTexture(f.w, f.h),
              createTexture(f.w, f.h),
              createTexture(f.w, f.h),
              createTexture(f.w, f.h),
              createTexture(f.w, f.h),
            ]
            const [source, horizontal, vertical, refH, refV] = textures
            device.queue.writeTexture(
              { texture: source },
              new Uint32Array(f.values),
              { bytesPerRow: f.w * 16 },
              [f.w, f.h],
            )
            // Poison outputs so first-pass clear must reset unwritten RGB for alpha-only.
            const poison = new Float32Array(f.w * f.h * 4).fill(42)
            for (const texture of textures.slice(1))
              device.queue.writeTexture({ texture }, poison, { bytesPerRow: f.w * 16 }, [f.w, f.h])
            const kernel = device.createTexture({
              size: [f.kernel.length / 4, 1],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            })
            device.queue.writeTexture(
              { texture: kernel },
              new Uint8Array(f.kernel),
              { bytesPerRow: f.kernel.length },
              [f.kernel.length / 4, 1],
            )
            const certifiedKernel = device.createTexture({
              size: [f.certified.length / 4, 1],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            })
            device.queue.writeTexture(
              { texture: certifiedKernel },
              new Uint8Array(f.certified),
              { bytesPerRow: f.certified.length },
              [f.certified.length / 4, 1],
            )
            activeEncoder = device.createCommandEncoder()
            prefix.resetCounters(activeEncoder)
            const rect = { x: f.origin[0], y: f.origin[1], w: f.w, h: f.h }
            if (
              !prefix.encode(
                () => activeEncoder!,
                horizontal,
                [source, kernel, certifiedKernel],
                params(f, 0),
                f.r,
                'tent',
                rect,
                f.channels,
                f.maxBandLines ?? 2,
              )
            )
              throw new Error('eligible horizontal unexpectedly declined')
            if (
              !prefix.encode(
                () => activeEncoder!,
                vertical,
                [horizontal, kernel, certifiedKernel],
                params(f, 1),
                f.r,
                'tent',
                rect,
                f.channels,
                f.maxBandLines ?? 2,
              )
            )
              throw new Error('eligible vertical unexpectedly declined')
            refEncode(refH, source, kernel, certifiedKernel, params(f, 0), f.channels)
            refEncode(refV, refH, kernel, certifiedKernel, params(f, 1), f.channels)
            // Admission rejects original f64 values that happen to round to an integer.
            for (const [radius, kind, mutate] of [
              [1.0000000000000002, 'tent', false],
              [f.r, 'box', false],
              [f.r, 'tent', true],
            ] as [number, 'tent' | 'box', boolean][]) {
              const u = params(f, 0)
              if (mutate) u[38] = 1
              if (
                prefix.encode(
                  () => activeEncoder!,
                  horizontal,
                  [source, kernel, certifiedKernel],
                  u,
                  radius,
                  kind,
                  rect,
                  f.channels,
                  2,
                )
              )
                protocolFailures++
            }
            device.queue.writeBuffer(uniformBuffer, 0, arena.subarray(0, offset))
            const counters = await prefix.counters(activeEncoder!)
            accepted += counters.acceptedLines
            declined += counters.declinedLines
            const actualH = await readTexture(horizontal),
              actualV = await readTexture(vertical),
              expectedH = await readTexture(refH),
              expectedV = await readTexture(refV)
            let hDiff = 0,
              vDiff = 0,
              rgbNonzero = 0
            const examples = []
            for (let i = 0; i < actualH.length; i++) {
              if (actualH[i] !== expectedH[i]) {
                hDiff++
                if (examples.length < 8)
                  examples.push({
                    axis: 'horizontal',
                    index: i,
                    actual: actualH[i],
                    expected: expectedH[i],
                  })
              }
              if (actualV[i] !== expectedV[i]) {
                vDiff++
                if (examples.length < 8)
                  examples.push({
                    axis: 'vertical',
                    index: i,
                    actual: actualV[i],
                    expected: expectedV[i],
                  })
              }
              if (f.channels === 8 && i % 4 !== 3 && (actualH[i] !== 0 || actualV[i] !== 0))
                rgbNonzero++
            }
            let centerBits: number | undefined
            if (f.centerExpected !== undefined) {
              centerBits = actualV[(Math.floor(f.h / 2) * f.w + Math.floor(f.w / 2)) * 4]
              if (centerBits !== f.centerExpected) protocolFailures++
            }
            different += hDiff + vDiff + rgbNonzero
            records.push({
              name: f.name,
              radius: f.r,
              horizontalComponents: actualH.length,
              verticalComponents: actualV.length,
              hDiff,
              vDiff,
              rgbNonzero,
              centerBits,
              counters,
              examples,
            })
            for (const texture of textures) texture.destroy()
            kernel.destroy()
            certifiedKernel.destroy()
          }
          if (errors.length) throw new Error(errors.join('\n'))
          if (!accepted || !declined)
            throw new Error('Both actual prefix and old fallback must execute')
          if (rollover && uniformRollovers === 0)
            throw new Error('rollover control did not execute')
          return {
            adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
            scratchBytes: PREFIX_SCRATCH_BYTES,
            uniformRollovers,
            records,
            different,
            protocolFailures,
            accepted,
            declined,
          }
        } finally {
          prefix?.destroy()
          uniformBuffer.destroy()
          device.destroy()
        }
      },
      { fixtures },
    ),
  )
  await proof.write('gpu-result.json', result)
  if (result.different || result.protocolFailures)
    throw Error('Exact prefix texture contract failed')
  return { ...prepared, ...result }
})
