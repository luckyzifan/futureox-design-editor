/** Inert FD metadata. This contract never grants tool, filesystem or network authority. */
export type FdCompatibility = {
  contractVersion: 1
  requiredCapabilities: string[]
  extensions: Record<string, unknown>
}
export const FD_EXTENSION_LIMITS = Object.freeze({ namespaces: 64, nameBytes: 128, bytes: 1024 * 1024, depth: 32, values: 100_000 })
const namespace = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/[a-z][a-z0-9._-]*$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function invalid(reason: string): never { throw new Error(`Invalid FD compatibility: ${reason}`) }
export function validateFdCompatibility(value: unknown): void {
  if (value === undefined || value === null) return
  if (!object(value) || value.contractVersion !== 1 || Object.keys(value).some(key => !['contractVersion', 'requiredCapabilities', 'extensions'].includes(key))) invalid('unsupported contract version or fields')
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length > FD_EXTENSION_LIMITS.namespaces) invalid('required capabilities must be a bounded array')
  if (!object(value.extensions) || Object.keys(value.extensions).length > FD_EXTENSION_LIMITS.namespaces) invalid('extensions must be a bounded namespaced map')
  for (const name of [...value.requiredCapabilities, ...Object.keys(value.extensions)]) {
    if (typeof name !== 'string' || name.length > FD_EXTENSION_LIMITS.nameBytes || !namespace.test(name)) invalid('invalid namespace')
  }
  // No optional extension semantics are implemented yet. Never guess required semantics.
  if (value.requiredCapabilities.length) invalid(`unsupported required capability: ${value.requiredCapabilities[0]}`)
  const pending: [unknown, number][] = [[value.extensions, 0]]
  const seen = new Set<object>(); let count = 0, cost = 128
  const utf8 = new TextEncoder()
  const textBytes = (text: string) => {
    if (text.length > FD_EXTENSION_LIMITS.bytes) invalid('byte budget exceeded')
    for (const char of text) { const point = char.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) invalid('invalid Unicode') }
    return utf8.encode(text).byteLength
  }
  while (pending.length) {
    const [item, depth] = pending.pop()!
    if (++count > FD_EXTENSION_LIMITS.values || depth > FD_EXTENSION_LIMITS.depth) invalid('structural budget exceeded')
    cost += 32 + (typeof item === 'string' ? textBytes(item) : 0)
    if (cost > FD_EXTENSION_LIMITS.bytes) invalid('byte budget exceeded')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid('non-finite number'); continue }
    if (typeof item !== 'object') invalid('only JSON values are allowed')
    if (Array.isArray(item) && (item.length + pending.length + count > FD_EXTENSION_LIMITS.values || Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) invalid('sparse, oversized or non-JSON array')
    if (seen.has(item)) invalid('cyclic or shared extension object'); seen.add(item)
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid('only plain JSON objects are allowed')
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('unsafe object key')
      if (!Array.isArray(item)) cost += textBytes(key)
      if (cost > FD_EXTENSION_LIMITS.bytes) invalid('byte budget exceeded')
      pending.push([child, depth + 1])
    }
    if (pending.length + count > FD_EXTENSION_LIMITS.values) invalid('structural budget exceeded')
  }
  // Portable resource cost: 128 envelope bytes + 32/value + UTF-8 strings/object keys.
  // Independent of JSON float/exponent spelling across Rust and JavaScript.
}
/** Opaque payloads can reference IDs; append cannot silently drop or guess how to remap them. */
export function assertFdAppendSupported(source: { fdCompatibility?: FdCompatibility | null }): void {
  validateFdCompatibility(source.fdCompatibility)
  if (source.fdCompatibility && Object.keys(source.fdCompatibility.extensions).length) {
    throw new Error('FD extensions cannot be appended without a reference remapper; open this file as a separate design to preserve its metadata')
  }
}
