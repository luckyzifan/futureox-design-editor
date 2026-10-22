/** Diagnostic GPU execution of explicitly supplied real-document regional
 * requests. Private documents/requests/pixels stay outside source control.
 * This establishes execution/budget failures, not independent pixel parity. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'
const documentPath = process.env.DESIGN_PAINTER_DOCUMENT, requestsPath = process.env.DESIGN_PAINTER_REQUESTS
if (!documentPath || !requestsPath) throw Error('Set DESIGN_PAINTER_DOCUMENT and DESIGN_PAINTER_REQUESTS')
const budget = Number(process.env.DESIGN_PAINTER_WORKING_MIB || 256)
const diagnostics = process.env.DESIGN_PAINTER_DIAGNOSTICS === '1'
const presentOnly = process.env.DESIGN_PAINTER_PRESENT === '1'
const imageSourceCandidate = process.env.DESIGN_PAINTER_IMAGE_SOURCE === '1'
const captureReads = process.env.DESIGN_PAINTER_CAPTURE_READS === '1'
const painterSupport = process.env.DESIGN_PAINTER_SUPPORT !== '0'
const saveReadback = process.env.DESIGN_PAINTER_SAVE_READBACK === '1'
const requireByteTent = process.env.DESIGN_PAINTER_REQUIRE_BYTE_TENT === '1'
const displayTentRadiusCandidate = process.env.DESIGN_PAINTER_DISPLAY_TENT_RADIUS === '1'
const requireBackdropBands = process.env.DESIGN_PAINTER_REQUIRE_BACKDROP_BANDS === '1'
const imageStreamSetting = process.env.DESIGN_PAINTER_IMAGE_STREAM
if (imageStreamSetting !== undefined && imageStreamSetting !== '0' && imageStreamSetting !== '1')
  throw Error('Image stream diagnostic control must be absent, 0 or 1')
const imageStreamControl = imageStreamSetting === '0' ? 'disabled-reference'
  : imageStreamSetting === '1' ? 'required' : 'normal'
if (imageSourceCandidate && !presentOnly) throw Error('Display image-source probe requires actual presentation transport')
if (displayTentRadiusCandidate && !presentOnly) throw Error('Display radius probe requires actual presentation transport')
if (requireBackdropBands && !displayTentRadiusCandidate) throw Error('Backdrop-band probe requires explicit display radius intent')
if (!Number.isInteger(budget) || budget < 256 || budget > 4096) throw Error('Working MiB must be 256..4096')
const fontPath = join(project, 'public/fonts/NotoSansSC.ttf')
await runProof('futureox-painter-real-region', [resolve(documentPath), resolve(requestsPath),
  resolve(project, '../design-desktop/src/render-terminal-diagnostics.mjs')], async proof => {
  const [documentBytes, requestBytes, wasm] = await Promise.all([readFile(documentPath), readFile(requestsPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))])
  const document = JSON.parse(documentBytes.toString()), requested = JSON.parse(requestBytes.toString())
  if (!Array.isArray(requested) || !requested.length || requested.length > 4) throw Error('Supply 1..4 explicit regional requests')
  const requests = requested.map(request => ({ ...request, gpuPainterSupport: painterSupport,
    gpuPainterCaptureReads: painterSupport && captureReads }))
  const manifest = { documentSha256: sha256(documentBytes), requestsSha256: sha256(requestBytes),
    fontSha256: sha256(await readFile(fontPath)), wasmSha256: sha256(wasm), requests: requests.length, workingBudgetMiB: budget,
    painterSupportExplicitlyRequested: painterSupport, executionRequestsSha256: sha256(JSON.stringify(requests)),
    diagnostics, requireBackdropBands, timingScope: 'Cold diagnostic request including native compilation, pipeline preparation and GPU completion/readback; not production input latency.',
    presentOnly, imageSourceCandidate, captureReads, saveReadback, imageStreamControl, requireByteTent, displayTentRadiusCandidate,
    requestedBuildFlags: Object.fromEntries(['VITE_DESIGN_EXACT_CLAMP_PREFIX', 'VITE_DESIGN_BYTE_TENT_PREFIX',
      'VITE_DESIGN_QUEUE_WAIT_TIMING', 'VITE_DESIGN_GPU_TIMINGS', 'VITE_DESIGN_DISPLAY_TENT_RADIUS'].map(key => [key, process.env[key] ?? null])),
    scope: 'Actual WebGPU execution/readback of supplied native regional requests at an explicit diagnostic working budget. Not independent pixel parity, actual app memory policy, motion or latency acceptance.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return { ...manifest, gpuExecuted: false }
  const result = await proof.browser(async page => {
    if (presentOnly || saveReadback) await page.exposeFunction('painterGpuPixels', async (value: {
      index: number; rgba?: number[]; words?: number[]; format?: string }) =>
      proof.write(`private-${presentOnly ? 'presented' : 'readback'}-pixels-${value.index}.json`, value))
    return page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    const diagnosticApi = await import('/@fs' + payload.diagnosticsModulePath)
    const diagnosticEvents: unknown[] = []; let diagnosticsDropped = 0
    if (payload.manifest.diagnostics) {
      diagnosticApi.setGpuDiagnosticsDetail(true)
      diagnosticApi.setGpuDiagnosticSink((event: string, fields: unknown) => {
        if (diagnosticEvents.length < 2048) diagnosticEvents.push({ event, ...diagnosticApi.sanitizeFields(fields) })
        else diagnosticsDropped++
      })
    }
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    if (await digest(new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())) !== payload.manifest.wasmSha256)
      throw Error('Actual browser WASM differs from bound input')
    const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
    if (await digest(font) !== payload.manifest.fontSha256) throw Error('Actual browser font differs from bound input')
    const engine = new VectorEngine(), records: any[] = []
    engine.load_font(font); engine.load_document(JSON.stringify(payload.document))
    try {
      for (const [requestIndex, request] of payload.requests.entries()) {
        let gpu: Awaited<ReturnType<typeof createGpu>> | undefined, stage = 'compile', sceneSummary: unknown
        const started = performance.now()
        try {
          const native = engine.compile_gpu(JSON.stringify(request)), scene = JSON.parse(native), color = scene.colorManagement
          if (payload.manifest.imageSourceCandidate) scene.displayImageSource = true
          if (payload.manifest.displayTentRadiusCandidate) scene.displayTentRadius = true
          if (payload.manifest.presentOnly && (scene.output?.w ?? scene.width) * (scene.output?.h ?? scene.height) > 1048576)
            throw Error('Presented diagnostic pixel capture exceeds one megapixel')
          sceneSummary = { width: scene.width, height: scene.height, output: scene.output, extent: scene.extent,
            rootInputBox: scene.rootInputBox, nodes: Object.keys(scene.nodes).length,
            backdropCertificates: Object.values(scene.nodes).filter((n: any) => n.backdropOutputBox).length,
            shadowCertificates: Object.values(scene.nodes).filter((n: any) => n.shadowOutputBox).length }
          stage = 'create-device'
          gpu = await createGpu('webgpu', true, false, color, (uri, byte, level) => {
            const [width, height] = JSON.parse(engine.image_info_at_level(uri, level || 0))
            return byte ? { width, height, pixels: new Float32Array(0), bytes: engine.image_rgba8_at_level(uri, level || 0) } :
              { width, height, pixels: engine.image_linear_at_level(uri, level || 0) }
          }, false, !!(color || scene.floatCompositing), false, false, false, payload.manifest.workingBudgetMiB)
          let imageStreamHits = 0
          const streamRenderer = gpu as any, originalImageStream = streamRenderer.streamImageLeaf
          let backdropBandHits = 0
          const backdropBandProbes: unknown[] = [], originalBackdropBands = streamRenderer.blurDisplayBackdropBands
          if (payload.manifest.requireBackdropBands && typeof originalBackdropBands !== 'function')
            throw Error('Required production backdrop-band operator is missing')
          if (typeof originalBackdropBands === 'function') {
            streamRenderer.blurDisplayBackdropBands = async function (this: any, ...args: any[]) {
              const [input, sigma, node, clampEdges] = args
              const probe: any = { radius: sigma * 2, input: { ...input.rect }, clampEdges,
                effects: node.effects?.map((effect: any) => ({ kind: effect.kind, visible: effect.visible,
                  gradient: !!effect.gradientBlur })), completed: false, admitted: false }
              if (backdropBandProbes.length < 64) backdropBandProbes.push(probe)
              try {
                const value = await originalBackdropBands.apply(this, args)
                probe.completed = true; probe.admitted = value !== undefined
                if (value !== undefined) {
                  if (!value?.texture || !value?.rect) throw Error('Production backdrop band returned no surface')
                  backdropBandHits++; probe.output = { ...value.rect }
                }
                return value
              } catch (error) { probe.error = String(error); throw error }
            }
          }
          streamRenderer.__painterBackdropBandProbes = backdropBandProbes
          if (payload.manifest.imageStreamControl !== 'normal' && typeof originalImageStream !== 'function')
            throw Error('Explicit image stream diagnostic requires the production streamImageLeaf method')
          if (typeof originalImageStream === 'function') {
            // Test-only negative route: leave every native/shader/crop input
            // unchanged, but retain the former whole-surface allocation path.
            streamRenderer.streamImageLeaf = payload.manifest.imageStreamControl === 'disabled-reference'
              ? async () => undefined : async function (this: any, ...args: any[]) {
                const value = await originalImageStream.apply(this, args)
                if (value !== undefined) {
                  if (!Array.isArray(value) || value.length !== 4 || value.some(surface => !surface?.texture || !surface?.rect))
                    throw Error('Production image stream returned an invalid sample tuple')
                  imageStreamHits++
                }
                return value
              }
          }
          const byteShadowProbes: unknown[] = []
          streamRenderer.__painterByteShadowProbes = byteShadowProbes
          const originalByteShadow = streamRenderer.streamByteShadow
          if (payload.manifest.diagnostics && typeof originalByteShadow === 'function')
            streamRenderer.streamByteShadow = async function (this: any, ...args: any[]) {
              const [node, targets, clip] = args
              const probe: any = { painterStagesEnabled: this.painterStagesEnabled(), managed: this.driver.managed,
                byteTentPolicyEnabled: this.driver.byteTentEnabled?.(), integratedBlur: this.scene.integratedBlur,
                imageMips: this.imageMips, imageAtlas: this.imageAtlas, filterSourceSupported: this.filterSourceSupported(node),
                clip: clip?.map((surface: any) => ({ rect: surface.rect, binaryCoverage: surface.texture.binaryCoverage === true })),
                targets: targets.map((surface: any) => ({ rect: surface.rect, compact: !!surface.logicalBounds })),
                hasShadowCertificate: !!node.shadowOutputBox, children: node.children.length,
                completed: false, admitted: false }
              if (byteShadowProbes.length < 16) byteShadowProbes.push(probe)
              try { const value = await originalByteShadow.apply(this, args); probe.admitted = value !== undefined; probe.completed = true; return value }
              catch (error) { probe.error = String(error); throw error }
            }
          if (payload.manifest.diagnostics) {
            const renderer = gpu as any, originalRun = renderer.run
            const originalAcquire = renderer.acquire, originalBudgetError = renderer.budgetError
            renderer.acquire = function (...args: any[]) {
              const previous = this.__painterAcquireContext
              this.__painterAcquireContext = { output: args[0], binary: !!args[1] }
              try { return originalAcquire.apply(this, args) }
              finally { this.__painterAcquireContext = previous }
            }
            renderer.budgetError = function (...args: any[]) {
              const error = originalBudgetError.apply(this, args)
              if (error?.budgetDiagnostic && !error.allocationTrace) {
                const texture = (t: any) => ({ width: t.width, height: t.height, bytes: t.bytes,
                  aliases: this.aliases.get(t) || 0, uniformColor: t.uniformColor === true,
                  transparentZero: t.transparentZero === true })
                const context = this.__painterRunContext, node = scene.nodes[this.activeNode]
                const trace = { allocationEntry: this.__painterAcquireContext ? 'acquire' : 'budgetError',
                  ...this.__painterAcquireContext, mode: context?.mode, activeNode: this.activeNode,
                  bundleStack: [...this.__painterBundleStack],
                  node: node && { rect: node.rect, size: node.size, children: node.children.length,
                    fills: node.fills.map((p: any) => ({ kind: p.kind, opacity: p.opacity, blend: p.blend })),
                    effects: node.effects.map((e: any) => ({ kind: e.kind, radius: e.radius })),
                    childrenInputBox: node.childrenInputBox, postCompositeBox: node.postCompositeBox },
                  busy: [...this.busy].map(texture).sort((a: any,b: any)=>b.bytes-a.bytes).slice(0,24),
                  free: [...this.free.values()].flat().map(texture).sort((a: any,b: any)=>b.bytes-a.bytes).slice(0,24),
                  surfaceBytes: this.bytes, workingBytes: this.workingBytes, budgetBytes: this.frameBudget,
                  work: { encodedPassPixels: this.passPixels, drawCalls: this.driver.drawCalls,
                    imageXTableBuilds: this.imageXTableBuilds, wholeFilterAxes: this.wholeFilterAxes } }
                this.__painterAllocationTrace = trace
                Object.defineProperty(error, 'allocationTrace', { value: trace })
              }
              return error
            }
            const originalMaterialize = renderer.materializePainterTargets, originalBundle = renderer.drawBundle
            renderer.__painterBundleStack = []
            renderer.drawBundle = async function (...args: any[]) {
              this.__painterBundleStack.push({ parent: this.activeNode, children: args[0]?.length })
              try { return await originalBundle.apply(this, args) }
              finally { this.__painterBundleStack.pop() }
            }
            renderer.materializePainterTargets = async function (targets: any[]) {
              try { return await originalMaterialize.call(this, targets) }
              catch (error) {
                if ((error as any)?.budgetDiagnostic && !(error as any).allocationTrace) {
                  const texture = (t: any) => ({ width: t.width, height: t.height, bytes: t.bytes,
                    aliases: this.aliases.get(t) || 0, uniformColor: t.uniformColor === true,
                    transparentZero: t.transparentZero === true })
                  const trace = { allocationEntry: 'materializePainterTargets', activeNode: this.activeNode,
                    bundleStack: [...this.__painterBundleStack],
                    targets: targets.map(s => ({ rect: s.rect, logicalBounds: s.logicalBounds,
                      compactMaxAbs: s.compactMaxAbs, texture: texture(s.texture) })),
                    busy: [...this.busy].map(texture).sort((a: any,b: any)=>b.bytes-a.bytes).slice(0,24),
                    free: [...this.free.values()].flat().map(texture).sort((a: any,b: any)=>b.bytes-a.bytes).slice(0,24) }
                  this.__painterAllocationTrace = trace
                  Object.defineProperty(error, 'allocationTrace', { value: trace })
                }
                throw error
              }
            }
            // Recovery may abandon an allocation failure and repeat the whole
            // graph. Retain each attempt separately: a prior failed run trace
            // must never be mislabeled as the terminal error of its successor.
            const originalAttempt = renderer.renderAttempt
            renderer.__painterAttempts = []
            renderer.renderAttempt = async function (...args: any[]) {
              this.__painterAllocationTrace = undefined
              const attempt = { index: this.__painterAttempts.length, prefixAllowed: this.prefixAllowed,
                completed: false } as any
              this.__painterAttempts.push(attempt)
              try { const value = await originalAttempt.apply(this, args); attempt.completed = true; return value }
              catch (error) {
                attempt.error = String(error); attempt.budgetDiagnostic = (error as any)?.budgetDiagnostic
                attempt.allocationTrace = this.__painterAllocationTrace
                throw error
              }
            }
            renderer.run = function (...args: any[]) {
              const previous = this.__painterRunContext
              this.__painterRunContext = { mode: args[0], output: args[1] }
              try { return originalRun.apply(this, args) }
              catch (error) {
                if ((error as any)?.budgetDiagnostic && !(error as any).allocationTrace) {
                  const texture = (t: any) => ({ width: t.width, height: t.height, bytes: t.bytes,
                    aliases: this.aliases.get(t) || 0, uniformColor: t.uniformColor === true, scalarCoverage: t.scalarCoverage === true })
                  const id = this.activeNode, node = scene.nodes[id]
                  const trace = {
                    mode: args[0], output: args[1], inputs: (args[2] || []).map((s: any) => ({ rect: s.rect, texture: texture(s.texture) })),
                    activeNode: id, authoredKind: payload.document.nodes[id]?.kind,
                    node: node && { rect: node.rect, size: node.size, children: node.children.length,
                      fills: node.fills.map((p: any) => ({ kind: p.kind, opacity: p.opacity, blend: p.blend })),
                      effects: node.effects.map((e: any) => ({ kind: e.kind, radius: e.radius })),
                      childrenInputBox: node.childrenInputBox, postCompositeBox: node.postCompositeBox },
                    busy: [...this.busy].map(texture).sort((a: any, b: any) => b.bytes - a.bytes).slice(0, 24),
                    free: [...this.free.values()].flat().map(texture).sort((a: any, b: any) => b.bytes - a.bytes).slice(0, 24),
                    workingBytes: this.bytes, budgetBytes: this.frameBudget,
                    work: { encodedPassPixels: this.passPixels, drawCalls: this.driver.drawCalls,
                      imageXTableBuilds: this.imageXTableBuilds, imageXTablePixels: this.imageXTablePixels,
                      imageXTableBytes: this.imageXTableBytes, imageXTablePrograms: this.imageXTablePrograms,
                      wholeFilterAxes: this.wholeFilterAxes, fieldBuilds: this.fieldBuilds, fieldBuildMs: this.fieldBuildMs,
                      maskRasterizations: this.maskRasterizations, backdropReads: this.backdropReads },
                  }
                  this.__painterAllocationTrace = trace
                  Object.defineProperty(error, 'allocationTrace', { value: trace })
                }
                throw error
              } finally { this.__painterRunContext = previous }
            }
          }
          stage = 'actual-render-readback'
          const actual = await gpu.render(scene, !payload.manifest.presentOnly, payload.manifest.presentOnly)
          let values: Float32Array | Uint8Array | undefined = actual.linear || actual.rgba
          if (payload.manifest.presentOnly) {
            if (!actual.bitmap) throw Error('Actual presented GPU bitmap missing')
            try {
              const canvas = new OffscreenCanvas(actual.bitmap.width, actual.bitmap.height), context = canvas.getContext('2d')!
              context.drawImage(actual.bitmap, 0, 0)
              values = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data)
              await (globalThis as any).painterGpuPixels({ index: requestIndex, rgba: [...values] })
            } finally { actual.bitmap.close() }
          }
          if (actual.backend !== 'webgpu' || gpu.driver.lost || !values) throw Error('Actual WebGPU readback missing')
          if (values.length !== (scene.output?.w ?? scene.width) * (scene.output?.h ?? scene.height) * 4) throw Error('Readback extent mismatch')
          if (!payload.manifest.presentOnly && payload.manifest.saveReadback) {
            if (values.length > 4_000_000) throw Error('Private oracle readback evidence exceeds its explicit cap')
            await (globalThis as any).painterGpuPixels({ index: requestIndex,
              format: values instanceof Float32Array ? 'rgba32float-raw-words' : 'rgba8unorm',
              ...(values instanceof Float32Array ? { words: [...new Uint32Array(values.buffer, values.byteOffset, values.length)] }
                : { rgba: [...values] }) })
          }
          let nonfinite = 0; for (const value of values) if (!Number.isFinite(value)) nonfinite++
          if (nonfinite) throw Error('Nonfinite GPU output')
          const sourcePasses = gpu.driver.stats?.().displayImageSourcePasses ?? 0
          if (payload.manifest.imageSourceCandidate && !(typeof sourcePasses === 'number' && sourcePasses > 0))
            throw Error('Requested display image-source candidate did not actually run')
          if (payload.manifest.imageStreamControl === 'required' && imageStreamHits < 1)
            throw Error('Required production image stream did not actually run')
          if (payload.manifest.requireByteTent && !((gpu.driver.stats?.().byteTentAlphaPasses ?? 0) > 0))
            throw Error('Required production byte tent did not actually run')
          if (payload.manifest.displayTentRadiusCandidate && !((actual as any).displayTentRadiusPasses > 0))
            throw Error('Required display-radius candidate did not actually change an encoded filter axis')
          if (payload.manifest.requireBackdropBands && backdropBandHits < 1)
            throw Error('Required production backdrop-band operator did not actually complete')
          records.push({ requestIndex, completed: true, elapsedMs: performance.now() - started,
            sceneSummary, renderWork: Object.fromEntries(['graphMs','finishMs','checkpointMs','passPixels','drawCalls','commandSubmissions',
              'imageXTableBuilds','imageXTablePixels','imageXTableBytes','imageXTablePrograms','materialFieldBuildMs',
              'maskRasterizations','backdropReads','opaqueTentPasses','wholeFilterAxes','textureBytes','workingBudgetBytes']
              .map(key => [key, (actual as any)[key]])),
            displayTentRadiusPasses: (actual as any).displayTentRadiusPasses ?? 0,
            displayTentRadiusPixels: (actual as any).displayTentRadiusPixels ?? 0,
            displayImageSourcePasses: sourcePasses,
            imageStreamHits,
            backdropBandHits, backdropBandProbes,
            byteShadowProbes,
            attempts: (gpu as any).__painterAttempts,
            pixelFormat: payload.manifest.presentOnly ? 'presented-rgba8' : values instanceof Float32Array ? 'readback-rgba32float' : 'readback-rgba8',
            extentPixels: scene.extent.w * scene.extent.h, outputPixels: values.length / 4, nonfinite,
            nativeSceneSha256: await digest(new TextEncoder().encode(native)),
            outputSha256: await digest(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)),
            peakTextureBytes: actual.peakTextureBytes, stats: gpu.driver.stats?.() })
        } catch (error) {
          records.push({ requestIndex, completed: false, stage, elapsedMs: performance.now() - started,
            sceneSummary,
            error: String(error), errorStack: error instanceof Error ? error.stack : undefined,
            allocationTrace: (error as any)?.allocationTrace || (gpu as any)?.__painterAllocationTrace,
            attempts: (gpu as any)?.__painterAttempts,
            byteShadowProbes: (gpu as any)?.__painterByteShadowProbes,
            backdropBandProbes: (gpu as any)?.__painterBackdropBandProbes,
            budgetDiagnostic: (error as any)?.budgetDiagnostic, stats: gpu?.driver.stats?.() })
        } finally { gpu?.dispose() }
      }
    } finally {
      engine.free(); diagnosticApi.setGpuDiagnosticSink(undefined); diagnosticApi.setGpuDiagnosticsDetail(false)
    }
    return { gpuExecuted: true, allCompleted: records.every(row => row.completed), records, diagnosticEvents, diagnosticsDropped }
    }, { document, requests, manifest, diagnosticsModulePath: resolve(project, '../design-desktop/src/render-terminal-diagnostics.mjs') })
  })
  await proof.write('gpu-result.json', result)
  // Execution completion remains separate from pixel/experience acceptance.
  // Preserve the actual refusal as a failed run, not a successful diagnostic.
  if (!result.allCompleted) throw Error('Actual regional GPU execution refused one or more supplied requests')
  return { ...manifest, ...result }
})
