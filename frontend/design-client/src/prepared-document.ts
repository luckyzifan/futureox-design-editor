import { activateDocumentFonts, prepareDocumentForEditing, prepareDocumentJsonForEditing } from './kernel/picking'
import type { DesignDocument } from './model'
import { requestDocumentPreparation, type DocumentPreparationIdentity } from './document-preparation-worker-client'
import { documentPreparationRuntime, sameDocumentPreparationRuntime } from './document-preparation-identity'
import {freezeOwnedDocument,freezeOwnedDocumentInTasks,immutableDocument} from './immutable-document'

const owned = new WeakMap<object, { document?: DesignDocument; validatedJson?: string }>()
const currentEncodings = new WeakMap<DesignDocument, { json: string; current: () => boolean }>()
const validPublications=new WeakSet<DesignDocument>()
export function validatedPreparedPublication(document:DesignDocument){return validPublications.has(document)&&immutableDocument(document)}
export type PreparedDocument = Readonly<{ id: string; snapshot(): DesignDocument }>

/** One-use ownership transfer across save/adoption. The admitted document is
 * never exposed before adoption; callers can only obtain independent copies.
 * A JSON property or structural TypeScript cast cannot manufacture this proof. */
export function prepareDocument(value: unknown): PreparedDocument {
  let validatedJson: string | undefined
  const document = prepareDocumentForEditing(value, json => { validatedJson = json })
  return ownDocument(document, validatedJson)
}

/** The source string, not a decoded caller object, is the private owner boundary. */
export function prepareDocumentJson(source: string, syntaxFailureAttempt?: object): PreparedDocument {
  let validatedJson: string | undefined
  const document = prepareDocumentJsonForEditing(source, json => { validatedJson = json }, syntaxFailureAttempt)
  return ownDocument(document, validatedJson)
}

/** Only this controlled worker request can reach the private ownership mint.
 * Recheck the exact source request's owner after the await and before minting;
 * cancellation/staleness never activates main-thread fonts or editing history. */
export async function prepareDocumentJsonInWorker(source: string, identity: DocumentPreparationIdentity,
  signal: AbortSignal, isCurrent: () => boolean): Promise<PreparedDocument> {
  if (signal.aborted || !isCurrent()) throw new DOMException('文档准备已过期', 'AbortError')
  const runtime = documentPreparationRuntime()
  const result = await requestDocumentPreparation(source, identity, signal)
  if (signal.aborted || !isCurrent() || !sameDocumentPreparationRuntime(runtime, documentPreparationRuntime()))
    throw new DOMException('文档准备已过期', 'AbortError')
  // Mutable main document-font/geometry epochs are deliberately not reused as
  // preparation identity. The worker installs this source's own font map, and
  // takePreparedDocument restores it atomically before main-thread adoption.
  await freezeOwnedDocumentInTasks(result.document,()=>!signal.aborted&&isCurrent()&&sameDocumentPreparationRuntime(runtime,documentPreparationRuntime()))
  return ownDocument(result.document, result.validatedJson)
}

/** Normalize every adoption path through the private ownership boundary.
 * An existing live token is already admitted; do not prepare it a second time. */
export function ensurePreparedDocument(value: unknown): PreparedDocument {
  if (value && typeof value === 'object') {
    const record = owned.get(value)
    if (record) {
      if (!record.document) throw Error('已准备的文档已被接收')
      return value as PreparedDocument
    }
  }
  return prepareDocument(value)
}

/** Owner proof is independent of optional encoded bytes (for example ID forks).
 * Capture before adoption, then also fence version/session changes at the call site. */
export function preparedDocumentAdoptionOwner(value: unknown) {
  if (!value || typeof value !== 'object') return
  const record = owned.get(value)
  if (!record?.document) return
  const document = record.document
  return (candidate: DesignDocument) => record.document === undefined && candidate === document
}

function ownDocument(document: DesignDocument, validatedJson?: string): PreparedDocument {
  if(freezeOwnedDocument(document))validPublications.add(document)
  const record = { document: document as DesignDocument | undefined, validatedJson }
  const token = Object.freeze({ id: document.id, snapshot() {
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
  record.validatedJson = undefined
  return document
}

/** Fork only a proven, private admitted snapshot. The only change is a fresh
 * valid document ID; consume the old owner so it cannot later be adopted. */
export function forkPreparedDocument(value: PreparedDocument): PreparedDocument {
  const record = owned.get(value)
  if (!record?.document) throw Error('已准备的文档已被接收')
  const document = { ...record.document, id: crypto.randomUUID() }
  record.document = undefined
  record.validatedJson = undefined
  // The previous certificate contains the old ID; never carry it to the fork.
  return ownDocument(document)
}

/** Certificate of exact post-layout JSON.stringify bytes, not a structural flag.
 * The closure does not expose the private owner; it succeeds only after that
 * one-use token was consumed and the editor adopted that exact document.
 * Identity does not prove immutability: consumers must also fence editor
 * version/session and synchronous listeners around the adoption call. */
export function preparedDocumentEncoding(value: unknown) {
  if (!value || typeof value !== 'object') return
  const record = owned.get(value)
  if (!record?.document || record.validatedJson === undefined) return
  const document = record.document, json = record.validatedJson
  const adopted = (candidate: DesignDocument) => record.document === undefined && candidate === document
  return { format: 'json-stringify-v1' as const, json,
    adopted,
    bindCurrent(candidate: DesignDocument, current: () => boolean) {
      // Only this private one-use certificate can supply the bytes. The editor
      // also binds its exact version/session, including reentrant subscribers.
      if (adopted(candidate) && current()) currentEncodings.set(candidate, { json, current })
    } }
}

/** A renderer may reuse exact bytes only while the certifying editor still owns
 * that same version and session. Arbitrary objects and old history snapshots do
 * not gain a serialization cache by structural equality or document ID. */
export function currentPreparedDocumentJson(document: DesignDocument): string | undefined {
  const encoding = currentEncodings.get(document)
  if (!encoding) return
  if (encoding.current()) return encoding.json
  currentEncodings.delete(document)
}

/** Release retained wire bytes as soon as the editor changes or disposes, even
 * if an old document object remains alive in editing history. */
export function forgetPreparedDocumentEncoding(document: DesignDocument) {
  currentEncodings.delete(document)
}
