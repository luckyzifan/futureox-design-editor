/** Resource admission, never document metadata or an automation permission.
 * The 16x reserve is a conservative heuristic, not an application RSS promise.
 * The pinned budget is shared by the main thread, preparation and rendering.
 */
export const DOCUMENT_REPRESENTATION_RESERVE = 16
export const WASM_ADDRESS_BYTES = 2 ** 32
export const UNKNOWN_RUNTIME_MEMORY_BYTES = 512 * 1024 * 1024
export type DocumentCapacity = Readonly<{ memoryBytes: number; documentBytes: number; nodeCount: number; pageCount: number; source: string }>
let pinned: DocumentCapacity | undefined
function checkedMemory(value: number) {
  if (!Number.isSafeInteger(value) || value < DOCUMENT_REPRESENTATION_RESERVE || value > WASM_ADDRESS_BYTES)
    throw new Error('Invalid trusted document memory budget')
  return value
}
export function capacityFromMemory(memoryBytes: number, source = 'trusted-host'): DocumentCapacity {
  checkedMemory(memoryBytes)
  return Object.freeze({ memoryBytes, documentBytes: Math.floor(memoryBytes / DOCUMENT_REPRESENTATION_RESERVE),
    nodeCount: Math.floor(memoryBytes / 4096), pageCount: Math.floor(memoryBytes / 1024), source })
}
/** Bootstrap-only. Worker messages carry the already pinned host policy, never
 * document properties. Later calls cannot increase or change an active policy. */
export function pinDocumentCapacity(memoryBytes: number, source = 'trusted-host') {
  const next = capacityFromMemory(memoryBytes, source)
  if (pinned && pinned.memoryBytes !== next.memoryBytes) throw new Error('Document capacity is already pinned for this process')
  return pinned ??= next
}
export function documentCapacity(): DocumentCapacity {
  if (pinned) return pinned
  const bridge = typeof window === 'undefined' ? undefined : window.coreDesktop
  if (bridge?.documentCapacity) return pinDocumentCapacity(bridge.documentCapacity.memoryBytes, 'desktop-startup-resource-budget')
  // Node is used by actual WASM/Editor tests and other trusted local hosts.
  // No browser process shim or document-supplied object is consulted.
  if (typeof process !== 'undefined' && process.release?.name === 'node') {
    const override = process.env.CORE_DOCUMENT_MEMORY_BYTES
    if (override !== undefined) return pinDocumentCapacity(Number(override), 'trusted-launch')
    const available = process.availableMemory?.()
    if (Number.isSafeInteger(available) && available > 0)
      return pinDocumentCapacity(Math.max(16, Math.min(WASM_ADDRESS_BYTES, Math.floor(available / 2))), 'runtime-available-memory')
  }
  const hints: number[] = []
  const heap = (typeof performance === 'undefined' ? undefined : (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory?.jsHeapSizeLimit)
  if (heap && Number.isSafeInteger(heap) && heap > 0) hints.push(heap)
  const deviceGiB = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (deviceGiB && Number.isFinite(deviceGiB) && deviceGiB > 0) hints.push(Math.floor(deviceGiB * 1024 ** 3))
  if (hints.length) return pinDocumentCapacity(Math.max(16, Math.min(WASM_ADDRESS_BYTES, Math.floor(Math.min(...hints) / 2))), 'browser-reported-resource-headroom')
  // This is deliberately fail-safe, not a claim that wasm32 has 4 GiB free.
  return pinDocumentCapacity(UNKNOWN_RUNTIME_MEMORY_BYTES, 'unknown-runtime-conservative-fallback')
}
/** Exact UTF-8 count without allocating a second document-sized byte array. */
export function utf8Bytes(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}
export function assertDocumentBytes(bytes: number, policy = documentCapacity()) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > policy.documentBytes)
    throw new Error(`DOCUMENT_RESOURCE_LIMIT: ${bytes} serialized bytes exceed this session's ${policy.documentBytes}-byte document allowance (${policy.memoryBytes}-byte working-memory budget; ${DOCUMENT_REPRESENTATION_RESERVE}x heuristic reserve; ${policy.source})`)
}
export function assertDocumentJson(source: string) { assertDocumentBytes(utf8Bytes(source)) }
export function assertDocumentStructure(nodes: number, pages: number) {
  const policy = documentCapacity()
  if (!Number.isSafeInteger(nodes) || nodes < 0 || !Number.isSafeInteger(pages) || pages < 1 || pages > policy.pageCount || nodes > policy.nodeCount)
    throw new Error(`DOCUMENT_RESOURCE_LIMIT: document structure exceeds this session's memory allowance (${policy.nodeCount} nodes, ${policy.pageCount} pages; ${policy.source})`)
}
