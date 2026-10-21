/** Read-only exploration of the original four-plane renderer at an explicit
 * working-set budget. Inputs stay external; no authored fixture or image is
 * copied into source control. This does not exercise real camera gestures. */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { project, runProof, sha256 } from '../../frontend/design-client/scripts/exact-prefix-proof-utils.ts'
import { validGpuWorkingBudgetMiB } from '../../frontend/design-client/src/kernel/render-policy.ts'

const here = dirname(fileURLToPath(import.meta.url))
const args = new Map(), flags = new Set()
for (const arg of process.argv.slice(2)) {
  if (['--help', '--prepare-only', '--raw-probe'].includes(arg)) {
    if (flags.has(arg)) throw Error(`Repeated flag: ${arg}`)
    flags.add(arg); continue
  }
  const match = /^--(scene|document|budget-mib|samples|output)=(.+)$/.exec(arg)
  if (!match || args.has(match[1])) throw Error(`Unknown or repeated argument: ${arg}`)
  args.set(match[1], match[2])
}
if (flags.has('--help')) {
  console.log('bun testing/verification-sharp-sequential-20261021/probe-original-whole-viewport.mjs --document=/absolute/fixture-document.json [--scene=/absolute/capture-scene.json] [--budget-mib=4096] [--samples=1|2] [--output=/absolute/new-directory] [--raw-probe] [--prepare-only]')
  console.log('Defaults: saved zoom-100-capture-scene.json; DESIGN_117_DOCUMENT or adjacent fixture-document.json; one warm frame and two observations. --raw-probe adds a separate untimed target-read render after observations. No limits or shaders are relaxed.')
  process.exit(0)
}
const scenePath = resolve(args.get('scene') || process.env.DESIGN_117_SCENE || join(here, 'zoom-100-capture-scene.json'))
const documentPath = resolve(args.get('document') || process.env.DESIGN_117_DOCUMENT || join(here, 'fixture-document.json'))
const budgetText = args.get('budget-mib') || process.env.DESIGN_GPU_WORKING_BUDGET_MIB || '4096'
if (!/^[1-9][0-9]*$/.test(budgetText) || !validGpuWorkingBudgetMiB(Number(budgetText))) throw Error('Budget must be a decimal integer from 256 to 4096 MiB')
const budgetMiB = Number(budgetText), observations = Number(args.get('samples') || '2')
if (![1, 2].includes(observations) || !['1', '2'].includes(args.get('samples') || '2')) throw Error('--samples must be 1 or 2')
if (args.has('output')) process.env.DESIGN_TEST_OUTPUT = resolve(args.get('output'))
// Timing the existing wait counters changes no arithmetic or GPU timestamp
// instrumentation. It is explicitly recorded in the probe manifest.
process.env.VITE_DESIGN_QUEUE_WAIT_TIMING = '1'

