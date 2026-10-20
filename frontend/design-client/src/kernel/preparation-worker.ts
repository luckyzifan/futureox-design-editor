import initialize, { VectorEngine } from '../generated/design-kernel/design_kernel'
import { renderCpuFrame } from './cpu-frame'
import type { PreparationMethod } from './preparation-channel'
import { loadKernelResources } from './kernel-resources'
import { PreparationSnapshots } from './preparation-snapshot'
import { PreparationStates } from './preparation-state'

const allowed = new Set<PreparationMethod>(['preparation_capabilities_v1', 'derive_document_v1', 'warm_resources', 'initialize', 'load_document', 'apply_document_patch_with_damage', 'apply_interaction_transforms',
  'compile_gpu_scene_update', 'clear_gpu_scene_session', 'compile_gpu_packet', 'render_linear', 'render_png', 'render_color_png', 'render_region_png',
  'render_cpu_frame', 'stats', 'gpu_memory_breakdown'])
let initialized: Promise<Uint8Array> | undefined
const engines = new Map<string, VectorEngine>()
function resources() {
  initialized ??= loadKernelResources(() => initialize({ module_or_path: '/kernel/design_kernel_bg.wasm' }))
  return initialized
}
async function engine(lane: string) {
  if (lane !== 'canvas' && lane !== 'interaction') throw Error('Invalid CPU preparation lane')
  let result = engines.get(lane)
  if (result) return result
  const font = await resources()
  result = new VectorEngine()
  try { result.load_font(font); result.set_image_mips(snapshots.imageMips(lane)); engines.set(lane, result); return result }
  catch (error) { result.free(); throw error }
}
const snapshots = new PreparationSnapshots()
const states = new PreparationStates()
let attached = false
self.onmessage = event => {
  if (attached || !(event.data.port instanceof MessagePort)) return
  attached = true
  const port = event.data.port as MessagePort
  let queue = Promise.resolve()
  port.onmessage = event => {
    const { id, lane, method, args, diagnostics } = event.data as { id: number; lane: string; method: PreparationMethod; args: unknown[]; diagnostics?: unknown }
    const receivedAt = performance.now()
    const progress = (boundaryCode: number) => { const elapsed = performance.now() - receivedAt; if (diagnostics) port.postMessage({ id, progress: { backendCode: 1, boundaryCode, ...(elapsed <= 120000 ? { boundaryDurationMs: elapsed } : {}) } }) }
    progress(1)
    queue = queue.then(async () => {
      try {
        progress(7)
        if (!Number.isSafeInteger(id) || !allowed.has(method) || !Array.isArray(args)) throw Error('Invalid CPU preparation request')
        if (lane !== 'canvas' && lane !== 'interaction') throw Error('Invalid CPU preparation lane')
        if (method === 'preparation_capabilities_v1') {
          port.postMessage({ id, value: { protocol: 1, emptyDeltaDerivation: true } }); return
        }
        if (method === 'derive_document_v1') {
          const request = states.validateDerive(lane, args)
          if (snapshots.imageMips('canvas') !== snapshots.imageMips('interaction')) throw Error('RESOURCE_POLICY_MISMATCH')
          const candidate = engines.get('canvas')?.fork_static_render_engine()
          if (!candidate) throw Error('DERIVE_UNSUPPORTED_STATE')
          let settings: string
          try { settings = candidate.color_settings() } catch (error) { candidate.free(); throw error }
          // No await between validation, fork and atomic publication.
          const previous = engines.get(lane)
          engines.set(lane, candidate); snapshots.invalidate(lane)
          const stateReceipt = states.mint('interaction', request.baseReceipt)
          previous?.free()
          port.postMessage({ id, settings, stateReceipt, documentFork: true }); return
        }
        const mutation = ['initialize', 'load_document', 'apply_document_patch_with_damage', 'apply_interaction_transforms'].includes(method)
        const previousReceipt = mutation ? states.revoke(lane) : null
        if (method === 'apply_interaction_transforms' && lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
        if (method === 'warm_resources') {
          progress(2); await resources(); progress(3)
          port.postMessage({ id })
          return
        }
        // A matching canvas snapshot already owns the default font. Do not
        // allocate/hash it in a throwaway interaction engine before cloning.
        if (method === 'initialize' && lane === 'interaction' && !engines.has(lane)) {
          progress(2); await resources(); snapshots.initialize(lane, args[0] === true); progress(3)
          port.postMessage({ id, settings: 'null', stateReceipt: null }); return
        }
        let kernel = engines.get(lane), value: unknown, documentFork = false
        if (method === 'load_document' && import.meta.env.VITE_DESIGN_DOCUMENT_FORK !== '0' && snapshots.canFork(lane, args[0] as string)) {
          const fork = engines.get('canvas')?.fork_static_render_engine()
          if (fork) { const previous = kernel; kernel = fork; engines.set(lane, fork); previous?.free(); documentFork = true }
        }
        kernel ??= await engine(lane)
        if (method === 'load_document') snapshots.invalidate(lane)
        const commitSnapshot = method === 'apply_document_patch_with_damage' ? snapshots.beginPatch(lane, args[0] as string) : undefined
        if (method === 'apply_interaction_transforms') snapshots.invalidate(lane)
        progress(2)
        if (method === 'initialize') { kernel.set_image_mips(args[0] === true); snapshots.initialize(lane, args[0] === true) }
        else if (method === 'load_document' && documentFork) value = undefined
        else if (method === 'render_cpu_frame') value = renderCpuFrame(kernel, args[0] as string, args[1] as Parameters<typeof renderCpuFrame>[2])
        else value = (kernel[method] as (...args: any[]) => unknown).apply(kernel, args)
        progress(3)
        commitSnapshot?.()
        if (method === 'load_document') snapshots.loaded(lane, args[0] as string)
        const settings = method === 'initialize' || method === 'load_document' || method === 'apply_document_patch_with_damage'
          ? kernel.color_settings() : undefined
        const transfer = value instanceof Uint8Array || value instanceof Float32Array ? [value.buffer] : []
        const compileStats=import.meta.env.DEV&&(method==='compile_gpu_packet'||method==='compile_gpu_scene_update')
          ?JSON.parse(kernel.gpu_compile_cache_stats()):undefined
        const stateReceipt = mutation ? (method === 'load_document' || previousReceipt
          ? states.mint(lane, previousReceipt, method === 'load_document') : null) : undefined
        port.postMessage({ id, value, settings, documentFork, compileStats, ...(mutation ? { stateReceipt } : {}) }, transfer)
      } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
    })
  }
  port.start()
}
