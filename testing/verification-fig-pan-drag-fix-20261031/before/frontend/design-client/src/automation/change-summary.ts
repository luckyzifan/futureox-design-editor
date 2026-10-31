import { equalValue } from '../document-patch'
import type { DesignDocument } from '../model'

export const CHANGE_SUMMARY_LIMITS = { maxPaths: 256, maxBytes: 48 * 1024, maxValueCharacters: 256 } as const
export interface AutomationChange {
  /** RFC 6901 JSON Pointer into the authored document. */
  path: string
  kind: 'add' | 'remove' | 'replace'
  before?: unknown
  after?: unknown
  beforeOmitted?: true
  afterOmitted?: true
}
const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
/** Never repeat opaque image/font bytes or large inserted subtrees in a receipt. */
function safeValue(value: unknown, path: string): boolean {
  if (/(?:^|\/)(?:image|data|base64|content|dataUrl)(?:\/|$)/i.test(path) || /^\/fonts(?:\/|$)/.test(path)) return false
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' && value.length <= CHANGE_SUMMARY_LIMITS.maxValueCharacters && !value.startsWith('data:')
}
export function summarizeChanges(before: DesignDocument, after: DesignDocument) {
  const changes: AutomationChange[] = []
  let bytes = 0, changesTruncated = false
  const emit = (a: unknown, b: unknown, path: string, hasA: boolean, hasB: boolean) => {
    const change: AutomationChange = { path, kind: !hasA ? 'add' : !hasB ? 'remove' : 'replace' }
    if (hasA) { if (safeValue(a, path)) change.before = a; else change.beforeOmitted = true }
    if (hasB) { if (safeValue(b, path)) change.after = b; else change.afterOmitted = true }
    const size = new TextEncoder().encode(JSON.stringify(change)).byteLength + new TextEncoder().encode(JSON.stringify(path)).byteLength + 8
    if (changes.length >= CHANGE_SUMMARY_LIMITS.maxPaths || bytes + size > CHANGE_SUMMARY_LIMITS.maxBytes) { changesTruncated = true; return }
    changes.push(change); bytes += size
  }
  const visit = (a: unknown, b: unknown, path: string, hasA = true, hasB = true) => {
    if (changesTruncated || hasA === hasB && equalValue(a, b)) return
    if (hasA && hasB && object(a) && object(b) && Array.isArray(a) === Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        visit(a[key], b[key], `${path}/${escape(key)}`, Object.hasOwn(a, key), Object.hasOwn(b, key))
        if (changesTruncated) return
      }
    } else emit(a, b, path, hasA, hasB)
  }
  visit(before, after, '')
  return { changedPaths: changes.map(change => change.path), changes, changesTruncated }
}
