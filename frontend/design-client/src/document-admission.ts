import { assertDocumentJson } from './document-capacity'
import { validateDocument, type DesignDocument } from './model'
import { documentStage, DocumentStage } from './document-lifecycle-diagnostics'
import { initializeKernelModule, validateKernelDocument } from './kernel/module'

function captureDocument(value: unknown) {
  validateDocument(value)
  const json = JSON.stringify(value)
  assertDocumentJson(json)
  // Use the exact serialized snapshot validated by Rust, never a caller-owned
  // object which can change while module initialization or storage is awaited.
  const document = validateDocument(JSON.parse(json))
  return { json, document }
}

export async function admitDocument(value: unknown): Promise<DesignDocument> {
  const snapshot = captureDocument(value)
  await initializeKernelModule()
  validateKernelDocument(snapshot.json)
  return snapshot.document
}

/** Editing adoption remains synchronous and fails explicitly before module readiness. */
export function admitDocumentSync(value: unknown): DesignDocument {
  const snapshot = captureDocument(value)
  validateKernelDocument(snapshot.json)
  return snapshot.document
}

/** Only JSON.parse-created private graphs qualify. Check every JSON value,
 * including unknown schema fields: stringify normalizes -0 and overflowed
 * numbers, and the old snapshot path must remain authoritative in those cases. */
function isJsonRoundtripStable(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return false
    } else if (current !== null && typeof current === 'object') {
      for (const key in current) if (Object.hasOwn(current, key)) {
        const child = (current as Record<string, unknown>)[key]
        if (typeof child === 'number') {
          if (!Number.isFinite(child) || Object.is(child, -0)) return false
        } else if (child !== null && typeof child === 'object') pending.push(child)
      }
    }
  }
  return true
}

// The caller owns a fresh, private attempt token. A historical parse error
// rethrown by a later host hook cannot authorize another attempt's transport.
const jsonSyntaxFailures = new WeakMap<object, object>()
export function consumeDocumentJsonSyntaxFailure(error: unknown, attempt: object): boolean {
  if (!error || typeof error !== 'object' || jsonSyntaxFailures.get(error) !== attempt) return false
  jsonSyntaxFailures.delete(error)
  return true
}

/** A primitive source string is the ownership boundary, never a caller-owned
 * object or a claimed certificate. Validation remains synchronous and complete.
 * Avoid only the redundant snapshot clone for a private JSON-stable graph. */
export function admitDocumentJsonSync(source: string, syntaxFailureAttempt?: object): DesignDocument {
  if (typeof source !== 'string') throw new TypeError('设计文档 JSON 必须为字符串')
  assertDocumentJson(source)
  const parsed: unknown = documentStage(DocumentStage.decode, () => {
    try { return JSON.parse(source) }
    catch (error) {
      if (syntaxFailureAttempt && error instanceof SyntaxError) jsonSyntaxFailures.set(error, syntaxFailureAttempt)
      throw error
    }
  })
  return documentStage(DocumentStage.admission, () => {
    // Check before validation/stringify: a host hook could remove itself while
    // running. Preserve the original capture path for altered JSON prototypes.
    if ('toJSON' in Object.prototype || 'toJSON' in Array.prototype ||
        Object.getPrototypeOf(Array.prototype) !== Object.prototype) return admitDocumentSync(parsed)
    const document = validateDocument(parsed)
    const json = JSON.stringify(parsed)
    assertDocumentJson(json)
    const snapshot = isJsonRoundtripStable(parsed) ? document : validateDocument(JSON.parse(json))
    validateKernelDocument(json)
    return snapshot
  })
}
