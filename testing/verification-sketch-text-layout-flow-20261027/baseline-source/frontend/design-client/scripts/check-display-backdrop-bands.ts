/** Actual GPU operator proof. Calls the production private display-band
 * operator and compares every raw f32 word with independent, whole-surface
 * driver H/V passes at the SAME selected display radius, plus scalar-shader
 * probes at edges and strip seams. This does not prove
 * original-radius display equivalence, whole-editor acceptance or latency. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { selectDisplayTentRadius } from '../src/kernel/gpu/display-tent-radius'
import { planDisplayBackdropBands } from '../src/kernel/gpu/display-backdrop-bands'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

if (process.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1' || process.env.VITE_DESIGN_DISPLAY_TENT_RADIUS !== '1')
  throw Error('Both strict display-radius and clamp-prefix gates are required')
await runProof('futureox-display-backdrop-bands', [], async proof => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  initSync({ module: wasm })
  const fixtures = [
    { name: 'integer-zero-edge-seams', rect: { x: -19, y: 23, w: 131, h: 129 }, radius: 513.25, clamp: false },
    { name: 'fractional-clamped-seams', rect: { x: -1797.8828125, y: 964.162109375, w: 131, h: 129 }, radius: 1177.2149658203123, clamp: true },
    { name: 'fractional-zero-edge-seams', rect: { x: -1797.8828125, y: 964.162109375, w: 65, h: 67 }, radius: 1177.2149658203123, clamp: false },
    { name: 'maximum-clamped-tail', rect: { x: 0.125, y: -0.375, w: 67, h: 65 }, radius: 2048, clamp: true },
  ].map(fixture => {
    const selected = selectDisplayTentRadius(fixture.radius, true)
    const plan = planDisplayBackdropBands(fixture.rect, selected, fixture.clamp)
    if (!plan) throw Error(`Expected admitted address plan: ${fixture.name}`)
    const values = new Float32Array(fixture.rect.w * fixture.rect.h * 4)
    const words = new Uint32Array(values.buffer)
    for (let y = 0; y < fixture.rect.h; y++) for (let x = 0; x < fixture.rect.w; x++) {
      const pixel = (y * fixture.rect.w + x) * 4
      for (let channel = 0; channel < 4; channel++) {
        values[pixel + channel] = ((x * 17 + y * 31 + channel * 53) % 251 + 1) / 256
        if ((x + y + channel) % 11 === 0) words[pixel + channel] = (x + y) % 2 ? 0 : 0x80000000
      }
    }
    return { ...fixture, selected, rows: plan.rows.length, columns: plan.columns.length,
      words: [...words], kernel: [...rational_tent_kernel_rgba(selected)], certified: [...certified_tent_kernel_rgba(selected)] }
  })
  const manifest = { wasmSha256: sha256(wasm), fixturesSha256: sha256(JSON.stringify(fixtures)), cases: fixtures.length,
    scope: 'Raw f32 band-vs-whole SAME selected-radius operator/address proof; full surfaces, fractional origins, both edge policies, 64-pixel seams and tails. No original-radius quality or app latency claim.' }
  await proof.write('fixtures.json', { ...manifest, fixtures })
  if (proof.prepareOnly) return manifest
  const result = await proof.browser(async page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const { GpuRenderer } = await import('/src/kernel/gpu/renderer.ts')
    const { parameters } = await import('/src/kernel/gpu/types.ts')
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    if (await digest(new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())) !== payload.wasmSha256)
      throw Error('Actual browser WASM differs from the bound input')
    const records: any[] = []; let components = 0, different = 0, scalarComponents = 0
    for (const fixture of payload.fixtures) {
      const driver = await WebGpuDriver.create(true, false, true, true, false)
      const renderer = new GpuRenderer(driver, true, false) as any
      let target: any
      try {
        const scene: any = { version: 7, width: fixture.rect.w, height: fixture.rect.h, extent: fixture.rect,
          nodes: {}, roots: [], vertices: [], integratedBlur: true, floatCompositing: true, displayTentRadius: true }
        renderer.scene = scene
        await driver.prepareScene(scene); await driver.prepareFilters(true)
        driver.begin(new Float32Array(0))
        const source = renderer.acquire(fixture.rect)
        ;(driver as any).device.queue.writeTexture({ texture: source.texture.resource }, new Uint32Array(fixture.words),
          { bytesPerRow: fixture.rect.w * 16 }, [fixture.rect.w, fixture.rect.h])
        const kernel = renderer.filterKernel('rational-tent', fixture.selected, () => new Uint8Array(fixture.kernel))
        const certified = renderer.certifiedKernel(fixture.selected)
        const horizontal = renderer.acquire(fixture.rect), whole = renderer.acquire(fixture.rect)
        const axis = (output: any, input: any, dimension: number) => {
          const u = parameters(fixture.rect, input.rect, kernel.rect, certified?.rect)
          u[16] = 22; u.set([fixture.selected, dimension, fixture.clamp ? 1 : 0, 1], 36)
          const textures = [input.texture, kernel.texture, ...(certified ? [certified.texture] : [])]
          const before = driver.scratchBytes || 0
          driver.prepareFilterPass?.(output.texture, u, textures, 15, { kind: 'tent', radius: fixture.selected },
            256 * 1024 * 1024 - renderer.workingBytes)
          renderer.bytes += (driver.scratchBytes || 0) - before
          driver.pass(output.texture, u, textures, undefined, 15, { kind: 'tent', radius: fixture.selected })
        }
        axis(horizontal, source, 0); axis(whole, horizontal, 1)
        const reference = new Uint32Array((await driver.readSurface(whole.texture)).buffer)
        const horizontalReference = new Uint32Array((await driver.readSurface(horizontal.texture)).buffer)
        // Do not pass a filter contract or prepareFilterPass here. These tiny
        // independent controls execute the ORIGINAL rational scalar reducer,
        // including its clamp and f32 origin arithmetic; no prefix shortcut.
        const controls: any[] = []
        for (const dimension of [0, 1]) for (const [x, y] of [[0, 0], [63, 63], [64, 64], [fixture.rect.w - 1, fixture.rect.h - 1]]) {
          const rect = { x: fixture.rect.x + x, y: fixture.rect.y + y, w: 1, h: 1 }
          const input = dimension === 0 ? source : horizontal, expected = dimension === 0 ? horizontalReference : reference
          const target = driver.create(1, 1), u = parameters(rect, input.rect, kernel.rect, certified?.rect)
          u[16] = 22; u.set([fixture.selected, dimension, fixture.clamp ? 1 : 0, 1], 36)
          try {
            driver.pass(target, u, [input.texture, kernel.texture, ...(certified ? [certified.texture] : [])], undefined, 15)
            const scalar = new Uint32Array((await driver.readSurface(target)).buffer), offset = (y * fixture.rect.w + x) * 4
            let differences = 0
            for (let channel = 0; channel < 4; channel++) if (scalar[channel] !== expected[offset + channel]) differences++
            scalarComponents += 4
            controls.push({ axis: dimension, x, y, components: 4, differences })
            if (differences) throw Error(`Original scalar seam/edge control differs: ${fixture.name}/${dimension}/${x},${y}`)
          } finally { driver.destroy(target) }
        }
        renderer.release(horizontal, whole)
        const node: any = { blend: 'normal', passthrough: false,
          effects: [{ visible: true, kind: 'background-blur', radius: fixture.radius }], rect: fixture.rect }
        target = await renderer.blurDisplayBackdropBands(source, fixture.radius / 2, node, fixture.clamp)
        if (!target) throw Error('Production band operator did not admit fixture')
        const actual = new Uint32Array((await driver.readSurface(target.texture)).buffer)
        const examples: any[] = []; let differences = 0
        if (actual.length !== reference.length) throw Error('Extent mismatch')
        for (let i = 0; i < actual.length; i++) if (actual[i] !== reference[i]) {
          differences++; if (examples.length < 8) examples.push({ component: i, expected: reference[i], actual: actual[i] })
        }
        components += actual.length; different += differences
        const beforeFinish = driver.stats()
        await driver.finish(target.texture, target.rect, fixture.rect.w, fixture.rect.h, false, undefined, false)
        if (driver.scratchBytes) throw Error('Finish retained filter scratch')
        records.push({ name: fixture.name, radius: fixture.radius, selectedRadius: fixture.selected, clamp: fixture.clamp,
          components: actual.length, differences, examples, rows: fixture.rows, columns: fixture.columns,
          productionOperatorExecuted: true, displayRadiusChangedAxes: renderer.displayTentRadiusPasses,
          scalarControls: controls, adapter: beforeFinish.adapter, rendererPeakTextureBytes: renderer.peak })
        if (differences) throw Error(`${fixture.name}: ${differences} raw f32 differences`)
      } catch (error) {
        await driver.abortFrameAndReleaseFilterScratch('cancel').catch(() => {})
        return { status: 'failed', components, different, scalarComponents, records, error: String(error), stack: error instanceof Error ? error.stack : undefined }
      } finally { renderer.dispose() }
    }
    return { status: 'passed', components, different, scalarComponents, records }
  }, { fixtures, wasmSha256: manifest.wasmSha256 }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Display backdrop GPU proof failed')
  return { ...manifest, ...result }
})
