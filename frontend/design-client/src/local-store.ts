import { validateDocument, type DesignDocument } from './model'
import { admitDocument } from './document-admission'
import { BINARY_DOCUMENT_FORMAT, decodeDocumentBinary, encodeDocumentBinary } from './kernel/binfmt'
import { initializeKernelModule } from './kernel/module'
import { immutableDocument } from './immutable-document'

export type LocalRecord = { document: DesignDocument; revision: number; updatedAt: number }
/**
 * Durable slot shape since format 2: the kernel binary document (binfmt)
 * instead of a structured-clone JSON document. Legacy JSON records remain
 * readable (migration read) and are rewritten in the binary form on save.
 */
export type LocalStoredRecord =
  | { format: typeof BINARY_DOCUMENT_FORMAT; bytes: Uint8Array; revision: number; updatedAt: number }
  | LocalRecord
export type LocalEntry = {
  id: string
  name: string
  revision: number
  updatedAt: number
  deleted: boolean
}
/** Per-document revision snapshots, newest last. Saves append, restores mark "恢复自 rN". */
export const LOCAL_REVISION_RETENTION = 50
export type LocalRevisionRecord = {
  documentId: string
  revision: number
  summary?: string
  format: typeof BINARY_DOCUMENT_FORMAT
  bytes: Uint8Array
  createdAt: number
}
export type LocalRevisionEntry = {
  documentId: string
  revision: number
  summary?: string
  createdAt: number
}
export class LocalConflictError extends Error {
  constructor() {
    super('另一标签页已修改此文件；请保存为副本或重新打开，当前画布已保留')
  }
}
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error || new Error('本地事务已中断'))
    tx.onerror = () => reject(tx.error || new Error('本地事务失败'))
  })
export async function localTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openLocalDatabase()
  const tx = db.transaction(stores, mode),
    done = completed(tx)
  // Attach immediately: a failed request may reject before work reaches done.
  void done.catch(() => {})
  try {
    const result = await work(tx)
    await done
    return result
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already committed/aborted. */
    }
    throw error
  } finally {
    db.close()
  }
}
export const localRequest = request
export function openLocalDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('futureox-design-studio', 3)
    r.onblocked = () => reject(new Error('请关闭使用旧版设计器的标签页后重试，本地原件已保留'))
    r.onupgradeneeded = () => {
      const db = r.result,
        tx = r.transaction!
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents')
      for (const name of ['catalog', 'session', 'outbox', 'remote'])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      // Version 3: durable revision history keyed by [documentId, revision].
      if (!db.objectStoreNames.contains('revisions'))
        db.createObjectStore('revisions', { keyPath: ['documentId', 'revision'] })
      const legacy = tx.objectStore('documents').get('current')
      legacy.onsuccess = () => {
        if (!legacy.result) return
        try {
          // This is a provisional migration copy, not admitted editor input.
          // Upgrade transactions cannot await WASM; localOpen performs canonical
          // admission afterward and the original legacy slot remains recoverable.
          const document = validateDocument(legacy.result),
            updatedAt = Date.now()
          tx.objectStore('documents').put({ document, revision: 1, updatedAt }, document.id)
          tx.objectStore('catalog').put(
            { id: document.id, name: document.name, revision: 1, updatedAt, deleted: false },
            document.id,
          )
          tx.objectStore('session').put(document.id, 'current')
        } catch {
          // Keep the original slot intact. Opening reports its validation error;
          // an upgrade must never replace a damaged only copy with an empty file.
        }
      }
    }
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close()
      resolve(r.result)
    }
  })
}
export async function localOpen(id?: string): Promise<LocalRecord | null> {
  const db = await openLocalDatabase()
  let record: LocalStoredRecord | undefined
  let legacy: unknown
  try {
    const tx = db.transaction(['documents', 'session'], 'readonly'),
      done = completed(tx)
    const selected =
      id || ((await request(tx.objectStore('session').get('current'))) as string | undefined)
    record = selected
      ? ((await request(tx.objectStore('documents').get(selected))) as LocalStoredRecord | undefined)
      : undefined
    legacy = !selected ? await request(tx.objectStore('documents').get('current')) : undefined
    await done
  } finally {
    db.close()
  }
  if (record) {
    // Format 2 slots carry kernel binfmt bytes; legacy JSON documents are the
    // migration-read path and are rewritten in binary form on the next save.
    // Decoding needs the kernel module, so wait for the same idempotent
    // initialization the editor startup races against.
    const bytes = 'bytes' in record ? record.bytes : undefined
    if (bytes) await initializeKernelModule()
    const document = await admitDocument(
      bytes ? decodeDocumentBinary(bytes) : (record as LocalRecord).document,
    )
    return { document, revision: record.revision, updatedAt: record.updatedAt }
  }
  if (legacy) await admitDocument(legacy)
  return null
}
/** Revisions of one document, as an IndexedDB key range over compound keys. */
const revisionRange = (documentId: string) =>
  IDBKeyRange.bound([documentId, -Infinity], [documentId, Infinity])
