import type { DesignDocument } from '../model'
import { applyDocumentPatch } from '../document-patch'

export type AuthoredSnapshot = { json: string; document: DesignDocument }
/** Only successful full synchronizations create these certificates. Reusing
 * the immutable JS records also makes release-time equality skip untouched
 * nodes; it never substitutes a document ID or a hash for complete equality. */
export function readAuthoredSnapshot(json: string, source?: AuthoredSnapshot): DesignDocument {
  if (typeof json === 'string' && json.length > 0 && source?.json === json) return source.document
  const document = JSON.parse(json) as DesignDocument
  return applyDocumentPatch(document, { nodes: document.nodes, fields: {} })
}
