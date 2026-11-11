import type { DesignDocument } from './model'
import { Backend, BackendError, type RemoteDocument } from './persistence'

export type WebWorkspaceStatus = {
  connected: boolean
  documentId?: string
  phase?: 'saving' | 'saved' | 'error'
  error?: string
}

type Connection = {
  backend: Backend
  lifetime: AbortController
  revisions: Map<string, number>
  pending: Map<string, DesignDocument>
  conflicts: Set<string>
  writer?: Promise<void>
  writing?: DesignDocument
}

/** A server workspace mirrors only explicitly linked, locally durable edits. */
export class WebWorkspace {
  private connection?: Connection

  constructor(private readonly publish: (status: WebWorkspaceStatus) => void) {}

  async connect(token: string, signal: AbortSignal) {
    const backend = new Backend()
    backend.token = token.trim()
    if (!backend.token) throw new Error('请输入工作空间访问令牌')
    const list = await backend.list(signal)
    signal.throwIfAborted()
    this.connection?.lifetime.abort()
    this.connection = { backend, lifetime: new AbortController(), revisions: new Map(), pending: new Map(), conflicts: new Set() }
    this.publish({ connected: true })
    return list
  }

  disconnect() {
    this.connection?.lifetime.abort()
    this.connection = undefined
    this.publish({ connected: false })
  }

  private connected() {
    if (!this.connection) throw new Error('请先连接服务器工作区')
    return this.connection
  }

  list(signal: AbortSignal) {
    const connection = this.connected()
    return connection.backend.list(AbortSignal.any([signal, connection.lifetime.signal]))
  }

  async open(id: string, signal: AbortSignal) {
    const connection = this.connected()
    await connection.writer
    return connection.backend.get(id, AbortSignal.any([signal, connection.lifetime.signal]))
  }

  link(record: RemoteDocument) {
    const connection = this.connected()
    connection.revisions.set(record.id, record.revision)
    connection.conflicts.delete(record.id)
    this.publish({ connected: true, documentId: record.id, phase: 'saved' })
  }

  sync(document: DesignDocument) {
    const connection = this.connected()
    if (connection.conflicts.has(document.id)) throw new BackendError(409, '服务器版本已变化，请先打开最新版本或保存为副本')
    if (!connection.revisions.has(document.id)) connection.revisions.set(document.id, 0)
    this.localSaved(document)
  }

  localSaved(document: DesignDocument) {
    const connection = this.connection
    if (!connection?.revisions.has(document.id) || connection.conflicts.has(document.id)) return
    if (connection.writing === document || connection.pending.get(document.id) === document) return
    connection.pending.set(document.id, document)
    this.publish({ connected: true, documentId: document.id, phase: 'saving' })
    connection.writer ??= Promise.resolve().then(() => this.write(connection))
  }

  private async write(connection: Connection) {
    const { pending, revisions, conflicts, backend, lifetime } = connection
    try {
      for (const [id, document] of pending) {
        if (lifetime.signal.aborted) return
        pending.delete(id)
        connection.writing = document
        try {
          const receipt = await backend.save(document, revisions.get(id)!, { signal: lifetime.signal, exactRevision: true })
          if (lifetime.signal.aborted) return
          revisions.set(id, receipt.revision)
          if (!pending.has(id)) this.publish({ connected: true, documentId: id, phase: 'saved' })
        } catch (error) {
          if (lifetime.signal.aborted) return
          if (error instanceof BackendError && error.status === 409) conflicts.add(id)
          pending.delete(id)
          this.publish({ connected: true, documentId: id, phase: 'error', error: error instanceof Error ? error.message : String(error) })
        } finally {
          connection.writing = undefined
        }
      }
    } finally {
      connection.writer = undefined
    }
  }
}
