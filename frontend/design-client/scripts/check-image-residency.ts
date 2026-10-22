/** Actual GPU A -> image-free B -> A -> idle -> A, with the production image
 * hydration loader and the same real document. The legacy control withholds
 * its private owner capability; neither control changes decoded image data.
 * Private requests, document, URI and pixels are never curated. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const documentPath = process.env.DESIGN_PAINTER_DOCUMENT, requestsPath = process.env.DESIGN_PAINTER_REQUESTS
if (!documentPath || !requestsPath) throw Error('Supply the actual document and exactly two explicit A/B requests')
if (process.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1') throw Error('Strict clamp-prefix gate is required')
const idleMs = Number(process.env.DESIGN_IMAGE_RESIDENCY_IDLE_MS || 5000)
const ownerSwaps = process.env.DESIGN_IMAGE_RESIDENCY_OWNER_SWAPS === '1'
const budget = Number(process.env.DESIGN_PAINTER_WORKING_MIB || 256)
if (!Number.isInteger(idleMs) || idleMs < 0 || idleMs > 120000 || !Number.isInteger(budget) || budget < 256 || budget > 4096)
  throw Error('Invalid bounded idle/budget policy')
await runProof('futureox-image-residency', [resolve(documentPath), resolve(requestsPath)], async proof => {
  const [doc, req, wasm, font] = await Promise.all([readFile(documentPath), readFile(requestsPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm')), readFile(join(project, 'public/fonts/NotoSansSC.ttf'))])
  const document = JSON.parse(doc.toString()), requests = JSON.parse(req.toString())
  if (!Array.isArray(requests) || requests.length !== 2) throw Error('Exactly two explicit A/B requests are required')
  const manifest = { documentSha256: sha256(doc), requestsSha256: sha256(req), wasmSha256: sha256(wasm),
    fontSha256: sha256(font), workingBudgetMiB: budget, idleMs, ownerSwaps,
    scope: 'Actual same-device real-document A/B/A/idle/A GPU presentation and immutable asset upload/hit counts. Not whole GUI tile reuse, all motion frames, physical FPS, clean latency or export acceptance.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return manifest
  const result = await proof.browser(async page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    const { managedSceneImageLoader } = await import('/src/kernel/scene-image-hydration.ts')
    const { DecodedImageCache, createDecodedImageOwner, decodedImageScope } = await import('/src/kernel/decoded-image-cache.ts')
    const { sceneIndex } = await import('/src/kernel/gpu/scene-index.ts')
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)))
      .map(value => value.toString(16).padStart(2, '0')).join('')
    const actualWasm = new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())
    const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
    if (await digest(actualWasm) !== payload.manifest.wasmSha256 || await digest(font) !== payload.manifest.fontSha256)
      throw Error('Actual WASM/font differs from bound inputs')
    const runs: any[] = []
    for (const candidate of [false, true]) {
      const engine = new VectorEngine(); let gpu: Awaited<ReturnType<typeof createGpu>> | undefined
      const records: any[] = [], ownerTransitions: any[] = []
      let ownerActive = true, currentRequest = { active: true }
      try {
        engine.load_font(font); engine.load_document(JSON.stringify(payload.document))
        const settings = engine.color_settings()
        let scope = decodedImageScope(createDecodedImageOwner(), settings), ownerTicket = { active: true }
        let context: any = { kernel: engine, settings, scope }
        const loader = managedSceneImageLoader(new DecodedImageCache(), () => context,
          { key: async () => undefined, read: async () => undefined, write: () => {} })
        let firstPixels: Uint8Array | undefined
        for (const [step, requestIndex] of [0, 1, 0, 0].entries()) {
          if (step === 3) await new Promise(resolve => setTimeout(resolve, payload.manifest.idleMs))
          currentRequest.active = false; currentRequest = { active: true }
          const capturedRequest = currentRequest, capturedOwner = ownerTicket
          context = { kernel: engine, settings, scope, current: () => ownerActive && capturedRequest.active,
            ...(candidate ? { ownerCurrent: () => ownerActive && capturedOwner.active } : {}) }
          const native = engine.compile_gpu(JSON.stringify({ ...payload.requests[requestIndex],
            gpuPainterSupport: true, gpuPainterCaptureReads: true }))
          const scene = JSON.parse(native), images = sceneIndex(scene).images.size
          if (step === 0 && images === 0 || requestIndex === 1 && images !== 0)
            throw Error('A must actually reference an image; B must actually be image-free')
          const pixels = (scene.output?.w ?? scene.width) * (scene.output?.h ?? scene.height)
          if (pixels > 1048576) throw Error('Presented diagnostic pixel capture exceeds one megapixel')
          if (!gpu) gpu = await createGpu('webgpu', true, false, scene.colorManagement, loader, false,
            !!(scene.colorManagement || scene.floatCompositing), false, false, false, payload.manifest.workingBudgetMiB)
          const started = performance.now(), actual = await gpu.render(scene, false, true)
          if (actual.backend !== 'webgpu' || !actual.bitmap) throw Error('Actual GPU presentation missing')
          let rgba: Uint8Array
          try {
            const canvas = new OffscreenCanvas(actual.bitmap.width, actual.bitmap.height), ctx = canvas.getContext('2d')!
            ctx.drawImage(actual.bitmap, 0, 0); rgba = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
          } finally { actual.bitmap.close() }
          let differentBytes = 0
          if (requestIndex === 0) {
            if (!firstPixels) firstPixels = rgba.slice()
            else {
              if (rgba.length !== firstPixels.length) throw Error('A revisit extent changed')
              for (let i = 0; i < rgba.length; i++) if (rgba[i] !== firstPixels[i]) differentBytes++
              if (differentBytes) throw Error('A revisit pixels changed')
            }
          }
          records.push({ step, requestIndex, referencedImages: images, presentedComponents: rgba.length,
            outputSha256: await digest(rgba), differentBytes, coldOrWarmDiagnosticMs: performance.now() - started,
            assetCounters: { ...(gpu as any).imageAssetCounters },
            residentImageTextures: (gpu as any).images.size, peakTextureBytes: actual.peakTextureBytes })
        }
        const first = records[0].assetCounters.uploads, last = records.at(-1).assetCounters.uploads
        if (candidate && (first < 1 || first !== last)) throw Error('Candidate re-uploaded an image during bounded same-owner revisit')
        if (!candidate && (!(last > first) || !(records.at(-1).assetCounters.legacyPrunes > 0)))
          throw Error('Legacy region-pruning control was not exercised; pressure eviction alone is not that control')
        if (candidate && payload.manifest.ownerSwaps) for (let transition = 0; transition < 2; transition++) {
          // A genuine fresh private hydration owner, as in reopen/document
          // replacement. The URI/data stay identical to expose stale lookup
          // authority without introducing a different pixel reference.
          ownerTicket.active = false; ownerTicket = { active: true }
          scope = decodedImageScope(createDecodedImageOwner(), settings)
          currentRequest.active = false; currentRequest = { active: true }
          const capturedRequest = currentRequest, capturedOwner = ownerTicket
          context = { kernel: engine, settings, scope, current: () => ownerActive && capturedRequest.active,
            ownerCurrent: () => ownerActive && capturedOwner.active }
          const scene = JSON.parse(engine.compile_gpu(JSON.stringify({ ...payload.requests[0],
            gpuPainterSupport: true, gpuPainterCaptureReads: true })))
          const counters = { ...(gpu as any).imageAssetCounters }, actual = await gpu!.render(scene, false, true)
          if (actual.backend !== 'webgpu' || !actual.bitmap) throw Error('Actual owner-transition GPU presentation missing')
          let rgba: Uint8Array
          try {
            const canvas = new OffscreenCanvas(actual.bitmap.width, actual.bitmap.height), ctx = canvas.getContext('2d')!
            ctx.drawImage(actual.bitmap, 0, 0); rgba = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
          } finally { actual.bitmap.close() }
          let differentBytes = 0
          if (!firstPixels || rgba.length !== firstPixels.length) throw Error('Owner-transition A reference missing')
          for (let i = 0; i < rgba.length; i++) if (rgba[i] !== firstPixels[i]) differentBytes++
          const after = { ...(gpu as any).imageAssetCounters }
          if (differentBytes || !(after.uploads > counters.uploads) || !(after.scopeRetiredTextures > counters.scopeRetiredTextures))
            throw Error('New owner failed pixel equality, fresh upload or prior-scope retirement')
          if ((gpu as any).retiredImageAssets.size !== 0) throw Error('Completed owner transition retained an unproved old image cohort')
          ownerTransitions.push({ transition, differentBytes, outputSha256: await digest(rgba),
            assetCounters: after, retiredImageAssets: (gpu as any).retiredImageAssets.size,
            submittedQueueWaits: gpu!.driver.stats?.().queueWaits })
        }
        runs.push({ candidate, completed: true, records, ownerTransitions })
      } catch (error) {
        runs.push({ candidate, completed: false, records, ownerTransitions, error: String(error), stack: error instanceof Error ? error.stack : undefined })
        return { status: 'failed', runs }
      } finally { ownerActive = false; currentRequest.active = false; gpu?.dispose(); engine.free() }
    }
    return { status: 'passed', runs }
  }, { document, requests, manifest }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error('Actual image residency execution/revisit refused; inspect retained evidence')
  return { ...manifest, ...result }
})
