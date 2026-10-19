import initialize, { VectorEngine } from '../generated/design-kernel/design_kernel'
import { renderCpuFrame } from './cpu-frame'
import type { PreparationMethod } from './preparation-channel'
import { loadKernelResources } from './kernel-resources'
import { PreparationSnapshots } from './preparation-snapshot'

const allowed = new Set<PreparationMethod>(['warm_resources', 'initialize', 'load_document', 'apply_document_patch_with_damage', 'apply_interaction_transforms',
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
let attached = false
self.onmessage = event => {
  if (attached || !(event.data.port instanceof MessagePort)) return
  attached = true
  const port = event.data.port as MessagePort
  let queue = Promise.resolve()
  port.onmessage = event => {
    const { id, lane, method, args } = event.data as { id: number; lane: string; method: PreparationMethod; args: unknown[] }
    queue = queue.then(async () => {
      try {
        if (!Number.isSafeInteger(id) || !allowed.has(method) || !Array.isArray(args)) throw Error('Invalid CPU preparation request')
        if (method === 'apply_interaction_transforms' && lane !== 'interaction') throw Error('Transform-only updates require the interaction lane')
        if (method === 'warm_resources') {
          await resources()
          port.postMessage({ id })
          return
        }
        // A matching canvas snapshot already owns the default font. Do not
        // allocate/hash it in a throwaway interaction engine before cloning.
        if (method === 'initialize' && lane === 'interaction' && !engines.has(lane)) {
          await resources(); snapshots.initialize(lane, args[0] === true)
          port.postMessage({ id, settings: 'null' }); return
        }
        let kernel = engines.get(lane), value: unknown, documentFork = false
        if (method === 'load_document' && import.meta.env.VITE_DESIGN_DOCUMENT_FORK !== '0' && snapshots.canFork(lane, args[0] as string)) {
          const fork = engines.get('canvas')?.fork_static_render_engine()
          if (fork) { const previous = kernel; kernel = fork; engines.set(lane, fork); previous?.free(); documentFork = true }
        }
        kernel ??= await engine(lane)
        if (method === 'load_document') snapshots.invalidate(lane)
        if (method === 'apply_document_patch_with_damage' || method === 'apply_interaction_transforms') snapshots.invalidate(lane)
        if (method === 'initialize') { kernel.set_image_mips(args[0] === true); snapshots.initialize(lane, args[0] === true) }
        else if (method === 'load_document' && documentFork) value = undefined
        else if (method === 'render_cpu_frame') value = renderCpuFrame(kernel, args[0] as string, args[1] as Parameters<typeof renderCpuFrame>[2])
        else value = (kernel[method] as (...args: any[]) => unknown).apply(kernel, args)
        if (method === 'load_document') snapshots.loaded(lane, args[0] as string)
        const settings = method === 'initialize' || method === 'load_document' || method === 'apply_document_patch_with_damage'
          ? kernel.color_settings() : undefined
        const transfer = value instanceof Uint8Array || value instanceof Float32Array ? [value.buffer] : []
        const compileStats=import.meta.env.DEV&&(method==='compile_gpu_packet'||method==='compile_gpu_scene_update')
          ?JSON.parse(kernel.gpu_compile_cache_stats()):undefined
        port.postMessage({ id, value, settings, documentFork, compileStats }, transfer)
      } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
    })
  }
  port.start()
}
