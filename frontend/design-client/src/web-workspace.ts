import type { DesignDocument } from './model'
import { Backend, BackendError, type RemoteDocument } from './persistence'
import { applyWorkspacePatch, hasWorkspaceChanges, workspacePatch, workspacePatchesConflict, type WorkspacePatch } from './workspace-patch'

export type WebWorkspaceStatus = {
  connected: boolean
  documentId?: string
  revision?: number
  phase?: 'saving' | 'saved' | 'error'
  error?: string
}

type EditorView = {
  read(): DesignDocument | undefined
  install(expected: DesignDocument, next: DesignDocument, signal: AbortSignal): Promise<DesignDocument | undefined>
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
  incoming?: { expected: DesignDocument; document: DesignDocument }
  stopped?: number
  status?: WebWorkspaceStatus
}
type Connection = {
  backend: Backend
  lifetime: AbortController
  link?: LinkedDocument
  task?: Promise<unknown>
}

const changeInterval = 750
const conflictMessage = '服务器版本有冲突。本地修改已保留，可打开服务器版本或保存本机副本。'

/** The active shared document has one serial network lane. Local edits can
 * enter this lane only after the IndexedDB save for that authored version. */
export class WebWorkspace {
  private connection?: Connection
  private view?: ActiveView
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly publish: (status: WebWorkspaceStatus) => void) {}

  async connect(token: string, signal: AbortSignal) {
    const backend = new Backend()
    backend.token = token.trim()
    if (!backend.token) throw new Error('请输入工作空间访问令牌')
    const list = await backend.list(signal)
    signal.throwIfAborted()
    this.disconnect()
    this.connection = { backend, lifetime: new AbortController() }
    this.publish({ connected: true })
    return list
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
    const link = connection.link = { id: record.id, revision: record.revision, base: local }
    this.report(link, 'saved')
    this.schedule()
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

  sync(document: DesignDocument) {
    const connection = this.connected()
    const current = connection.link
    if (current?.id === document.id) {
      if (current.stopped === 409) throw new BackendError(409, conflictMessage)
      if (current.stopped) {
        current.stopped = undefined
        current.pending = undefined
        if (current.initial) current.initial = document
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

  private report(link: LinkedDocument, phase: NonNullable<WebWorkspaceStatus['phase']>, error?: string) {
    const previous = link.status
    if (previous?.phase === phase && previous.error === error && previous.revision === link.revision) return
    this.publish(link.status = { connected: true, documentId: link.id, revision: link.revision, phase, error })
  }

  private schedule(delay = 0) {
    const connection = this.connection, link = connection?.link
    if (!connection || !link || link.stopped || connection.task ||
        !link.initial && this.view?.id !== link.id && (link.incoming || !link.pending && !link.durable)) return
    if (this.timer !== undefined && delay) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      let next = changeInterval
      const current = () => this.connection === connection && connection.link === link
      if (!current()) { this.schedule(); return }
      connection.task = this.advance(connection, link, current).then(advanced => {
        if (advanced) next = 0
      }, error => {
        if (!current()) return
        const status = error instanceof BackendError ? error.status : undefined
        if (status && status >= 400 && status < 500 && status !== 429) link.stopped = status
        this.report(link, 'error', status === 409 ? conflictMessage : error instanceof Error ? error.message : String(error))
        next = 2000
      }).finally(() => {
        connection.task = undefined
        if (this.connection === connection) this.schedule(next)
      })
    }, delay)
  }

  private async advance(connection: Connection, link: LinkedDocument, current: () => boolean) {
    const { backend, lifetime } = connection
    if (link.initial) {
      const initial = link.initial
      this.report(link, 'saving')
      const receipt = await backend.save(initial, 0, { signal: lifetime.signal, exactRevision: true })
      if (!current()) return false
      link.revision = receipt.revision
      link.base = initial
      link.initial = undefined
      this.report(link, 'saved')
      return true
    }

    const view = this.view?.id === link.id ? this.view : undefined, base = link.base
    if (!base) return false
    const local = view ? view.read() : link.durable
    if (link.incoming) {
      if (!local || !view) return false
      const { expected, document } = link.incoming
      const later = workspacePatch(expected, local)
      if (hasWorkspaceChanges(later) && workspacePatchesConflict(later, workspacePatch(expected, document)))
        throw new BackendError(409, conflictMessage)
      const next = applyWorkspacePatch(document, later)
      const installed = hasWorkspaceChanges(workspacePatch(local, next))
        ? await view.install(local, next, AbortSignal.any([lifetime.signal, view.lifetime.signal])) : local
      if (!current() || this.view !== view || !installed) return false
      link.incoming = undefined
      if (link.durable === local) link.durable = undefined
      if (!hasWorkspaceChanges(later) || !hasWorkspaceChanges(workspacePatch(document, installed))) link.base = installed
      this.report(link, 'saved')
      return true
    }

    if (!link.pending && local) {
      if (link.durable === local) link.durable = undefined
      const patch = local === base ? undefined : workspacePatch(base, local)
      if (patch && hasWorkspaceChanges(patch)) link.pending = { document: local, patch, requestId: crypto.randomUUID() }
    }
    if (link.pending) {
      const pending = link.pending
      this.report(link, 'saving')
      const receipt = await backend.edit(link.id, link.revision, pending.requestId, pending.patch, lifetime.signal)
      if (!current()) return false
      link.pending = undefined
      link.revision = receipt.revision
      link.base = receipt.merged?.document ?? pending.document
      if (receipt.merged) link.incoming = { expected: pending.document, document: receipt.merged.document }
      else this.report(link, 'saved')
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
      link.revision = next.revision
      link.base = next.document
      link.incoming = { expected: local, document: next.document }
      return true
    } catch (error) {
      if (signal.aborted) return false
      throw error
    }
  }
}
