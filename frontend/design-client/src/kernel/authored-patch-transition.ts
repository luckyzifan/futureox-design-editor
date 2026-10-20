import { documentPatch, type DocumentPatch } from '../document-patch'
import type { DesignDocument } from '../model'

const MAX_NODES = 256
const MAX_PATCH_UTF8_BYTES = 64 * 1024
const scalarProperties = new Set(['name', 'width', 'height', 'opacity', 'visible', 'locked', 'smoothing', 'points', 'innerRadius', 'cornerRadius'])
/** Exact bounded comparison of unchanged topology/resource/extension values.
 * Object.is distinguishes signed zero. Missing, undefined and null are not
 * interchangeable; unsupported/cyclic/too-deep values simply lose admission. */
function sameValue(a: unknown, b: unknown, budget: { remaining: number }, depth = 0): boolean {
  if (--budget.remaining < 0 || depth > 32) return false
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const x = Object.keys(a), y = Object.keys(b)
  return x.length === y.length && x.every(key => Object.hasOwn(b, key) && sameValue(
    (a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], budget, depth + 1))
}
function supportedValue(key: string, value: unknown) {
  if (key === 'transform' || key === 'radii') return Array.isArray(value) && value.length === (key === 'transform' ? 6 : 4) && value.every(n => typeof n === 'number' && Number.isFinite(n))
  if (!scalarProperties.has(key)) return false
  if (key === 'name') return typeof value === 'string'
  if (key === 'visible' || key === 'locked') return typeof value === 'boolean'
  return typeof value === 'number' && Number.isFinite(value)
}
/** Receiver-side subset gate. Native validation remains authoritative. This
 * gate only authorizes publishing a postpatch proof, never normal editing. */
export function supportsAcknowledgedPropertyPatch(before: DesignDocument, patch: DocumentPatch): boolean {
  if (!patch?.nodes || !patch.fields || Object.keys(patch.fields).length || (before.animations?.length ?? 0) !== 0) return false
  const ids = Object.keys(patch.nodes)
  if (ids.length > MAX_NODES) return false
  const budget = { remaining: 16384 }
  for (const id of ids) {
    const old = before.nodes[id], next = patch.nodes[id]
    if (!Object.hasOwn(before.nodes, id) || !old || !next || next.id !== id || ['__proto__', 'constructor', 'prototype'].includes(id)) return false
    const a = old as unknown as Record<string, unknown>, b = next as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (Object.hasOwn(a, key) === Object.hasOwn(b, key) && sameValue(a[key], b[key], budget)) continue
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key) || !supportedValue(key, b[key])) return false
    }
  }
  return budget.remaining >= 0
}
export function boundedPatchWire(json: string) {
  // At most three UTF-8 bytes per UTF-16 code unit (surrogate pairs use four
  // bytes for two units). Conservative bound avoids a second encoding buffer.
  return typeof json === 'string' && json.length * 3 <= MAX_PATCH_UTF8_BYTES
}
/** Owns the exact immutable BEFORE→AFTER association and complete computed
 * patch. No caller hints, normalized native readback, or revision equality. */
export function prepareAuthoredPatchTransition(before: DesignDocument, after: DesignDocument) {
  const patch = documentPatch(before, after)
  const roots = new Set([...Object.keys(before), ...Object.keys(after)])
  const unchangedRoots = [...roots].every(key => key === 'nodes' ||
    (Object.hasOwn(before, key) === Object.hasOwn(after, key) &&
      Object.is((before as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key])))
  return { patch, canAcknowledge: unchangedRoots && supportsAcknowledgedPropertyPatch(before, patch) }
}
