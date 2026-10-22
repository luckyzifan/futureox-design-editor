/** Actual-device oracle for the regional painter dependency certificate.
 * The unchanged whole-frame compiler supplies the wider exact reference.
 * These small authored fixtures do not replace the real 117/FIG motion gate. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

await runProof('futureox-painter-support-region', [], async proof => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  const variants = ['prefix', 'prefix-large', 'prefix-near-tap', 'dyadic-fine-phase', 'dyadic-finer-phase', 'reverse-order', 'two-backdrops', 'nested', 'clipped', 'rotated', 'gradient-fallback', 'mask-fallback',
    'transparent-layer', 'transparent-layer-hdr', 'transparent-layer-clipped', 'image-prefix', 'image-partial-prefix',
    'unmanaged-shadow', 'unmanaged-shadow-integer', 'unmanaged-shadow-negative-offset', 'unmanaged-shadow-fractional-fallback', 'unmanaged-shadow-parent-clip']
  const cases = variants.flatMap(variant => [1, 1.375].map(zoom => ({ variant, zoom })))
  const contract = { cases, captureReads: process.env.DESIGN_PAINTER_CAPTURE_READS === '1', byteDriver: process.env.VITE_DESIGN_BYTE_TENT_PREFIX === '1', wasmSha256: sha256(wasm), gate: 'Every admitted regional component in its native RGBA32F or RGBA8 output format must equal the unchanged wider full-frame GPU crop. A rejected domain must emit the exact legacy same-crop scene and retain raw GPU equality to that scene. Wider-reference differences remain reported for rejected domains and cannot be called newly certified. All output components must be finite; at least one admitted case must reduce allocation extent.',
    scope: 'Exact authored small-scene GPU pixel comparison, including painter order, a second backdrop, isolation, clipping, affine phase, unmanaged outer shadows and unsupported-domain fallback. Managed output uses raw RGBA32F; unmanaged output uses the native RGBA8 format. Not real-document motion or latency acceptance.' }
  await proof.write('fixtures.json', contract)
  if (proof.prepareOnly) return { ...contract, gpuExecuted: false }
  const result = await proof.browser(page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    if (await digest(new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())) !== payload.wasmSha256)
      throw Error('Actual browser WASM differs from bound input')
    const records: any[] = []; let components = 0, different = 0, widerReferenceDifferences = 0, reduced = 0, compactWrites = 0, captureReadsChangedScenes = 0, byteTentAlphaPasses = 0
    const crop = { x: 47, y: 39, w: 64, h: 57 }, fullWidth = 168, fullHeight = 145
    const images: string[] = []
    for (const partial of [false, true]) {
      const canvas = new OffscreenCanvas(8, 8), context = canvas.getContext('2d')!, pixels = context.createImageData(8, 8)
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4
        pixels.data.set([(x * 37 + y * 11) % 256, (x * 19 + y * 43) % 256,
          (x * 71 + y * 13) % 256, partial ? (x + y) % 3 === 0 ? 0 : 153 : 255], i)
      }
      context.putImageData(pixels, 0, 0)
      images.push('data:image/png;base64,' + btoa(String.fromCharCode(...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()))))
    }
    try {
    for (const { variant, zoom } of payload.cases) {
      const managed = !variant.startsWith('unmanaged-'), color = managed ? defaultColorSettings() : undefined
      const effect = (kind: string, radius: number) => ({ kind, radius, color: '#000000' })
      const doc: any = { schemaVersion: 9, id: 'painter-oracle', name: variant, colorManagement: color,
        pages: [{ id: 'p', name: 'p', background: '#57697c', children: ['frame'] }], nodes: {
          frame: { id: 'frame', kind: 'frame', width: 180, height: 160, transform: [1, 0, 0, 1, -9.375, -7.125],
            children: ['source', 'detail', 'backdrop', 'second', 'distant'], clip: variant === 'clipped',
            fills: [{ kind: 'solid', color: '#9fb1c3' }] },
          source: { id: 'source', kind: 'rectangle', width: 155, height: 141, transform: [1, 0, 0, 1, 3.125, 1.375],
            fills: [{ kind: 'solid', color: '#cb6327', opacity: .71 }], effects: [effect('blur', 7.125)] },
          detail: { id: 'detail', kind: 'ellipse', width: 77, height: 65, transform: [1, .125, -.25, 1, 31.375, 24.125],
            fills: [{ kind: 'solid', color: '#265faf', opacity: .83 }], effects: [effect('blur', .25)] },
          backdrop: { id: 'backdrop', kind: 'rectangle', width: 128, height: 101, radii: [7, 7, 7, 7],
            transform: [1, 0, 0, 1, 14.375, 15.125], fills: [{ kind: 'solid', color: '#d8e7f9', opacity: .23 }],
            effects: [effect('background-blur', 11.375)] },
          second: { id: 'second', kind: 'rectangle', width: 90, height: 96, transform: [1, 0, 0, 1, 47.125, 19.375],
            fills: [{ kind: 'solid', color: '#39627f', opacity: .19 }], effects: [] },
          distant: { id: 'distant', kind: 'rectangle', width: 16, height: 16, transform: [1, 0, 0, 1, 1700, 1600],
            fills: [{ kind: 'solid', color: '#ffffff', opacity: .4 }], effects: [effect('background-blur', 23.125)] },
        } }
      if (variant === 'reverse-order') doc.nodes.frame.children = ['backdrop', 'source', 'detail', 'second', 'distant']
      if (variant === 'prefix-large') doc.nodes.backdrop.effects[0].radius = 35.125
      if (variant === 'prefix-near-tap') doc.nodes.backdrop.effects[0].radius = 32.00000000000001
      if (variant === 'dyadic-fine-phase' || variant === 'dyadic-finer-phase') {
        const denominator = variant === 'dyadic-fine-phase' ? 1024 : 2048
        // These exactly represented phases were deliberately outside the old
        // fixed 1/512 proof. Keep the wider compiler/crop reference unchanged.
        doc.nodes.backdrop.transform[4] += 1 / denominator
        doc.nodes.backdrop.transform[5] -= 1 / denominator
      }
      if (variant === 'two-backdrops') doc.nodes.second.effects = [effect('background-blur', 4.000000000000001)]
      if (variant === 'nested') {
        doc.nodes.inner = { id: 'inner', kind: 'group', width: 155, height: 145, opacity: .77, blend: 'normal',
          transform: [1, 0, 0, 1, .125, -.375], children: ['source', 'detail', 'backdrop'], effects: [effect('blur', 2.75)] }
        doc.nodes.frame.children = ['inner', 'second', 'distant']
      }
      if (variant === 'rotated') doc.nodes.backdrop.transform = [.992197667, .124674733, -.124674733, .992197667, 14.375, 15.125]
      if (variant === 'gradient-fallback') doc.nodes.source.fills = [{ kind: 'linear', color: '#ffffff',
        stops: [{ offset: 0, color: '#113355' }, { offset: 1, color: '#da7921' }] }]
      if (variant === 'mask-fallback') { doc.nodes.detail.mask = true; doc.nodes.detail.maskType = 'alpha' }
      if (variant.startsWith('image-')) doc.nodes.source.fills = [{ kind: 'image', color: '#ffffff', fit: 'stretch',
        image: images[variant === 'image-partial-prefix' ? 1 : 0] }]
      if (variant.startsWith('transparent-layer')) {
        // The real 117 pressure case paints a small finite solid into a much
        // wider, shared transparent sample plane. Keep the wider reference
        // compiler unchanged: only the admitted regional scene may compact
        // that proven-zero destination. A backdrop keeps painter domains live.
        doc.nodes.small = { id: 'small', kind: 'ellipse', width: 23.25, height: 18.75,
          transform: [1, 0, 0, 1, 49.125, 42.375], fills: [{ kind: 'solid',
            color: variant === 'transparent-layer-hdr' ? '#e5b47d' : '#5a73bf', opacity: .63 }] }
        if (variant === 'transparent-layer-hdr')
          doc.nodes.small.fills[0].color = 'color(srgb-linear 3.25 -0.125 0.03125 / 0.71)'
        doc.nodes.isolate = { id: 'isolate', kind: 'group', width: 180, height: 160,
          opacity: .71, blend: 'normal', transform: [1, 0, 0, 1, 0, 0],
          clip: variant === 'transparent-layer-clipped', children: ['small'] }
        doc.nodes.frame.children = ['source', 'detail', 'isolate', 'backdrop', 'second', 'distant']
      }
      if (!managed) {
        delete doc.colorManagement
        doc.nodes.frame.children = ['source']
        for (const id of Object.keys(doc.nodes)) if (id !== 'frame' && id !== 'source') delete doc.nodes[id]
        // The zero-spread shifted alpha domain differs from backdrop-prefix
        // dependencies. Keep integer positive/negative offsets plus a rejected
        // fractional offset as a wider-reference fallback control.
        const offset = variant === 'unmanaged-shadow-negative-offset' ? -8 :
          variant === 'unmanaged-shadow-fractional-fallback' ? 8.125 : 8
        doc.nodes.source.effects = [{ kind: 'shadow', radius: variant === 'unmanaged-shadow-integer' ? 12 : 13.375, x: 0, y: offset,
          spread: 0, color: '#263759', opacity: .63 }]
        doc.nodes.source.width = 113; doc.nodes.source.height = 89
        if (variant === 'unmanaged-shadow-parent-clip') {
          // A real native ancestor mask crosses the crop at diagonal edges.
          // The 3/5,4/5 rotation preserves radius scale; radius8 and the
          // authored inverse-rotated offset map to integer device radii8/11
          // and offsets(8,0)/(11,0) at the two zooms. The wider reference keeps
          // the original <=512 shader, not the new byte-prefix implementation.
          Object.assign(doc.nodes.frame, { width: 105, height: 91, clip: true,
            transform: [.6, .8, -.8, .6, 82.375, -12.125] })
          doc.nodes.source.effects[0] = { kind: 'shadow', radius: 8, x: 4.8, y: -6.4,
            spread: 0, color: '#263759', opacity: .63 }
        }
      }
      const kernel = new VectorEngine(), gpu = await createGpu('webgpu', true, false, color, (uri, byte, level) => {
        const [width, height] = JSON.parse(kernel.image_info_at_level(uri, level || 0))
        return byte ? { width, height, pixels: new Float32Array(0), bytes: kernel.image_rgba8_at_level(uri, level || 0) }
          : { width, height, pixels: kernel.image_linear_at_level(uri, level || 0) }
      }, false, managed)
      const renderer = gpu as any, compactPlan = renderer.compactSolidPlan, paintOver = renderer.paintOver,
        materialize = renderer.materializePainterTargets
      const compactWitness = { acceptedPlans: 0, actualWrites: 0, declinedPlans: 0, materializedSamples: 0 }
      let candidatePhase = false
      renderer.compactSolidPlan = function (...args: any[]) {
        const result = compactPlan.apply(this, args)
        if (candidatePhase) {
          if (result && !result.unchanged) compactWitness.acceptedPlans++
          else if (!result) compactWitness.declinedPlans++
        }
        return result
      }
      renderer.paintOver = function (...args: any[]) {
        const result = paintOver.apply(this, args), before = args[3]
        const observe = (surface: any) => {
          if (candidatePhase && surface !== before && surface.compactMaxAbs) compactWitness.actualWrites++
          return surface
        }
        return result instanceof Promise ? result.then(observe) : observe(result)
      }
      renderer.materializePainterTargets = function (targets: any[]) {
        if (candidatePhase) compactWitness.materializedSamples += targets.filter(target => target.logicalBounds).length
        return materialize.call(this, targets)
      }
      try {
        const original = JSON.stringify(doc); kernel.load_document(original)
        const options = { pageId: 'p', width: fullWidth, height: fullHeight, view: { x: .125, y: -.375, zoom },
          transparent: true, grid: false, rasterProfile: 'figmaSubpixel', interactiveEffects: false }
        const fullScene = JSON.parse(kernel.compile_gpu(JSON.stringify(options)))
        const legacyScene = JSON.parse(kernel.compile_gpu(JSON.stringify({ ...options, width: crop.w, height: crop.h, gpuViewport: crop,
          gpuPainterSupport: false })))
        const phaseThree = JSON.parse(kernel.compile_gpu(JSON.stringify({ ...options, width: crop.w, height: crop.h, gpuViewport: crop,
          gpuPainterSupport: true })))
        const scene = payload.captureReads ? JSON.parse(kernel.compile_gpu(JSON.stringify({ ...options, width: crop.w, height: crop.h,
          gpuViewport: crop, gpuPainterSupport: true, gpuPainterCaptureReads: true }))) : phaseThree
        const captureReadsChangedScene = JSON.stringify(scene) !== JSON.stringify(phaseThree)
        if (captureReadsChangedScene) captureReadsChangedScenes++
        const certificateUsed = !!scene.rootInputBox || Object.values(scene.nodes).some((n: any) => n.backdropOutputBox || n.shadowOutputBox)
        const legacySceneEqual = JSON.stringify(scene) === JSON.stringify(legacyScene)
        if (variant.startsWith('dyadic-') && !certificateUsed)
          throw Error('The fine dyadic phase did not exercise the new native certificate')
        if (!certificateUsed && !legacySceneEqual) throw Error('Rejected painter domain changed the legacy same-crop scene')
        if (!fullScene.integratedBlur || !scene.integratedBlur || scene.displayFilters)
          throw Error('Expected unchanged exact managed integrated-tent scene')
        for (const [id, node] of Object.entries(scene.nodes) as [string, any][]) {
          const old = fullScene.nodes[id]
          if (!old || JSON.stringify(node.matrix) !== JSON.stringify(old.matrix) || JSON.stringify(node.inverse) !== JSON.stringify(old.inverse) || JSON.stringify(node.effects) !== JSON.stringify(old.effects))
            throw Error('Regional compiler changed authored matrix, inverse or effects')
        }
        const full = await gpu.render(fullScene, true, false)
        candidatePhase = true
        const actual = await gpu.render(scene, true, false)
        const bytePasses = Number(gpu.driver.stats?.().byteTentAlphaPasses || 0)
        if (payload.byteDriver && variant === 'unmanaged-shadow-parent-clip' && bytePasses !== 2)
          throw Error('Native diagonal ancestor-clip fixture did not execute both production byte-shadow axes')
        byteTentAlphaPasses += bytePasses
        candidatePhase = false
        compactWrites += compactWitness.actualWrites
        if (full.backend !== 'webgpu' || actual.backend !== 'webgpu' || gpu.driver.lost ||
            (managed ? !full.linear || !actual.linear : !full.rgba || !actual.rgba))
          throw Error('Missing completed actual-device exact float readback')
        const a = (managed ? actual.linear : actual.rgba)!, b = (managed ? full.linear : full.rgba)!
        if (a.length !== crop.w * crop.h * 4 || b.length !== fullWidth * fullHeight * 4) throw Error('Wrong readback dimensions')
        const aa = managed ? new Uint32Array(a.buffer, a.byteOffset, a.length) : a,
          bb = managed ? new Uint32Array(b.buffer, b.byteOffset, b.length) : b
        let differences = 0, nonfinite = 0; const examples = []
        for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) for (let c = 0; c < 4; c++) {
          const i = (y * crop.w + x) * 4 + c, j = ((y + crop.y) * fullWidth + x + crop.x) * 4 + c
          if (!Number.isFinite(a[i]) || !Number.isFinite(b[j])) nonfinite++
          if (aa[i] !== bb[j]) { differences++; if (examples.length < 8) examples.push({ x, y, channel: c, reference: bb[j], candidate: aa[i] }) }
        }
        components += a.length; widerReferenceDifferences += differences
        let legacyCropDifferences: number | undefined
        if (!certificateUsed) {
          const legacy = await gpu.render(legacyScene, true, false), values = (managed ? legacy.linear : legacy.rgba)!
          if (!values || values.length !== a.length) throw Error('Legacy fallback GPU readback missing')
          const words = managed ? new Uint32Array(values.buffer, values.byteOffset, values.length) : values
          legacyCropDifferences = 0
          for (let i = 0; i < aa.length; i++) if (aa[i] !== words[i]) legacyCropDifferences++
        }
        different += certificateUsed ? differences : legacyCropDifferences || 0
        const pixels = (r: any) => r.w * r.h
        const smaller = pixels(scene.extent) < pixels(fullScene.extent); if (smaller && certificateUsed) reduced++
        records.push({ variant, zoom, format: managed ? 'rgba32float' : 'rgba8unorm', components: a.length, differences, nonfinite, examples,
          certificateUsed, compactWitness, captureReadsChangedScene, byteTentAlphaPasses: bytePasses,
          comparisonGate: certificateUsed ? 'unchanged-wider-GPU-crop' : 'unchanged-legacy-same-crop-GPU',
          legacySceneEqual, legacyCropDifferences,
          certifiedBackdropNodes: Object.values(scene.nodes).filter((n: any) => n.backdropOutputBox).length,
          certifiedShadowNodes: Object.values(scene.nodes).filter((n: any) => n.shadowOutputBox).length,
          fullExtent: fullScene.extent, regionalExtent: scene.extent, extentReduced: smaller,
          peakTextureBytes: actual.peakTextureBytes, documentPreserved: JSON.stringify(doc) === original,
          actualSha256: await digest(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) })
        if ((certificateUsed ? differences : legacyCropDifferences) || nonfinite) throw Error(`Exact painter dependency crop failed: ${variant}/${zoom}`)
      } finally { gpu.dispose(); kernel.free() }
    }
    if (!reduced) throw Error('No case actually exercised smaller dependency allocation')
    if (!compactWrites) throw Error('No case actually exercised compact solid accumulation')
    if (payload.captureReads && !captureReadsChangedScenes) throw Error('No case actually exercised captured-source trimming')
    if (payload.byteDriver && !byteTentAlphaPasses) throw Error('No case actually exercised the byte-shadow renderer route')
    return { status: 'passed', components, different, widerReferenceDifferences, reduced, compactWrites, captureReadsChangedScenes, byteTentAlphaPasses,
      admittedCases: records.filter(row => row.certificateUsed).length, fallbackCases: records.filter(row => !row.certificateUsed).length, records }
    } catch (error) { return { status: 'failed', error: String(error), components, different, widerReferenceDifferences, reduced, records } }
  }, contract))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Exact painter dependency oracle failed')
  return { ...contract, ...result }
})
