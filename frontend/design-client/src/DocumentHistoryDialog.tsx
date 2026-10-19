import { useEffect, useMemo, useState } from 'react'
import type { DesignDocument } from './model'
import type { DesktopSession } from './desktop-session'
import { createDocumentHistory, type HistoryEntry } from './document-history'
import { scene } from './geometry'
import { KernelSurface } from './kernel/Surface'

/**
 * The local revision history panel. The list, read-only snapshot preview and
 * restore all go through the single document-history API, which routes to the
 * desktop sidecar (SQLite) or the browser (IndexedDB) behind one interface.
 */
export function DocumentHistoryDialog({
  session,
  documentId,
  documentName,
  unsaved,
  onLocalAdopt,
  onClose,
}: {
  session?: DesktopSession | null
  documentId: string
  documentName: string
  unsaved: boolean
  onLocalAdopt: (record: { document: DesignDocument; revision: number }) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const history = useMemo(() => createDocumentHistory(session), [session])
  const [page, setPage] = useState<{
    entries: HistoryEntry[]
    hasMore: boolean
    nextBeforeRevision?: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ document: DesignDocument; revision: number } | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const desktop = history.route === 'desktop'
  const headRevision = page?.entries[0]?.revision

  async function guarded(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let alive = true
    history
      .list(documentId)
      .then((result) => {
        if (alive) setPage(result)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [documentId, history])

  function requestRestore(revision: number) {
    if (busy) return
    // The desktop session runs its own leave dialog before restoring; only the
    // browser path needs an in-panel confirmation for unsaved edits.
    if (!desktop && unsaved) {
      setPending(revision)
      return
    }
    void performRestore(revision)
  }
  async function performRestore(revision: number) {
    if (desktop) onClose()
    const result = await history.restore(documentId, revision)
    if (!result) return
    if (!result.adopted && !(await onLocalAdopt(result)))
      throw new Error('历史版本已恢复到本机存储；当前画布已保留，可重新打开查看')
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy && pending === null) onClose()
      }}
    >
      <section className="remote-modal" role="dialog" aria-modal="true" aria-label="历史版本">
        <h2>
          历史版本
          <button aria-label="关闭历史版本" disabled={busy} onClick={onClose}>
            ×
          </button>
        </h2>
        <p>
          「{documentName}」的历史版本保存在{desktop ? '本机文档库' : '本机浏览器'}，断网也可查看；恢复会创建新版本，不会覆盖现有历史。
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="remote-actions">
          <button
            disabled={busy}
            onClick={() =>
              void guarded(async () => {
                const result = await history.list(documentId)
                setPage(result)
                setPreview(null)
                setPending(null)
              })
            }
          >
            刷新
          </button>
        </div>
        <section className="remote-list" aria-label="历史版本列表">
          {page?.entries.map((entry) => (
            <div className="local-file-row" key={entry.revision}>
              <span>
                版本 {entry.revision} · {entry.summary ?? '自动保存'} ·{' '}
                {new Date(entry.createdAt).toLocaleString()}
              </span>
              <button
                disabled={busy}
                aria-label={`预览版本 ${entry.revision}`}
                onClick={() =>
                  void guarded(async () => {
                    const snapshot = await history.load(documentId, entry.revision)
                    if (!snapshot) throw new Error(`历史版本 r${entry.revision} 已不存在，请刷新列表`)
                    setPreview({ document: snapshot.document, revision: entry.revision })
                  })
                }
              >
                预览
              </button>
              <button
                disabled={busy || entry.revision === headRevision}
                aria-label={`恢复版本 ${entry.revision}`}
                onClick={() => requestRestore(entry.revision)}
              >
                恢复此版本
              </button>
            </div>
          ))}
          {page && !page.entries.length && <p>此设计还没有保存过历史版本；保存后会自动记录。</p>}
          {page?.hasMore && page.nextBeforeRevision !== undefined && (
            <button
              disabled={busy}
              onClick={() =>
                void guarded(async () => {
                  const older = await history.list(documentId, page.nextBeforeRevision)
                  setPage({
                    entries: [...page.entries, ...older.entries],
                    hasMore: older.hasMore,
                    nextBeforeRevision: older.hasMore ? older.nextBeforeRevision : undefined,
                  })
                })
              }
            >
              加载更早版本
            </button>
          )}
        </section>
        {pending !== null && (
          <div role="alertdialog" aria-label="确认恢复历史版本">
            <p>当前有未保存的修改；恢复版本 r{pending} 会丢弃这些修改（已保存的历史不受影响）。</p>
            <div className="remote-actions">
              <button
                className="primary"
                onClick={() => {
                  const revision = pending
                  setPending(null)
                  void guarded(() => performRestore(revision))
                }}
              >
                丢弃修改并恢复
              </button>
              <button onClick={() => setPending(null)}>保留修改，取消恢复</button>
            </div>
          </div>
        )}
      </section>
      {preview && (
        <RevisionPreview
          document={preview.document}
          revision={preview.revision}
          busy={busy}
          onExit={() => setPreview(null)}
          onRestore={() => {
            const revision = preview.revision
            setPreview(null)
            requestRestore(revision)
          }}
        />
      )}
    </div>
  )
}

/** Read-only snapshot preview: renders through the shared kernel surface, never the editor. */
function RevisionPreview({
  document,
  revision,
  busy,
  onExit,
  onRestore,
}: {
  document: DesignDocument
  revision: number
  busy: boolean
  onExit: () => void
  onRestore: () => void
}) {
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '')
  const active = document.pages.find((p) => p.id === pageId) ?? document.pages[0]
  const frame = useMemo(() => {
    const bounds = scene(document, active.id).map((entry) => entry.bounds)
    if (!bounds.length) return { x: 0, y: 0, width: 800, height: 600 }
    const x = Math.min(...bounds.map((b) => b.x)),
      y = Math.min(...bounds.map((b) => b.y))
    return {
      x,
      y,
      width: Math.max(1, Math.max(...bounds.map((b) => b.x + b.width)) - x),
      height: Math.max(1, Math.max(...bounds.map((b) => b.y + b.height)) - y),
    }
  }, [document, active.id])
  const zoom = Math.min(1, 960 / frame.width, 600 / frame.height),
    width = Math.ceil(frame.width * zoom),
    height = Math.ceil(frame.height * zoom)
  return (
    <div
      className="feature-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onExit()
      }}
    >
      <div className="prototype-player" data-history-preview role="dialog" aria-modal="true" aria-label="历史版本只读预览">
        <header>
          <strong>
            只读预览 · 版本 {revision} · {document.name}
          </strong>
          {document.pages.length > 1 &&
            document.pages.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={p.id === active.id}
                aria-label={`预览页面 ${p.name}`}
                onClick={() => setPageId(p.id)}
              >
                {p.name}
              </button>
            ))}
          <button type="button" disabled={busy} onClick={onRestore}>
            恢复此版本
          </button>
          <button type="button" onClick={onExit}>
            退出预览
          </button>
        </header>
        <div style={{ overflow: 'auto', width, height, position: 'relative', background: '#fff' }}>
          <KernelSurface
            document={document}
            pageId={active.id}
            width={width}
            height={height}
            view={{ x: -frame.x * zoom, y: -frame.y * zoom, zoom }}
            grid={false}
          />
        </div>
      </div>
    </div>
  )
}
