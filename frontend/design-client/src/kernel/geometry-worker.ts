import { webPath } from '../web-path'
// Editing and rendering share the same Rust geometry implementation.
import initialize, { geometry_json } from '../generated/design-kernel/design_kernel'
const moduleReady = initialize({ module_or_path: webPath('/kernel/design_kernel_bg.wasm') })
self.onmessage = async (e) => {
  try {
    await moduleReady
    const results = JSON.parse(geometry_json(JSON.stringify(e.data)))
    self.postMessage({ results })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
