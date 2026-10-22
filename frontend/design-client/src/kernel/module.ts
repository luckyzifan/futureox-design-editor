import { documentCapacity, pinDocumentCapacity } from '../document-capacity'
import initKernel, { validate_document_json, configure_document_capacity } from '../generated/design-kernel/design_kernel'
import { InitializationGate, readKernelAsset } from './initialization'

let ready = false
export function kernelModuleReady() { return ready }
const initialization = new InitializationGate()
const MAX_WASM_BYTES = 64 * 1024 * 1024

/** Module readiness is independent of fonts, VectorEngine and rendering. */
export function initializeKernelModule(wasm?: Uint8Array, memoryBytes?: number): Promise<void> {
  if (memoryBytes !== undefined) pinDocumentCapacity(memoryBytes)
  const capacity = documentCapacity()
  return initialization.run(async (lease) => {
    if (wasm && wasm.byteLength > MAX_WASM_BYTES) throw new Error('内核资源超过大小限制')
    const bytes = wasm ? wasm.slice() : await readKernelAsset('/kernel/design_kernel_bg.wasm', MAX_WASM_BYTES, lease.signal)
    lease.assertCurrent()
    // A fresh typed array owns an ArrayBuffer even when the caller supplied a
    // SharedArrayBuffer-backed view; compilation never reads caller-owned bytes.
    const module = await WebAssembly.compile(new Uint8Array(bytes).buffer)
    lease.assertCurrent()
    // Chromium disallows synchronous WebAssembly.Instance on the main thread
    // for modules above 8 MiB, so instantiation must stay asynchronous; the
    // generated initializer publishes its global instance and ignores a
    // second install, keeping publication single-shot.
    await initKernel({ module_or_path: module })
    configure_document_capacity(capacity.memoryBytes)
    lease.assertCurrent()
    lease.commit(() => {
      ready = true
    })
  })
}

export function validateKernelDocument(json: string): void {
  if (!ready) throw new Error('文档校验内核尚未就绪；请等待初始化后重试')
  validate_document_json(json)
}
