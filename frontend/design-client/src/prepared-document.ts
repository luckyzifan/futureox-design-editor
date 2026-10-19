import { activateDocumentFonts, prepareDocumentForEditing } from './kernel/picking'
import type { DesignDocument } from './model'

const owned = new WeakMap<object, { document?: DesignDocument }>()
export type PreparedDocument = Readonly<{ snapshot(): DesignDocument }>

/** One-use ownership transfer across save/adoption. The admitted document is
 * never exposed before adoption; callers can only obtain independent copies.
 * A JSON property or structural TypeScript cast cannot manufacture this proof. */
export function prepareDocument(value: unknown): PreparedDocument {
  const record = { document: prepareDocumentForEditing(value) as DesignDocument | undefined }
  const token = Object.freeze({ snapshot() {
    if (!record.document) throw Error('已准备的文档已被接收')
    return structuredClone(record.document)
  } })
  owned.set(token, record)
  return token
}

export function takePreparedDocument(value: unknown): DesignDocument | undefined {
  if (!value || typeof value !== 'object') return
  const record = owned.get(value)
  if (!record) return
  if (!record.document) throw Error('已准备的文档已被接收')
  const document = record.document
  // Another export/import may have rebound the shared picking engine while
  // durable storage was awaited. Restore this owner's fonts before adoption.
  activateDocumentFonts(document)
  record.document = undefined
  return document
}