/** Keeps only the newest LOCAL_REVISION_RETENTION snapshots, inside the caller's transaction. */
async function pruneRevisions(
  store: IDBObjectStore,
  documentId: string,
  keep = LOCAL_REVISION_RETENTION,
) {
  const keys = (await request(store.getAllKeys(revisionRange(documentId)))) as IDBValidKey[]
  for (const stale of keys.slice(0, Math.max(0, keys.length - keep))) store.delete(stale)
}
export async function localSave(
  document: DesignDocument,
  expectedRevision = 0,
  summary?: string,
): Promise<LocalRecord> {
  document = await admitDocument(document)
  await initializeKernelModule()
  const bytes = encodeDocumentBinary(document)
  const db = await openLocalDatabase()
  try {
    const tx = db.transaction(['documents', 'catalog', 'revisions'], 'readwrite'),
      done = completed(tx)
    const old = (await request(tx.objectStore('documents').get(document.id))) as
      | LocalStoredRecord
      | undefined
    if ((old?.revision || 0) !== expectedRevision) {
      tx.abort()
      await done.catch(() => {})
      throw new LocalConflictError()
    }
    const revision = expectedRevision + 1,
      updatedAt = Date.now()
    const stored: LocalStoredRecord = { format: BINARY_DOCUMENT_FORMAT, bytes, revision, updatedAt }
    tx.objectStore('documents').put(stored, document.id)
    tx.objectStore('catalog').put(
      {
        id: document.id,
        name: document.name,
        revision,
        updatedAt,
        deleted: false,
      },
      document.id,
    )
    // The same transaction also files the revision snapshot and drops stale ones,
    // so a crash can never leave a document head without its history entry.
    tx.objectStore('revisions').put({
      documentId: document.id,
      revision,
      summary,
      format: BINARY_DOCUMENT_FORMAT,
      bytes,
      createdAt: updatedAt,
    } satisfies LocalRevisionRecord)
    await pruneRevisions(tx.objectStore('revisions'), document.id)
    await done
    return { document, revision, updatedAt }
  } finally {
    db.close()
  }
}
/** Newest-first revision list of one local document, without snapshot payloads. */
export async function listRevisions(documentId: string): Promise<LocalRevisionEntry[]> {
  return localTransaction(['revisions'], 'readonly', (tx) => new Promise<LocalRevisionEntry[]>((resolve, reject) => {
    const entries: LocalRevisionEntry[] = []
    // A value cursor still clones one stored snapshot per step. Retain only its
    // metadata, never an array of all 50 binary snapshots as getAll() would.
    // Compound-key ordering already gives newest-first history for this document.
    const cursor = tx.objectStore('revisions').openCursor(revisionRange(documentId), 'prev')
    cursor.onerror = () => reject(cursor.error)
    cursor.onsuccess = () => {
      try {
        const row = cursor.result
        if (!row) { resolve(entries); return }
        const { documentId: id, revision, summary, createdAt } = row.value as LocalRevisionRecord
        entries.push({ documentId: id, revision, summary, createdAt })
        row.continue()
      } catch (error) { reject(error) }
    }
  }))
}
/** Loads one revision snapshot through the same admission path as a local open. */
export async function getRevision(
  documentId: string,
  revision: number,
): Promise<LocalRecord | null> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('历史版本号无效')
  const db = await openLocalDatabase()
  let record: LocalRevisionRecord | undefined
  try {
    const tx = db.transaction('revisions'),
      done = completed(tx)
    record = (await request(
      tx.objectStore('revisions').get([documentId, revision]),
    )) as LocalRevisionRecord | undefined
    await done
  } finally {
    db.close()
  }
  if (!record) return null
  await initializeKernelModule()
  const document = await admitDocument(decodeDocumentBinary(record.bytes))
  return { document, revision: record.revision, updatedAt: record.createdAt }
}
/** Restores a snapshot as a brand-new head revision; the source history entry stays. */
export async function restoreRevision(
  documentId: string,
  revision: number,
  expectedRevision?: number,
): Promise<LocalRecord> {
  const snapshot = await getRevision(documentId, revision)
  if (!snapshot) throw new Error(`历史版本 r${revision} 不存在；请刷新列表后重试`)
  const headRevision = expectedRevision ?? (await localOpen(documentId))?.revision ?? 0
  return localSave(snapshot.document, headRevision, `恢复自 r${revision}`)
}
export async function localSelect(id: string) {
  const db = await openLocalDatabase()
  try {
    const tx = db.transaction('session', 'readwrite'),
      done = completed(tx)
    tx.objectStore('session').put(id, 'current')
    await done
  } finally {
    db.close()
  }
}
export async function localList(): Promise<LocalEntry[]> {
  const db = await openLocalDatabase()
  try {
    const tx = db.transaction('catalog'),
      done = completed(tx)
    const entries = (await request(tx.objectStore('catalog').getAll())) as LocalEntry[]
    await done
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
  } finally {
    db.close()
  }
}
export async function localTrash(id: string, deleted: boolean) {
  const db = await openLocalDatabase()
  try {
    const tx = db.transaction('catalog', 'readwrite'),
      done = completed(tx)
    const store = tx.objectStore('catalog'),
      entry = (await request(store.get(id))) as LocalEntry | undefined
    if (entry) store.put({ ...entry, deleted }, id)
    await done
  } finally {
    db.close()
  }
}

