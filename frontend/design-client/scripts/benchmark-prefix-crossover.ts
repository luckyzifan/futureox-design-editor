/** Serial operator crossover benchmark, not a whole-editor latency claim.
 * No timestamp-query sums: every measured axis/variant submits one command
 * buffer to an otherwise idle queue and awaits its completion independently. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

await runProof('forma-prefix-crossover', [], async proof => {
  const cycles = Number(process.env.DESIGN_PREFIX_ABBA_CYCLES || 2)
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 8)
    throw Error('DESIGN_PREFIX_ABBA_CYCLES must be an integer from 1 through 8')
  const sizes = [{ width: 257, height: 129 }]
  if (process.env.DESIGN_PREFIX_BENCH_SMALL === '1') sizes.push({ width: 64, height: 64 })
  const radii = [32, 38.25948715209961, 48]
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  initSync({ module: wasm })
  const kernels = radii.map(radius => ({
    radius,
    rational: Array.from(rational_tent_kernel_rgba(radius)),
    certified: Array.from(certified_tent_kernel_rgba(radius)),
  }))
  const inputs = sizes.flatMap(({ width, height }) =>
    ['image-like', 'low-alpha-span', 'wide-hdr-span'].map(pattern => {
      const values = new Float32Array(width * height * 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const pixel = (y * width + x) * 4
        let alpha = (64 + ((x * 7 + y * 11) % 192)) / 255
        if (pattern === 'low-alpha-span') alpha = 2 ** (-12 * ((x + y) % 3))
        for (let channel = 0; channel < 3; channel++) {
          const fraction = (((x * 17 + y * 29 + channel * 53) % 251) + 1) / 256
          // Both axes see the variation. The HDR fixture intentionally forces
          // whole-line exponent-span rejection while keeping every value finite.
          const magnitude = pattern === 'wide-hdr-span'
            ? 2 ** ([-32, 0, 20][(x + y + channel) % 3]) : 1
          const sign = pattern === 'wide-hdr-span' && (x + 2 * y + channel) % 7 === 0 ? -1 : 1
          values[pixel + channel] = fraction * alpha * magnitude * sign
        }
        values[pixel + 3] = alpha
      }
      return { width, height, pattern, origin: [-13, 29], values: Array.from(new Uint32Array(values.buffer)) }
    }))
  const order = Array.from({ length: cycles }, () => ['prefix', 'scalar', 'scalar', 'prefix'] as const).flat()
  const prepared = {
    radii, sizes, patterns: inputs.slice(0, 3).map(input => input.pattern),
    cases: inputs.length * kernels.length,
    warmupsPerVariantAndAxis: 1, abbaCycles: cycles, measuredRunsPerVariantAndAxis: cycles * 2,
    measuredOrder: order, wasmSha256: sha256(wasm),
    fixtureSha256: sha256(JSON.stringify({ inputs, kernels })),
    timingContract: {
      primary: 'Wall time from queue.submit to awaited onSubmittedWorkDone, one axis and one variant at a time; not hardware GPU execution timestamps.',
      secondary: 'Encoding start through queue completion, including the separately recorded uniform upload/idle wait.',
      excluded: 'Pipeline creation, source/kernel uploads, scratch allocation, output readback/hash and prefix counter mapping.',
      included: 'Prefix counter reset and counter copy commands; scalar uses one render pass containing four ordered channel draws.',
      verticalInput: 'Both variants read the same verified scalar horizontal result, held immutable during vertical comparisons.',
      precision: 'Raw RGBA32F u32 equality for every warmup and measured result; no display encoding, quantization, downsampling or changed support.',
      decisionLimit: 'Synthetic operator crossover evidence only. Gate changes still require matched complete Electron workloads and fallback/lifetime validation.',
    },
  }
  await proof.write('fixtures.json', { inputs, kernels })
  if (proof.prepareOnly) return prepared

  const result = await proof.browser(async page => {
    let progress = 0
    await page.exposeFunction('prefixCrossoverProgress', async (value: unknown) =>
      proof.write(`progress-${String(++progress).padStart(2, '0')}.json`, value))
    return page.evaluate(async ({ inputs, kernels, order }) => {
      const { TexturePrefix, PREFIX_SCRATCH_BYTES } = await import('/src/kernel/gpu/texture-prefix.ts')
      const { prefixModule } = await import('/src/kernel/gpu/prefix-module.ts')
      const { exactFilterWgsl } = await import('/src/kernel/gpu/exact-filter.ts')
      type Variant = 'prefix' | 'scalar'
      type Counters = { acceptedLines: number; declinedLines: number; acceptedPixels: number }
      type Row = {
        pattern: string; width: number; height: number; radius: number; axis: number; variant: Variant
        warmup: boolean; sequence: number; encodeMs: number; uniformUploadIdleMs: number
        submitToCompletionMs: number; encodeThroughCompletionMs: number
        renderPasses: number; computePasses: number; encodedDraws: number
        counters?: Counters; pixelSha256: string; differences: number | null
        examples: { component: number; expected: number; actual: number }[]
      }
      const adapter = await navigator.gpu?.requestAdapter()
      if (!adapter) throw Error('An actual WebGPU adapter is required')
      const adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }
      const device = await adapter.requestDevice()
      const errors: string[] = [], rows: Row[] = [], summaries: unknown[] = []
      let intentionalDestroy = false, scopeOpen = false, prefix: InstanceType<typeof TexturePrefix> | undefined
      device.addEventListener('uncapturederror', event => errors.push(event.error.message))
      void device.lost.then(info => { if (!intentionalDestroy) errors.push(`device-lost:${info.reason}:${info.message}`) })
      const textures: GPUTexture[] = [], buffers: GPUBuffer[] = []
      const destroyTextures = (owned: GPUTexture[]) => {
        for (const texture of owned) { texture.destroy(); const at = textures.indexOf(texture); if (at >= 0) textures.splice(at, 1) }
      }
      const texture = (width: number, height: number) => {
        const value = device.createTexture({ size: [width, height], format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST })
        textures.push(value); return value
      }
      const readTexture = async (source: GPUTexture) => {
        const stride = Math.ceil(source.width * 16 / 256) * 256
        const readback = device.createBuffer({ size: stride * source.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        try {
          const encoder = device.createCommandEncoder()
          encoder.copyTextureToBuffer({ texture: source }, { buffer: readback, bytesPerRow: stride }, [source.width, source.height])
          device.queue.submit([encoder.finish()])
          await readback.mapAsync(GPUMapMode.READ)
          const padded = new Uint32Array(readback.getMappedRange()), packed = new Uint32Array(source.width * source.height * 4)
          for (let y = 0; y < source.height; y++) packed.set(padded.subarray(y * stride / 4, y * stride / 4 + source.width * 4), y * source.width * 4)
          readback.unmap(); return packed
        } finally { readback.destroy() }
      }
      const digest = async (values: Uint32Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
        new Uint32Array(values).buffer))].map(value => value.toString(16).padStart(2, '0')).join('')
      const compare = (actual: Uint32Array, expected: Uint32Array) => {
        if (actual.length !== expected.length) throw Error('Output component count differs')
        let differences = 0
        const examples: Row['examples'] = []
        for (let component = 0; component < expected.length; component++) if (actual[component] !== expected[component]) {
          differences++; if (examples.length < 12) examples.push({ component, expected: expected[component], actual: actual[component] })
        }
        return { differences, examples }
      }
      const median = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
      }
      try {
        device.pushErrorScope('validation'); scopeOpen = true
        // One arena is reused only after each previous submission and readback
        // have completed. Its upload is drained before the measured submission.
        const arena = new Float32Array(256 * 256)
        const uniformBuffer = device.createBuffer({ size: arena.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        buffers.push(uniformBuffer)
        let offset = 0
        const uniform = (data: Float32Array): GPUBufferBinding => {
          if (offset + data.length > arena.length) throw Error('Fixed benchmark uniform arena exhausted')
          arena.set(data, offset)
          const binding = { buffer: uniformBuffer, offset: offset * 4, size: 1024 }
          offset += 256; return binding
        }
        prefix = await TexturePrefix.create(device, uniform, prefixModule(true), true)
        if (prefix.scratchBytes !== PREFIX_SCRATCH_BYTES) throw Error('Unexpected prefix scratch reservation')
        const source = exactFilterWgsl(true), module = device.createShaderModule({ code: source })
        const compilation = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
        if (compilation.length) throw Error(compilation.map(message => `${message.lineNum}:${message.message}`).join('\n'))
        const layout = device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 1024 } },
          ...[1, 2, 3].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' as const } })),
        ] })
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }), scalarPipelines: GPURenderPipeline[] = []
        for (let channel = 0; channel < 4; channel++) scalarPipelines.push(await device.createRenderPipelineAsync({
          layout: pipelineLayout, vertex: { module, entryPoint: 'quad' },
          fragment: { module, entryPoint: 'fragment', constants: { FILTER_CHANNEL: channel },
            targets: [{ format: 'rgba32float', writeMask: 1 << channel }] },
          primitive: { topology: 'triangle-list' },
        }))
        // Match the managed production uploadRgba8 path: byte coefficients are
        // converted to float once and uploaded to an RGBA32F texture.
        const coefficient = (bytes: number[]) => {
          const value = texture(bytes.length / 4, 1), data = Float32Array.from(bytes, byte => byte / 255)
          device.queue.writeTexture({ texture: value }, data, { bytesPerRow: data.byteLength }, [value.width, 1])
          return value
        }
        const uploadedKernels = kernels.map(kernel => ({ radius: kernel.radius,
          rational: coefficient(kernel.rational), certified: coefficient(kernel.certified) }))
        await device.queue.onSubmittedWorkDone()
        for (const input of inputs) {
          const inputTextures = Array.from({ length: 5 }, () => texture(input.width, input.height))
          const [image, prefixH, scalarH, prefixV, scalarV] = inputTextures
          device.queue.writeTexture({ texture: image }, new Uint32Array(input.values),
            { bytesPerRow: input.width * 16 }, [input.width, input.height])
          await device.queue.onSubmittedWorkDone()
          for (const kernel of uploadedKernels) {
            for (const axis of [0, 1]) {
              const sourceTexture = axis === 0 ? image : scalarH
              const targets = { prefix: axis === 0 ? prefixH : prefixV, scalar: axis === 0 ? scalarH : scalarV }
              const u = new Float32Array(256)
              u.set([...input.origin, input.width, input.height], 0)
              u.set([...input.origin, input.width, input.height], 4)
              u[16] = 22; u.set([kernel.radius, axis, 0, 1], 36)
              const rect = { x: input.origin[0], y: input.origin[1], w: input.width, h: input.height }
              let reference: Uint32Array | undefined
              const pending: { row: Row; bits: Uint32Array }[] = []
              const axisRows: Row[] = []
              const sequence: { variant: Variant; warmup: boolean }[] = [
                { variant: 'prefix', warmup: true }, { variant: 'scalar', warmup: true },
                ...order.map(variant => ({ variant, warmup: false })),
              ]
              for (const [index, item] of sequence.entries()) {
                // Every earlier read/counter map is finished here. No two
                // variants or axes are submitted together or timed in parallel.
                offset = 0
                const started = performance.now(), encoder = device.createCommandEncoder()
                let renderPasses = 1, computePasses = 0, encodedDraws = 4
                if (item.variant === 'prefix') {
                  prefix.resetCounters(encoder)
                  if (!prefix.encode(encoder, targets.prefix, [sourceTexture, kernel.rational, kernel.certified],
                    u, kernel.radius, 'tent', rect, 15, 255)) throw Error('Eligible prefix request was not encoded')
                  renderPasses = prefix.lastRenderPasses; computePasses = prefix.lastComputePasses
                  encodedDraws = renderPasses
                  prefix.encodeCountersReadback(encoder)
                } else {
                  const group = device.createBindGroup({ layout, entries: [
                    { binding: 0, resource: uniform(u) },
                    { binding: 1, resource: sourceTexture.createView() },
                    { binding: 2, resource: kernel.rational.createView() },
                    { binding: 3, resource: kernel.certified.createView() },
                  ] })
                  // Current production exact scalar policy: one clear/store,
                  // four reducers in channel order, disjoint write masks.
                  const pass = encoder.beginRenderPass({ colorAttachments: [{
                    view: targets.scalar.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
                  }] })
                  for (const pipeline of scalarPipelines) {
                    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3)
                  }
                  pass.end()
                }
                const command = encoder.finish(), encodedAt = performance.now()
                device.queue.writeBuffer(uniformBuffer, 0, arena.subarray(0, offset))
                await device.queue.onSubmittedWorkDone()
                const submitAt = performance.now()
                device.queue.submit([command])
                await device.queue.onSubmittedWorkDone()
                const completedAt = performance.now()
                const counters = item.variant === 'prefix' ? await prefix.readCounters() : undefined
                const actual = await readTexture(targets[item.variant])
                const row: Row = { pattern: input.pattern, width: input.width, height: input.height, radius: kernel.radius, axis,
                  variant: item.variant, warmup: item.warmup, sequence: index,
                  encodeMs: encodedAt - started, uniformUploadIdleMs: submitAt - encodedAt,
                  submitToCompletionMs: completedAt - submitAt, encodeThroughCompletionMs: completedAt - started,
                  renderPasses, computePasses, encodedDraws, counters, pixelSha256: await digest(actual),
                  differences: null, examples: [] }
                rows.push(row); axisRows.push(row)
                if (item.variant === 'scalar' && !reference) reference = actual.slice()
                if (!reference) pending.push({ row, bits: actual })
                else {
                  for (const queued of [...pending.splice(0), { row, bits: actual }]) {
                    Object.assign(queued.row, compare(queued.bits, reference))
                    if (queued.row.differences) throw Error(`Raw RGBA32F mismatch: ${input.pattern} radius ${kernel.radius} axis ${axis}`)
                  }
                }
                if (errors.length) throw Error(errors.join('\n'))
              }
              if (!reference || pending.length) throw Error('Missing independent scalar comparison')
              const measured = axisRows.filter(row => !row.warmup)
              const prefixRows = measured.filter(row => row.variant === 'prefix'), scalarRows = measured.filter(row => row.variant === 'scalar')
              const prefixMedian = median(prefixRows.map(row => row.submitToCompletionMs)), scalarMedian = median(scalarRows.map(row => row.submitToCompletionMs))
              summaries.push({ pattern: input.pattern, width: input.width, height: input.height, radius: kernel.radius, axis,
                prefixSamples: prefixRows.length, scalarSamples: scalarRows.length,
                prefixSubmitMedianMs: prefixMedian, scalarSubmitMedianMs: scalarMedian,
                scalarOverPrefixSubmitRatio: prefixMedian > 0 ? scalarMedian / prefixMedian : null,
                prefixEndToEndMedianMs: median(prefixRows.map(row => row.encodeThroughCompletionMs)),
                scalarEndToEndMedianMs: median(scalarRows.map(row => row.encodeThroughCompletionMs)),
                prefixCounterSamples: prefixRows.map(row => row.counters), rawFloatParity: axisRows.every(row => row.differences === 0) })
            }
            await (globalThis as unknown as { prefixCrossoverProgress(value: unknown): Promise<void> }).prefixCrossoverProgress({
              adapter: adapterInfo, completed: { pattern: input.pattern, width: input.width, height: input.height, radius: kernel.radius },
              rows, summaries, errors,
            })
          }
          destroyTextures(inputTextures)
        }
        const validation = await device.popErrorScope(); scopeOpen = false
        if (validation) errors.push(validation.message)
        if (errors.length) throw Error(errors.join('\n'))
        return { status: 'passed' as const, adapter: adapterInfo, scratchBytes: prefix.scratchBytes, timestampQueriesUsed: false, rows, summaries, errors }
      } catch (error) {
        if (scopeOpen) { const validation = await device.popErrorScope().catch(() => null); scopeOpen = false; if (validation) errors.push(validation.message) }
        return { status: 'failed' as const, error: String(error), adapter: adapterInfo, timestampQueriesUsed: false, rows, summaries, errors }
      } finally {
        prefix?.destroy()
        for (const value of textures) value.destroy()
        for (const value of buffers) value.destroy()
        intentionalDestroy = true; device.destroy()
      }
    }, { inputs, kernels, order })
  })
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Prefix crossover benchmark failed')
  return { ...prepared, ...result }
})