await runProof('futureox-original-whole-viewport', [scenePath, documentPath], async proof => {
  const sceneBytes = await readFile(scenePath), documentBytes = await readFile(documentPath)
  const scene = JSON.parse(sceneBytes.toString()), document = JSON.parse(documentBytes.toString())
  const wasmBytes = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  if (scene.floatCompositing !== true || scene.coherentSamples !== true || scene.resolve || scene.presentation ||
      scene.softwareRaster || !scene.nodes || !Array.isArray(scene.roots)) throw Error('Expected an original managed coherent native capture scene')
  if (!document.nodes || !document.pages) throw Error('Expected the matching authored fixture document')
  const visibleEffects = {}, imageUris = new Set(), documentImageUris = new Set()
  for (const node of Object.values(document.nodes))
    for (const paint of [...(node.fills || []), ...(node.strokes || []).map(stroke => stroke.paint)])
      if (paint?.kind === 'image' && paint.image) documentImageUris.add(paint.image)
  for (const node of Object.values(scene.nodes)) {
    for (const effect of node.effects) if (effect.visible) visibleEffects[effect.kind] = (visibleEffects[effect.kind] || 0) + 1
    for (const paint of [...node.fills, ...node.strokes.map(stroke => stroke.paint)])
      if (paint.kind === 'image' && paint.image) imageUris.add(paint.image)
  }
  if ([...imageUris].some(uri => !documentImageUris.has(uri))) throw Error('Saved scene image sources do not match the authored fixture')
  const manifest = {
    sceneSha256: sha256(sceneBytes), documentSha256: sha256(documentBytes), wasmSha256: sha256(wasmBytes),
    budgetMiB, budgetBytes: budgetMiB * 1024 * 1024, warmFrames: 1, observedFrames: observations,
    output: scene.output || { x: 0, y: 0, w: scene.width, h: scene.height }, extent: scene.extent,
    nativeView: scene.view, compiledNodes: Object.keys(scene.nodes).length, visibleEffects, imageSources: imageUris.size,
    candidateFlags: { sequentialDisplay: false, displayMaterialSource: false, displayImageSource: false,
      displayFilters: false, displayMath: false }, queueWaitTiming: true, separateRawProbe: flags.has('--raw-probe'),
    scope: 'Original four-plane actual GPU feasibility at a configured admission ceiling. No real gestures, no latency/FPS acceptance, no preallocation or raised per-resource limits. Extra queue drains and optional readSurface are recorded outside observed render wall times.',
  }
  await proof.write('probe-manifest.json', manifest)
  if (proof.prepareOnly) return { ...manifest, scope: 'Input inspection and hashes only; neither WASM execution nor GPU ran.' }
  let progress = 0
  return proof.browser(async page => {
    await page.exposeFunction('originalWholeViewportProgress', value => proof.write(`probe-progress-${String(++progress).padStart(2, '0')}.json`, value))
    return page.evaluate(async ({ source, document, manifest }) => {
      const { initializeKernelModule } = await import('/src/kernel/module.ts')
      const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
      const { createGpu } = await import('/src/kernel/gpu/factory.ts')
      const started = performance.now(); await initializeKernelModule()
      const kernel = new VectorEngine(); kernel.load_document(JSON.stringify(document))
      const initializationMs = performance.now() - started
      const scene = { ...source, sequentialDisplay: false, displayMaterialSource: false, displayImageSource: false,
        displayFilters: false, displayFilterRadiusLimit: undefined }
      const identity = JSON.stringify(source), images = new Map(), rows = []
      let renderer
      const digest = async values => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', values)))
        .map(value => value.toString(16).padStart(2, '0')).join('')
      const loader = (uri, byte = false, level = 0) => {
        if (level !== 0) throw Error('Original probe did not enable image mips')
        const key = JSON.stringify([uri, byte]); let image = images.get(key)
        if (!image) {
          const [width, height] = JSON.parse(kernel.image_info(uri))
          image = { width, height, pixels: kernel.image_linear(uri), ...(byte ? { bytes: kernel.image_rgba8(uri) } : {}) }
          images.set(key, image)
        }
        return image
      }
      const waitDelta = (before, after) => ({
        timingEnabled: after.timingEnabled, submitCalls: after.submitCalls - before.submitCalls,
        started: after.started - before.started, completed: after.completed - before.completed,
        rejected: after.rejected - before.rejected, cpuWaitMs: after.cpuWaitMs - before.cpuWaitMs,
        reasons: Object.fromEntries(Object.keys(after.reasons).map(reason => [reason, {
          started: after.reasons[reason].started - before.reasons[reason].started,
          cpuWaitMs: after.reasons[reason].cpuWaitMs - before.reasons[reason].cpuWaitMs,
        }])),
      })
      try {
        const createStart = performance.now()
        renderer = await createGpu('webgpu', true, false, scene.colorManagement, loader, false, true, false, false, false, manifest.budgetMiB)
        const createGpuMs = performance.now() - createStart, driver = renderer.driver
        if (driver.displayMath || renderer.memoryPolicy().workingBudgetBytes !== manifest.budgetBytes)
          throw Error('Actual renderer did not retain the requested original arithmetic/budget')
        for (let frame = 0; frame <= manifest.observedFrames; frame++) {
          const phase = frame === 0 ? 'warm' : 'observation'
          await window.originalWholeViewportProgress({ phase, frame, status: 'starting', budgetBytes: manifest.budgetBytes })
          const before = driver.stats(), start = performance.now()
          const result = await renderer.render(scene, false, true)
          const renderWallMs = performance.now() - start, after = driver.stats()
          result.bitmap?.close(); if (result.gpuTile) driver.releasePresented?.([result.gpuTile])
          // A deliberately separate completion probe ensures each subsequent
          // frame starts after earlier GPU work. Its wait is not render time,
          // driver-accounted wait time, or product interaction latency.
          const drainStart = performance.now(); await driver.device.queue.onSubmittedWorkDone()
          const postRenderCompletionProbeMs = performance.now() - drainStart
          if (JSON.stringify(source) !== identity || scene.coherentSamples !== true || renderer.memoryPolicy().sequentialDisplayFrames)
            throw Error('The original scene or sample route changed during exploration')
          const row = { phase, frame, renderWallMs, graphMs: result.graphMs, finishMs: result.finishMs,
            checkpointMs: result.checkpointMs, postRenderCompletionProbeMs,
            queueWaits: waitDelta(before.queueWaits, after.queueWaits), drawCalls: result.drawCalls,
            commandSubmissions: result.commandSubmissions, passPixels: result.passPixels,
            peakTextureBytes: result.peakTextureBytes, workingTextureBytes: result.workingTextureBytes,
            workingBudgetBytes: result.workingBudgetBytes, finishTransientBytes: result.finishTransientBytes,
            driverTextureBytes: after.textureBytes, driverScratchBytes: after.scratchBytes,
            sourcePlaneFormat: driver.managed ? 'rgba32float' : 'rgba8unorm', adapter: after.adapter,
            rasterReadbackBytes: after.rasterReadbackBytes - before.rasterReadbackBytes }
          rows.push(row); await window.originalWholeViewportProgress({ status: 'completed', ...row })
        }
        let rawProbe = null
        if (manifest.separateRawProbe) {
          const originalFinish = driver.finish.bind(driver); let observed = false
          driver.finish = async (...args) => {
            const start = performance.now(), raw = await driver.readSurface(args[0])
            let nonfinite = 0; for (const value of raw) if (!Number.isFinite(value)) nonfinite++
            rawProbe = { readSurfaceMs: performance.now() - start, bytes: raw.byteLength,
              sourceRect: args[1], components: raw.length, nonfinite,
              sha256: await digest(new Float32Array(raw).buffer), separateFromObservedFrames: true }
            observed = true
            return originalFinish(...args)
          }
          const probeStart = performance.now()
          try {
            const result = await renderer.render(scene, false, true)
            result.bitmap?.close(); if (result.gpuTile) driver.releasePresented?.([result.gpuTile])
          } finally { driver.finish = originalFinish }
          if (!observed) throw Error('Requested separate raw probe did not observe an actual target')
          rawProbe.renderWallIncludingReadbackMs = performance.now() - probeStart
          await window.originalWholeViewportProgress({ phase: 'separate-raw-probe', status: 'completed', ...rawProbe })
        }
        return { ...manifest, initializationMs, createGpuMs, adapter: driver.stats().adapter, rows, rawProbe,
          scope: 'Original actual GPU four-plane feasibility only. Measured render walls include normal driver waits; post-render drains and optional raw probes are separate. No gesture, visual sharpness, exclusive GPU shader duration or physical-FPS claim.' }
      } catch (error) {
        await window.originalWholeViewportProgress({ status: 'failed', completedFrames: rows.length,
          error: String(error), budgetBytes: manifest.budgetBytes, memoryPolicy: renderer?.memoryPolicy(), driverStats: renderer?.driver.stats() })
        throw error
      } finally { renderer?.dispose(); kernel.free() }
    }, { source: scene, document, manifest })
  })
})