export type SaveStatus = { documentId: string; version: number; dirty: boolean; error?: string }
/** Version-aware serial saves. A completion only confirms its own snapshot. */
export class SaveCoordinator {
  private queue: Promise<unknown> = Promise.resolve()
  private revisions = new Map<string, number>()
  private durable = new Map<string, number>()
  private current?: { document: DesignDocument; version: number }
  constructor(
    private commit = localSave,
    private publish: (status: SaveStatus) => void = () => {},
    private onDurable: (record: LocalRecord, version: number) => void = () => {},
  ) {}
  expectRevision(id: string, revision: number) {
    this.revisions.set(id, revision)
  }
  open(record: LocalRecord, version: number) {
    this.revisions.set(record.document.id, record.revision)
    this.durable.set(record.document.id, version)
    this.observe(record.document, version)
  }
  observe(document: DesignDocument, version: number) {
    this.current = { document, version }
    this.emit()
  }
  get dirty() {
    return !!this.current && this.durable.get(this.current.document.id) !== this.current.version
  }
  durableRevision(documentId: string, version: number) {
    return this.durable.get(documentId) === version ? this.revisions.get(documentId) : undefined
  }
  private emit(error?: string) {
    if (this.current)
      this.publish({
        documentId: this.current.document.id,
        version: this.current.version,
        dirty: this.dirty,
        error,
      })
  }
  save(document: DesignDocument, version: number): Promise<void> {
    const documentId = document.id
    let snapshot: DesignDocument
    try {
      snapshot = immutableDocument(document) ? document : structuredClone(document)
    } catch (error) {
      if (this.current?.document.id === documentId) this.emit(String(error))
      return Promise.reject(error)
    }
    const attempt = this.queue
      .catch(() => {})
      .then(async () => {
        if ((this.durable.get(documentId) ?? -1) >= version) return
        const record = await this.commit(snapshot, this.revisions.get(documentId) || 0)
        if (record.document.id !== documentId) throw new Error('保存回执不属于请求文档；当前修改已保留')
        this.revisions.set(documentId, record.revision)
        this.durable.set(documentId, version)
        this.emit()
        this.onDurable(record, version)
      })
      .catch((error) => {
        if (this.current?.document.id === documentId) this.emit(String(error))
        throw error
      })
    this.queue = attempt
    return attempt
  }
}
