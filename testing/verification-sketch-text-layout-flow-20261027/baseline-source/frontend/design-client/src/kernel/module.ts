import { documentCapacity, pinDocumentCapacity } from '../document-capacity'
import initKernel, { validate_document_json, configure_document_capacity } from '../generated/design-kernel/design_kernel'
import { InitializationGate, readKernelAsset } from './initialization'

let ready = false
let resourceIdentity: Readonly<{ wasmSha256: string; bundled: boolean }> | undefined
// The generated initializer owns an irreversible singleton. A timed-out or
// failed installation may still publish it later, so a retry's input bytes
// cannot certify that singleton. Preserve ordinary initialization behavior,
// but permanently disable off-thread proof in this ambiguous realm.
let installationIdentityUncertain = false
/** Identity of the successfully committed runtime bytes, not a build label. */
export function kernelModuleResourceIdentity() { return ready && !installationIdentityUncertain ? resourceIdentity : undefined }
/** Initialization-only fingerprint. Hash the already-owned bytes, without a
 * second explicit asset copy. Unavailable WebCrypto leaves identity unknown;
 * ordinary initialization remains usable, but off-thread adoption is disabled. */
export async function kernelResourceSha256(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const hash = await globalThis.crypto?.subtle?.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    return hash ? Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') : undefined
  } catch { return undefined }
}
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
    const [module, wasmSha256] = await Promise.all([
      WebAssembly.compile(new Uint8Array(bytes).buffer), kernelResourceSha256(bytes),
    ])
    lease.assertCurrent()
    // Chromium disallows synchronous WebAssembly.Instance on the main thread
    // for modules above 8 MiB, so instantiation must stay asynchronous; the
    // generated initializer may publish after our lease expires. Unlike a
    // compile/hash timeout, that makes every later input-based proof uncertain.
    const invalidateInstallation = () => { installationIdentityUncertain = true }
    lease.signal.addEventListener('abort', invalidateInstallation, { once: true })
    let committed = false
    try {
      await initKernel({ module_or_path: module })
      lease.assertCurrent()
      configure_document_capacity(capacity.memoryBytes)
      lease.commit(() => {
        resourceIdentity = !installationIdentityUncertain && wasmSha256
          ? Object.freeze({ wasmSha256, bundled: wasm === undefined }) : undefined
        ready = true
      })
      committed = true
    } finally {
      // Successful InitializationGate completion also aborts its signal. Remove
      // the observer before that cleanup, without treating success as uncertain.
      lease.signal.removeEventListener('abort', invalidateInstallation)
      if (!committed) invalidateInstallation()
    }
  })
}

export function validateKernelDocument(json: string): void {
  if (!ready) throw new Error('文档校验内核尚未就绪；请等待初始化后重试')
  validate_document_json(json)
}
