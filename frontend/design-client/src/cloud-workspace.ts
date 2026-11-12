import type { DesignDocument } from './model'
import type { DesktopCloudCursor } from './desktop'
import { type Backend, BackendError, type RemoteDocument } from './persistence'
import { applyWorkspacePatch, hasWorkspaceChanges, workspacePatch, workspacePatchesConflict, type WorkspacePatch } from './workspace-patch'

export type CloudWorkspaceStatus = {
  connected: boolean
  documentId?: string
  revision?: number
  phase?: 'saving' | 'saved' | 'error'
  error?: string
}

type BeforeLocalCommit = (mutationId: string) => Promise<void>
type EditorView = {
  read(): DesignDocument | undefined
  install(expected: DesignDocument, next: DesignDocument, signal: AbortSignal,
    beforeCommit?: BeforeLocalCommit): Promise<DesignDocument | undefined>
}
export type WorkspaceJournal = {
  read(id: string): Promise<DesktopCloudCursor | null>
  write(id: string, cursor: DesktopCloudCursor): Promise<void>
  localRevision(document: DesignDocument): number | undefined
  localVersion(id: string, revision: number): Promise<DesignDocument>
}
type ActiveView = EditorView & { id: string; lifetime: AbortController }
type PendingEdit = { document: DesignDocument; patch: WorkspacePatch; requestId: string }
type LinkedDocument = {
  id: string
  revision: number
  base?: DesignDocument
  initial?: DesignDocument
  durable?: DesignDocument
  pending?: PendingEdit
  pendingRef?: DesktopCloudCursor['pending']
  incoming?: { expected: DesignDocument; document: DesignDocument; revision: number }
  stopped?: number
  status?: CloudWorkspaceStatus
}
type Connection = {
  backend: Backend
  lifetime: AbortController
  journal?: WorkspaceJournal
  checkedId?: string
  paused?: boolean
  link?: LinkedDocument
  task?: Promise<unknown>
}

const changeInterval = 750
const conflictMessage = '服务器版本有冲突。本地修改已保留，可打开服务器版本或保存本机副本。'

/** One serial network lane for the active shared document. Each host supplies
 * an already durable authored snapshot and its own local adoption boundary. */
