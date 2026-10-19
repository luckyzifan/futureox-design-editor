import type { DesignDocument } from './model'
import type { DesktopSession } from './desktop-session'
import {
  getRevision,
  listRevisions,
  restoreRevision,
  type LocalRevisionEntry,
  type LocalRecord,
} from './local-store'

/**
 * One revision history backend for the whole editor. A desktop session with a
 * workspace routes every call to the sidecar's SQLite revisions; the browser
 * falls back to the IndexedDB revision store. Both keep the same semantics:
 * saves append snapshots, restore writes a brand-new revision and never
 * rewrites existing history.
 */
export type HistoryRoute = 'desktop' | 'local'
export type HistoryEntry = { revision: number; summary?: string; createdAt: number }
export type HistoryPage = {
  entries: HistoryEntry[]
  hasMore: boolean
  nextBeforeRevision?: number
}
export type HistorySnapshot = { document: DesignDocument; revision: number; createdAt?: number }
/** `false` means the restore did not happen (declined or failed); failures are reported by the session. */
export type HistoryRestore =
  | { restored: true; document: DesignDocument; revision: number; adopted: boolean }
  | false

/** The session surface the desktop route needs; tests substitute plain objects. */
export type HistorySession = Pick<
  DesktopSession,
  'supportsWorkspace' | 'listRevisions' | 'restoreWorkspace' | 'readWorkspaceRevision'
>
export interface DocumentHistoryApi {
  readonly route: HistoryRoute
  list(documentId: string, beforeRevision?: number): Promise<HistoryPage>
  load(documentId: string, revision: number): Promise<HistorySnapshot | null>
  restore(documentId: string, revision: number, expectedRevision?: number): Promise<HistoryRestore>
}

/** Pure routing decision so panels never branch on the transport themselves. */
export function selectHistoryRoute(
  session:
    | { supportsWorkspace: boolean }
    | { supportsWorkspace(): boolean }
    | null
    | undefined,
): HistoryRoute {
  const capable =
    typeof session?.supportsWorkspace === 'function'
      ? session.supportsWorkspace()
      : session?.supportsWorkspace
  return capable ? 'desktop' : 'local'
}

export function createDocumentHistory(session?: HistorySession | null): DocumentHistoryApi {
  if (selectHistoryRoute(session) === 'desktop') {
    const desktop = session!
    return {
      route: 'desktop',
      async list(documentId, beforeRevision) {
        const page = await desktop.listRevisions(documentId, beforeRevision)
        if (page.status !== 'ok')
          throw new Error(page.status === 'cancelled' ? '已取消' : page.message)
        return {
          entries: page.revisions.map((entry) => ({
            revision: entry.revision,
            createdAt: entry.updatedAt,
          })),
          hasMore: !!page.hasMore,
          nextBeforeRevision: page.hasMore ? page.nextBeforeRevision : undefined,
        }
      },
      async load(documentId, revision) {
        const snapshot = await desktop.readWorkspaceRevision(documentId, revision)
        return snapshot && { document: snapshot.document, revision, createdAt: snapshot.updatedAt }
      },
      async restore(documentId, revision, expectedRevision = 0) {
        const restored = await desktop.restoreWorkspace(documentId, revision, expectedRevision)
        // The session already adopted the document into the editor (or reported
        // the failure itself); the caller only needs the outcome.
        return restored && { restored: true, ...restored, adopted: true }
      },
    }
  }
  return {
    route: 'local',
    async list(documentId) {
      const records: LocalRevisionEntry[] = await listRevisions(documentId)
      return {
        entries: records.map(({ revision, summary, createdAt }) => ({ revision, summary, createdAt })),
        hasMore: false,
      }
    },
    async load(documentId, revision) {
      const record: LocalRecord | null = await getRevision(documentId, revision)
      return record && { document: record.document, revision, createdAt: record.updatedAt }
    },
    async restore(documentId, revision) {
      // IndexedDB has no concurrent writer protocol, so the durable restore
      // result is returned for the caller to adopt into the editing session.
      const record = await restoreRevision(documentId, revision)
      return { restored: true, document: record.document, revision: record.revision, adopted: false }
    },
  }
}
