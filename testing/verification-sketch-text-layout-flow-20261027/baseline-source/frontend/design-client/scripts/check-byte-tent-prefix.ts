/** Independent actual-device proof for a shadow-alpha-only, default-off
 * building block. <=512 compares the existing GPU function as well as two
 * exact CPU oracles. >512 extends the same mathematical integer tent into a
 * formerly rejected GPU domain; it is not parity with nonexistent old output. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { byteTentOracle, byteTentRationalOracle, type ByteTentRect } from '../src/kernel/gpu/byte-tent-prefix-plan'
import { runProof, shaderRoot, sha256 } from './exact-prefix-proof-utils'

type Fixture = { name: string; radius: number; source: ByteTentRect; output: ByteTentRect; alpha: number[]; axis: 0 | 1;
  both?: boolean; scratchBudgetBytes?: number }
const vector = await readFile(join(shaderRoot, 'vector.wgsl'), 'utf8')
function nativeFunction(name: string) {
  const begin = vector.indexOf(`fn ${name}(`), first = vector.indexOf('{', begin)
  if (begin < 0 || first < 0) throw Error(`Missing production GPU function ${name}`)
  let depth = 1, end = first + 1
  for (; end < vector.length && depth; end++) depth += vector[end] === '{' ? 1 : vector[end] === '}' ? -1 : 0
  if (depth) throw Error('Unclosed production function')
  return vector.slice(begin, end)
}
const oldFunctions = ['at', 'blurAt', 'tentInteger'].map(nativeFunction).join('\n')
const oldShader = `struct Params{values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
${oldFunctions}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let p=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));return vec4<f32>(p[i],0.,1.);}
@fragment fn reference(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<.5);return vec4<f32>(0.,0.,0.,tentInteger(p.xy+u(0).xy,axis,i32(u(9).x)).a);}`
let seed = 0x117f19
const random = (length: number) => Array.from({ length }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24 })
function imageOracle(alpha: number[], source: ByteTentRect, output: ByteTentRect, axis: 0 | 1, radius: number,
  oracle: typeof byteTentOracle) {
  const result: number[] = []
  for (let y = 0; y < output.h; y++) for (let x = 0; x < output.w; x++) {
    const cross = axis === 0 ? output.y + y - source.y : output.x + x - source.x
    const length = axis === 0 ? source.w : source.h, crossLength = axis === 0 ? source.h : source.w
    const line = Array.from({ length }, (_, at) => cross < 0 || cross >= crossLength ? 0 :
      axis === 0 ? alpha[cross * source.w + at] : alpha[at * source.w + cross])
    const center = axis === 0 ? output.x + x - source.x : output.y + y - source.y
    result.push(oracle(line, center, radius))
  }
  return result
}
function prepare(f: Fixture) {
  const intermediate = f.both ? { x: f.output.x, y: f.source.y, w: f.output.w, h: f.source.h } : f.output
  const first = imageOracle(f.alpha, f.source, intermediate, f.axis, f.radius, byteTentOracle)
  const independent = imageOracle(f.alpha, f.source, intermediate, f.axis, f.radius, byteTentRationalOracle)
  if (first.some((v, i) => v !== independent[i])) throw Error(`Independent rational first-axis disagreement: ${f.name}`)
  const final = f.both ? imageOracle(first, intermediate, f.output, 1, f.radius, byteTentOracle) : first
  const independentFinal = f.both ? imageOracle(independent, intermediate, f.output, 1, f.radius, byteTentRationalOracle) : independent
  if (final.some((v, i) => v !== independentFinal[i])) throw Error(`Independent rational second-axis disagreement: ${f.name}`)
  return { ...f, intermediate, first, final }
}
await runProof('futureox-byte-tent-prefix', [], async proof => {
  const fixtures: Fixture[] = []
  for (const radius of [1, 31, 512, 1920, 2048]) {
    const length = Math.max(7, radius * 2 + 1)
    for (const axis of [0, 1] as const) {
      const source = { x: -26000, y: 17000, w: axis === 0 ? length : 3, h: axis === 0 ? 3 : length }
      const output = { x: source.x + (axis === 0 ? radius - 2 : -1), y: source.y + (axis === 1 ? radius - 2 : -1),
        w: axis === 0 ? 7 : 5, h: axis === 1 ? 7 : 5 }
      fixtures.push({ name: `random-r${radius}-axis${axis}-cross-edge`, radius, axis, source, output, alpha: random(source.w * source.h) })
      fixtures.push({ name: `opaque-r${radius}-axis${axis}`, radius, axis, source, output: { ...source,
        x: source.x + (axis === 0 ? radius : 0), y: source.y + (axis === 1 ? radius : 0), w: 1, h: 1 },
        alpha: new Array(source.w * source.h).fill(255) })
    }
  }
  for (const radius of [1920, 2048]) for (const base of [128, 129]) {
    const source = { x: -50000, y: -50000, w: radius * 2 + 1, h: 1 }, alpha = new Array(source.w).fill(base)
    let remaining = radius * radius / 2
    for (let k = radius - 1; k >= 1; k--) { const take = Math.min(base, Math.floor(remaining / k)); alpha[k] -= take; remaining -= take * k }
    if (remaining) throw Error('Half-tie fixture construction failed')
    fixtures.push({ name: `half-tie-r${radius}-base${base}`, radius, axis: 0, source,
      output: { x: source.x + radius, y: source.y, w: 1, h: 1 }, alpha })
  }
  for (const radius of [1920, 2048]) {
    const source = { x: -1040000, y: 17000, w: radius * 2 + 1, h: 3 }
    fixtures.push({ name: `transparent-along-edge-r${radius}`, radius, axis: 0, source,
      output: { x: source.x - 3, y: source.y, w: 9, h: 3 }, alpha: new Array(source.w * source.h).fill(255) })
  }
  fixtures.push({ name: 'u64-moment-long-line', radius: 2048, axis: 0,
    source: { x: 10000, y: 10000, w: 16384, h: 17 }, output: { x: 22000, y: 10000, w: 17, h: 17 },
    alpha: new Array(16384 * 17).fill(255) })
  fixtures.push({ name: 'u64-moment-8192-control', radius: 2048, axis: 0,
    source: { x: 10000, y: 10000, w: 8192, h: 17 }, output: { x: 15000, y: 10000, w: 17, h: 17 },
    alpha: new Array(8192 * 17).fill(255) })
  fixtures.push({ name: 'finite-budget-partial-band-r2048', radius: 2048, axis: 0, scratchBudgetBytes: 350000,
    source: { x: -30000, y: -30000, w: 4097, h: 17 }, output: { x: -27954, y: -30000, w: 7, h: 17 },
    alpha: random(4097 * 17) })
  fixtures.push({ name: 'two-byte-boundaries-impulse', radius: 1, axis: 0, both: true,
    source: { x: -1000, y: -1000, w: 3, h: 3 }, output: { x: -999, y: -999, w: 1, h: 1 },
    alpha: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
  fixtures.push({ name: 'two-byte-boundaries-r31', radius: 31, axis: 0, both: true,
    source: { x: 24000, y: -15000, w: 67, h: 71 }, output: { x: 24030, y: -14970, w: 9, h: 11 }, alpha: random(67 * 71) })
  fixtures.push({ name: 'two-byte-boundaries-r1920', radius: 1920, axis: 0, both: true,
    source: { x: -20000, y: -30000, w: 3841, h: 17 }, output: { x: -18080, y: -29993, w: 3, h: 3 },
    alpha: new Array(3841 * 17).fill(255) })
  const prepared = fixtures.map(prepare)
  const summary = prepared.map(f => ({ name: f.name, radius: f.radius, axis: f.axis, source: f.source, output: f.output,
    both: !!f.both, scratchBudgetBytes: f.scratchBudgetBytes,
    ...(f.name.startsWith('opaque-r') && f.radius > 512 ? { fullFootprintNumerator: String(6n * BigInt(f.radius) ** 2n * 255n), expectedByte: 255 } : {}),
    sourceAlphaSha256: sha256(new Uint8Array(f.alpha)), firstSha256: sha256(new Uint8Array(f.first)),
    finalSha256: sha256(new Uint8Array(f.final)), oldGpuReferenceApplicable: f.radius <= 512 }))
  await proof.write('fixtures.json', { summary, oldFunctionSha256: sha256(oldFunctions),
    scope: 'Only RGBA8 alpha; >512 is exact-rational extension of the previously rejected GPU domain' })
  if (proof.prepareOnly) return { cases: summary, scope: 'Two independent CPU oracles only; actual GPU remains unrun' }
  if (process.env.VITE_DESIGN_BYTE_TENT_PREFIX !== '1') throw Error('Actual proof requires explicit VITE_DESIGN_BYTE_TENT_PREFIX=1')
  const result = await proof.browser(async page => {
    let progress = 0
    await page.exposeFunction('byteTentProgress', (value: unknown) =>
      proof.write(`progress-${String(++progress).padStart(3, '0')}.json`, value))
    return page.evaluate(async ({ fixtures, oldShader }) => {
    const report = (value: unknown) => (globalThis as any).byteTentProgress(value) as Promise<void>
    const { ByteTentPrefix } = await import('/src/kernel/gpu/byte-tent-prefix.ts')
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) { await report({ phase: 'adapter', available: false }); throw Error('No WebGPU adapter') }
    const adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter }
    const limits = (value: GPUSupportedLimits) => ({ maxTextureDimension2D: value.maxTextureDimension2D,
      maxStorageBufferBindingSize: value.maxStorageBufferBindingSize, maxBufferSize: value.maxBufferSize,
      maxComputeWorkgroupSizeX: value.maxComputeWorkgroupSizeX, maxComputeInvocationsPerWorkgroup: value.maxComputeInvocationsPerWorkgroup,
      minUniformBufferOffsetAlignment: value.minUniformBufferOffsetAlignment })
    const requiredLimits = { maxTextureDimension2D: 16384 }
    await report({ phase: 'adapter', adapter: adapterInfo, adapterLimits: limits(adapter.limits), requiredLimits,
      note: 'Independent 16384-texel operator proof; production driver default/requested limits are separate' })
    if (!adapter || adapter.info.isFallbackAdapter !== false) throw Error('Confirmed non-fallback WebGPU adapter required')
    if (adapter.limits.maxTextureDimension2D < 16384) throw Error('The long-moment GPU proof requires a 16384-texel source line')
    const device = await adapter.requestDevice({ requiredLimits }), failures: string[] = []
    device.addEventListener('uncapturederror', event => failures.push(event.error.message))
    const records: unknown[] = []; let bytesCompared = 0, maxScratchBytes = 0, oldBytesCompared = 0, stage = 'prefix-create'
    await report({ phase: stage, adapter: adapterInfo, adapterLimits: limits(adapter.limits), requiredLimits,
      deviceLimits: limits(device.limits), completedCases: 0 })
    try {
    const prefix = await ByteTentPrefix.create(device)
    stage = 'old-reference-create'
    const oldModule = device.createShaderModule({ code: oldShader, label: 'Unchanged production <=512 integer tent' })
    const oldErrors = (await oldModule.getCompilationInfo()).messages.filter(m => m.type === 'error')
    if (oldErrors.length) throw Error(oldErrors.map(m => m.message).join('\n'))
    const oldLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 1024 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ] })
    const oldPipeline = await device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [oldLayout] }),
      vertex: { module: oldModule, entryPoint: 'quad' }, fragment: { module: oldModule, entryPoint: 'reference', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' } })
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    const texture = (w: number, h: number) => device.createTexture({ size: [w, h], format: 'rgba8unorm', usage })
    function reference(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, sourceRect: any, output: any, axis: number, radius: number) {
      if (radius > 512) throw Error('Old GPU reference never runs beyond its admitted domain')
      const values = new Float32Array(256); values.set([output.x, output.y, output.w, output.h], 0)
      values.set([sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h], 4); values.set([radius, axis, 0, 1], 36)
      const uniform = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(uniform, 0, values)
      const group = device.createBindGroup({ layout: oldLayout, entries: [
        { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: source.createView() },
      ] })
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      pass.setPipeline(oldPipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end()
      return uniform
    }
    function copy(encoder: GPUCommandEncoder, target: GPUTexture) {
      const stride = Math.ceil(target.width * 4 / 256) * 256
      const buffer = device.createBuffer({ size: stride * target.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: stride }, [target.width, target.height])
      return { buffer, stride, width: target.width, height: target.height }
    }
    async function verify(read: ReturnType<typeof copy>, expected: number[], name: string) {
      await read.buffer.mapAsync(GPUMapMode.READ)
      const raw = new Uint8Array(read.buffer.getMappedRange())
      for (let y = 0; y < read.height; y++) for (let x = 0; x < read.width; x++) for (let c = 0; c < 4; c++) {
        const actual = raw[y * read.stride + x * 4 + c], value = c === 3 ? expected[y * read.width + x] : 0
        if (actual !== value) {
          await report({ phase: 'mismatch', name, x, y, channel: c, actual, expected: value, completedCases: records.length })
          throw Error(`${name} mismatch at (${x},${y}) channel${c}: ${actual} != ${value}`)
        }
      }
      read.buffer.unmap(); read.buffer.destroy(); return read.width * read.height * 4
    }
      for (const f of fixtures) {
        stage = `case:${f.name}`
        const source = texture(f.source.w, f.source.h), first = texture(f.intermediate.w, f.intermediate.h)
        const output = f.both ? texture(f.output.w, f.output.h) : first
        const pixels = new Uint8Array(f.source.w * f.source.h * 4)
        f.alpha.forEach((value: number, i: number) => { pixels[i * 4] = (i * 17) % 256; pixels[i * 4 + 3] = value })
        device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: f.source.w * 4 }, [f.source.w, f.source.h])
        const encoder = device.createCommandEncoder(), leases: any[] = [], oldUniforms: GPUBuffer[] = [], oldTargets: GPUTexture[] = []
        const firstLease = prefix.encode(encoder, source, first, { radius: f.radius, axis: f.axis, source: f.source,
          output: f.intermediate, scratchBudgetBytes: f.scratchBudgetBytes })
        if (!firstLease) throw Error(`Admitted fixture declined: ${f.name}`)
        leases.push(firstLease); const firstRead = copy(encoder, first)
        if (f.both) {
          const second = prefix.encode(encoder, first, output, { radius: f.radius, axis: 1, source: f.intermediate,
            output: f.output, scratchBudgetBytes: f.scratchBudgetBytes })
          if (!second) throw Error('Second axis declined'); leases.push(second)
        }
        const finalRead = f.both ? copy(encoder, output) : undefined
        let oldRead: ReturnType<typeof copy> | undefined
        if (f.radius <= 512) {
          const oldFirst = texture(f.intermediate.w, f.intermediate.h); oldTargets.push(oldFirst)
          oldUniforms.push(reference(encoder, source, oldFirst, f.source, f.intermediate, f.axis, f.radius))
          if (f.both) {
            const oldFinal = texture(f.output.w, f.output.h); oldTargets.push(oldFinal)
            oldUniforms.push(reference(encoder, oldFirst, oldFinal, f.intermediate, f.output, 1, f.radius)); oldRead = copy(encoder, oldFinal)
          } else oldRead = copy(encoder, oldFirst)
        }
        const scratchBytes = leases.reduce((sum, lease) => sum + lease.bytes, 0)
        if (scratchBytes > 4 * 1024 * 1024) throw Error('Combined two-axis scratch exceeded four MiB')
        if (f.scratchBudgetBytes && scratchBytes > f.scratchBudgetBytes) throw Error('Explicit finite scratch budget exceeded')
        maxScratchBytes = Math.max(maxScratchBytes, scratchBytes)
        device.queue.submit([encoder.finish()]); for (const lease of leases) lease.markSubmitted()
        const covered = device.queue.onSubmittedWorkDone()
        await covered; for (const lease of leases) await lease.retireAfter(covered)
        bytesCompared += await verify(firstRead, f.first, f.name + '/first')
        if (finalRead) bytesCompared += await verify(finalRead, f.final, f.name + '/final')
        if (oldRead) oldBytesCompared += await verify(oldRead, f.final, f.name + '/old-production')
        for (const uniform of oldUniforms) uniform.destroy()
        for (const target of new Set([source, first, output, ...oldTargets])) target.destroy()
        records.push({ name: f.name, radius: f.radius, both: !!f.both, scratchBytes, different: 0,
          bands: firstLease.plan.bands, bandLines: firstLease.plan.bandLines,
          lastBandLines: firstLease.plan.lines - (firstLease.plan.bands - 1) * firstLease.plan.bandLines,
          oldGpuReference: f.radius <= 512, twoCpuOracles: true })
        await report({ phase: 'case-passed', record: records.at(-1), completedCases: records.length, bytesCompared, oldBytesCompared })
      }
      // Real abandoned encoding: never submit this encoder after discarding it.
      stage = 'unsubmitted-abort'
      const source = texture(17, 3), target = texture(19, 3), abortedEncoder = device.createCommandEncoder()
      const lease = prefix.encode(abortedEncoder, source, target, { radius: 1920, axis: 0,
        source: { x: 0, y: 0, w: 17, h: 3 }, output: { x: -1, y: 0, w: 19, h: 3 } })!
      if (!lease) throw Error('Abort fixture unexpectedly declined')
      lease.discardUnsubmitted(); if (lease.bytes || !lease.retired) throw Error('Unsubmitted lease retained')
      source.destroy(); target.destroy()
      stage = 'submitted-lifetime'
      const liveSource = texture(17, 3), liveTarget = texture(17, 3), liveEncoder = device.createCommandEncoder()
      const live = prefix.encode(liveEncoder, liveSource, liveTarget, { radius: 2048, axis: 0,
        source: { x: 0, y: 0, w: 17, h: 3 }, output: { x: 0, y: 0, w: 17, h: 3 } })!
      device.queue.submit([liveEncoder.finish()]); live.markSubmitted()
      const completed = device.queue.onSubmittedWorkDone()
      let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve })
      const retiring = live.retireAfter(Promise.all([completed, hold]))
      await completed; if (!live.bytes || live.retired) throw Error('In-flight lease retired before its explicit covered boundary')
      release(); await retiring; if (live.bytes || !live.retired) throw Error('Covered lease was not retired')
      liveSource.destroy(); liveTarget.destroy()
      await device.queue.onSubmittedWorkDone()
      if (failures.length) throw Error(failures.join('\n'))
      return { adapter: adapterInfo, adapterLimits: limits(adapter.limits), requiredLimits, deviceLimits: limits(device.limits),
        cases: records, bytesCompared, oldBytesCompared, different: 0, maxScratchBytes,
        abortedUnsubmitted: true, coveredCompletionLifetime: true,
        limitation: 'Operator alpha proof, not whole-FIG latency, appearance, edit/history or export acceptance' }
    } catch (error) {
      await report({ phase: 'failed', stage, error: String(error), adapter: adapterInfo, adapterLimits: limits(adapter.limits),
        requiredLimits, deviceLimits: limits(device.limits), completedCases: records.length, records, failures,
        bytesCompared, oldBytesCompared })
      throw error
    } finally { device.destroy() }
  }, { fixtures: prepared, oldShader }) })
  return result
})