export class CloudWorkspace {
  private connection?: Connection
  private view?: ActiveView
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly publish: (status: CloudWorkspaceStatus) => void) {}

  attach(backend: Backend, journal?: WorkspaceJournal) {
    this.clearTimer()
    this.connection?.lifetime.abort()
    this.connection = { backend, journal, lifetime: new AbortController() }
    this.publish({ connected: true })
    this.schedule()
  }

  disconnect() {
    this.clearTimer()
    this.connection?.lifetime.abort()
    this.connection = undefined
    this.publish({ connected: false })
  }

  private connected() {
    if (!this.connection) throw new Error('请先连接服务器工作区')
    return this.connection
  }

  list(signal: AbortSignal) {
    const { backend, lifetime } = this.connected()
    return backend.list(AbortSignal.any([signal, lifetime.signal]))
  }

  async open(id: string, signal: AbortSignal) {
    const connection = this.connected()
    await connection.task
    return connection.backend.get(id, AbortSignal.any([signal, connection.lifetime.signal]))
  }

  link(record: RemoteDocument, local: DesignDocument) {
    const connection = this.connected()
    if (local.id !== record.id) throw Error('服务器版本与当前文档不一致')
    const link = connection.link = { id: record.id, revision: record.revision,
      base: connection.journal ? record.document : local }
    this.report(link, 'saved')
    this.schedule()
  }

  /** Explicit server open (including conflict resolution). Journal the SQLite
   * mutation before replacing the canvas so restart can recognize its receipt. */
  async adopt(record: RemoteDocument, install: (signal: AbortSignal, beforeCommit?: BeforeLocalCommit) =>
    Promise<DesignDocument | undefined>) {
    const connection = this.connected(), { journal, lifetime } = connection
    if (connection.paused) return false
    connection.paused = true
    this.clearTimer()
    try {
      await connection.task
      lifetime.signal.throwIfAborted()
      const previous = await journal?.read(record.id) ?? { revision: 0 }
      if (previous.revision > record.revision) throw Error('服务器文档版本已回退')
      const beforeCommit = journal ? (mutationId: string) => journal.write(record.id,
        { ...previous, applying: { revision: record.revision, mutationId } }) : undefined
      const local = await install(lifetime.signal, beforeCommit)
      if (!local || this.connection !== connection) return false
      await journal?.write(record.id, { revision: record.revision })
      if (this.connection !== connection) return false
      this.link(record, local)
      return true
    } finally {
      connection.paused = false
      this.schedule()
    }
  }

  watch(id: string, editor: EditorView) {
    this.view?.lifetime.abort()
    const view = this.view = { ...editor, id, lifetime: new AbortController() }
    this.schedule()
    return () => {
      view.lifetime.abort()
      if (this.view === view) {
        this.view = undefined
        this.clearTimer()
        this.schedule()
      }
    }
  }

  async sync(document: DesignDocument) {
    const connection = this.connected()
    const { journal } = connection
    let current = connection.link
    if (journal && current?.id !== document.id) {
      const cursor = await journal.read(document.id)
      if (this.connection !== connection) return
      if (cursor && (cursor.revision || cursor.pending)) {
        current = connection.link = { id: document.id, revision: cursor.revision, pendingRef: cursor.pending }
      }
    }
    if (current?.id === document.id) {
      if (current.stopped === 409) throw new BackendError(409, conflictMessage)
      if (current.stopped) {
        if (journal) await journal.write(document.id, { revision: current.revision })
        current.stopped = undefined
        current.pending = undefined
        current.pendingRef = undefined
        if (!current.revision) current.initial = document
      }
    } else connection.link = { id: document.id, revision: 0, initial: document }
    this.schedule()
  }

  localSaved(document: DesignDocument) {
    const link = this.connection?.link
    if (link?.id !== document.id) return
    link.durable = document
    this.schedule()
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private report(link: LinkedDocument, phase: NonNullable<CloudWorkspaceStatus['phase']>, error?: string) {
    const previous = link.status
    if (previous?.phase === phase && previous.error === error && previous.revision === link.revision) return
    this.publish(link.status = { connected: true, documentId: link.id, revision: link.revision, phase, error })
  }

  private schedule(delay = 0) {
    const connection = this.connection, link = connection?.link, view = this.view
    if (!connection || connection.paused || connection.task) return
    const restore = !!(connection.journal && view && connection.checkedId !== view.id && link?.id !== view.id)
    if (!restore && (!link || link.stopped || !link.initial && !link.pendingRef && view?.id !== link.id &&
        (link.incoming || !link.pending && !link.durable))) return
    if (this.timer !== undefined && delay) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      let next = changeInterval
      const current = () => this.connection === connection && connection.link === link
      if (!current()) { this.schedule(); return }
      const work = restore ? this.restore(connection, view!) : this.advance(connection, link!, current)
      connection.task = work.then(advanced => {
        if (advanced) next = 0
      }, error => {
        if (!current()) return
        const status = error instanceof BackendError ? error.status : undefined
        const message = status === 409 ? conflictMessage : error instanceof Error ? error.message : String(error)
        if (link) {
          if (status && status >= 400 && status < 500 && status !== 429) link.stopped = status
          this.report(link, 'error', message)
        } else this.publish({ connected: true, documentId: view?.id, phase: 'error', error: message })
        next = 2000
      }).finally(() => {
        connection.task = undefined
        if (this.connection === connection) this.schedule(next)
      })
    }, delay)
  }

  private async restore(connection: Connection, view: ActiveView) {
    const cursor = await connection.journal!.read(view.id)
    if (this.connection !== connection || this.view !== view) return false
    connection.checkedId = view.id
    if (!cursor || !cursor.revision && !cursor.pending) return false
    connection.link = { id: view.id, revision: cursor.revision, pendingRef: cursor.pending }
    return true
  }

  private async recordRequest(journal: WorkspaceJournal, link: LinkedDocument, document: DesignDocument, requestId: string) {
    const localRevision = journal.localRevision(document)
    if (localRevision === undefined) throw Error('请先完成本机保存')
    const pending = { localRevision, requestId }
    await journal.write(link.id, { revision: link.revision, pending })
    link.pendingRef = pending
  }

  private async advance(connection: Connection, link: LinkedDocument, current: () => boolean) {
    const { backend, lifetime, journal } = connection
    if (!link.revision && (link.initial || link.pendingRef)) {
      const initial = link.initial ?? await journal!.localVersion(link.id, link.pendingRef!.localRevision)
      if (!current()) return false
      if (journal && !link.pendingRef) await this.recordRequest(journal, link, initial, crypto.randomUUID())
      if (!current()) return false
      this.report(link, 'saving')
      const receipt = await backend.save(initial, 0, { signal: lifetime.signal, requestId: link.pendingRef?.requestId })
      if (!current()) return false
      await journal?.write(link.id, { revision: receipt.revision })
      if (!current()) return false
      link.revision = receipt.revision
      link.base = journal ? receipt.document : initial
      link.initial = undefined
      link.pendingRef = undefined
      this.report(link, 'saved')
      return true
    }

    if (journal && !link.base && link.revision) {
      const base = await backend.getVersion(link.id, link.revision, lifetime.signal)
      if (!current()) return false
      link.base = base.document
    }
    const view = this.view?.id === link.id ? this.view : undefined, base = link.base
    if (!base) return false
    const local = view ? view.read() : link.durable
    if (link.incoming) {
      if (!local || !view) return false
      const { expected, document, revision } = link.incoming
      const later = workspacePatch(expected, local)
      if (hasWorkspaceChanges(later) && workspacePatchesConflict(later, workspacePatch(expected, document)))
        throw new BackendError(409, conflictMessage)
      const next = applyWorkspacePatch(document, later)
      const beforeCommit = journal ? (mutationId: string) => journal.write(link.id, {
        revision: link.revision, pending: link.pendingRef, applying: { revision, mutationId },
      }) : undefined
      const installed = hasWorkspaceChanges(workspacePatch(local, next))
        ? await view.install(local, next, AbortSignal.any([lifetime.signal, view.lifetime.signal]), beforeCommit) : local
      if (!current() || !installed) return false
      await journal?.write(link.id, { revision })
      if (!current()) return false
      link.revision = revision
      link.incoming = undefined
      link.pendingRef = undefined
      if (link.durable === local) link.durable = undefined
      link.base = journal ? document :
        !hasWorkspaceChanges(later) || !hasWorkspaceChanges(workspacePatch(document, installed)) ? installed : document
      this.report(link, 'saved')
      return true
    }

    if (journal && !link.pending && link.pendingRef) {
      const saved = await journal.localVersion(link.id, link.pendingRef.localRevision)
      if (!current()) return false
      link.pending = { document: saved, patch: workspacePatch(base, saved), requestId: link.pendingRef.requestId }
    }
    if (!link.pending && local) {
      const patch = local === base ? undefined : workspacePatch(base, local)
      if (patch && hasWorkspaceChanges(patch)) {
        const requestId = crypto.randomUUID()
        if (journal) await this.recordRequest(journal, link, local, requestId)
        if (!current()) return false
        link.pending = { document: local, patch, requestId }
      }
      if (link.durable === local) link.durable = undefined
    }
    if (link.pending) {
      const pending = link.pending
      this.report(link, 'saving')
      const receipt = await backend.edit(link.id, link.revision, pending.requestId, pending.patch, lifetime.signal)
      if (!current()) return false
      if (!receipt.merged) await journal?.write(link.id, { revision: receipt.revision })
      if (!current()) return false
      link.pending = undefined
      if (receipt.merged) {
        link.incoming = { expected: pending.document, document: receipt.merged.document, revision: receipt.revision }
      } else {
        link.revision = receipt.revision
        link.base = journal ? applyWorkspacePatch(base, pending.patch) : pending.document
        link.pendingRef = undefined
        this.report(link, 'saved')
      }
      return true
    }

    if (!view || !local) return false
    link.base = local
    const signal = AbortSignal.any([lifetime.signal, view.lifetime.signal])
    try {
      const change = await backend.changes(link.id, link.revision, signal)
      if (!current() || this.view !== view) return false
      if (change.revision === link.revision) {
        this.report(link, 'saved')
        return false
      }
      const next = change.patch ? { revision: change.revision, document: applyWorkspacePatch(local, change.patch) }
        : await backend.get(link.id, signal)
      if (!current() || this.view !== view) return false
      if (next.revision < change.revision) throw Error('服务器文档版本已回退')
      link.incoming = { expected: local, document: next.document, revision: next.revision }
      return true
    } catch (error) {
      if (signal.aborted) return false
      throw error
    }
  }
}
