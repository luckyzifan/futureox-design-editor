// Versioned content-free provenance. Hashes identify inputs, not GPU correctness
// or reproducible output. No URLs, paths, environment values or document data.
export const FAILURE_DICTIONARY_VERSION = 1
export const DIAGNOSTIC_PRODUCER_VERSION = 1
const digestFields = ['producerSourceSha256', 'producerWasmInputSha256', 'failureDictionarySha256']
export function sanitizeProducerIdentity(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const name of digestFields) {
    const digest = value[name]
    if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) out[name] = digest
  }
  if (typeof value.producerCommit === 'string' && /^[0-9a-f]{40}$/.test(value.producerCommit)) out.producerCommit = value.producerCommit
  for (const [name, max] of [['producerIdentityStatus', 2], ['producerCommitStatus', 1], ['producerBuildMode', 2]])
    if (Number.isInteger(value[name]) && value[name] >= 0 && value[name] <= max) out[name] = value[name]
  return out
}
// Vite substitutes this literal for both the renderer and its Worker bundles.
// Node hosts and other consumers explicitly report unavailable, never borrow a
// source checkout's identity and claim it proves which binary is running.
const injected = typeof __CORE_RENDER_DIAGNOSTIC_BUILD__ === 'undefined' ? undefined : __CORE_RENDER_DIAGNOSTIC_BUILD__
const identity = Object.freeze({ producerIdentityStatus: 0, producerCommitStatus: 0, ...sanitizeProducerIdentity(injected) })
export function producerIdentityFields() {
  return { diagnosticProducerVersion: DIAGNOSTIC_PRODUCER_VERSION, failureDictionaryVersion: FAILURE_DICTIONARY_VERSION, ...identity }
}
