import { useEffect, useMemo, useRef, useState } from 'react'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { confirmRestoreBody, diffHeading, historyStorageIntro, historyVersionLine, previewPageLabel, readOnlyPreviewTitle, revisionActionLabel, translateChangeKind, translateDiffField, translateGeneratedDiffValue, useProfessionalDialogText } from './professional-dialog-messages'
import type { DesignDocument } from './model'
import type { DesktopSession } from './desktop-session'
import { createDocumentHistory, type HistoryEntry } from './document-history'
import { diffDocuments, changeLabels, type DocumentChange } from './document-diff'
import { scene } from './geometry'
import { userPages } from './fig-document'
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
  beforeLocalRestore,
  onClose,
}: {
  session?: DesktopSession | null
  documentId: string
  documentName: string
  unsaved: boolean
  beforeLocalRestore?: () => (() => boolean)
  onLocalAdopt: (record: { document: DesignDocument; revision: number }) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const { locale, tr } = useProfessionalDialogText()
  const history = useMemo(() => createDocumentHistory(session), [session])
  const [page, setPage] = useState<{
    entries: HistoryEntry[]
    hasMore: boolean
    nextBeforeRevision?: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [diff, setDiff] = useState<{ from: number; to: number; changes: DocumentChange[] } | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ document: DesignDocument; revision: number } | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const dismiss = () => { if (!busyRef.current && pending === null) onClose() }
  useModalOwnership(backdrop, closeButton)
  const desktop = history.route === 'desktop'
  const headRevision = page?.entries[0]?.revision

  async function guarded(work: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
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
    if (busyRef.current || headRevision === undefined) return
    // The desktop session runs its own leave dialog before restoring; only the
    // browser path needs an in-panel confirmation for unsaved edits.
    if (!desktop && unsaved) {
      setPending(revision)
      return
    }
    void guarded(() => performRestore(revision))
  }
  async function performRestore(revision: number) {
    const isCurrent = !desktop ? beforeLocalRestore?.() : undefined
    if (desktop) onClose()
    const result = await history.restore(documentId, revision, headRevision)
    if (!result) return
    if (!result.adopted && ((isCurrent && !isCurrent()) || !(await onLocalAdopt(result))))
      throw new Error('历史版本已恢复到本机存储；当前画布已保留，可重新打开查看')
    onClose()
  }

  return (
    <div ref={backdrop} className="modal-backdrop" onKeyDown={event => modalKeyDown(event, dismiss)}>
      <section className="remote-modal" role="dialog" aria-modal="true" aria-label={tr('历史版本')} tabIndex={-1}>
        <h2>
          {tr('历史版本')}
          <button ref={closeButton} type="button" aria-label={tr('关闭历史版本')} disabled={busy} onClick={onClose}>
            ×
          </button>
        </h2>
        <p>
          {historyStorageIntro(documentName, desktop, locale)}
        </p>
        {!desktop && <p>{tr('浏览器本地保留最近 50 个已保存版本。')}</p>}
        {error && <p role="alert">{tr(error)}</p>}
        <div className="remote-actions">
          <button
            disabled={busy}
            onClick={() =>
              void guarded(async () => {
                const result = await history.list(documentId)
                setPage(result)
                setPreview(null)
                setDiff(null)
                setPending(null)
              })
            }
          >
            {tr('刷新')}
          </button>
        </div>
        <section className="remote-list" aria-label={tr('历史版本列表')}>
          {page?.entries.map((entry, index) => (
            <div className="local-file-row" key={entry.revision}>
              <span>
                {historyVersionLine(entry.revision, entry.summary, new Date(entry.createdAt).toLocaleString(), locale)}
              </span>
              <button
                disabled={busy}
                aria-label={revisionActionLabel('预览版本', entry.revision, locale)}
                onClick={() =>
                  void guarded(async () => {
                    const snapshot = await history.load(documentId, entry.revision)
                    if (!snapshot) throw new Error(`历史版本 r${entry.revision} 已不存在，请刷新列表`)
                    setPreview({ document: snapshot.document, revision: entry.revision })
                  })
                }
              >
                {tr('预览')}
              </button>
              <button
                disabled={busy || !page.entries[index + 1]}
                aria-label={revisionActionLabel('比较版本', entry.revision, locale)}
                onClick={() => void guarded(async () => {
                  const previous = page.entries[index + 1]
                  const [before, after] = await Promise.all([history.load(documentId, previous.revision), history.load(documentId, entry.revision)])
                  if (!before || !after) throw new Error('版本已不存在，请刷新列表')
                  setDiff({ from: before.revision, to: after.revision, changes: diffDocuments(before.document, after.document) })
                })}
              >{tr('与上一版本比较')}</button>
              <button
                disabled={busy || entry.revision === headRevision}
                aria-label={revisionActionLabel('恢复版本', entry.revision, locale)}
                onClick={() => requestRestore(entry.revision)}
              >
                {tr('恢复此版本')}
              </button>
            </div>
          ))}
          {page && !page.entries.length && <p>{tr('此设计还没有保存过历史版本；保存后会自动记录。')}</p>}
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
              {tr('加载更早版本')}
            </button>
          )}
        </section>
        {diff && <section aria-label={tr('版本差异')} style={{ maxHeight: 320, overflow: 'auto' }}>
          <h3>{diffHeading(diff.from, diff.to, diff.changes.length, locale)}</h3>
          <p>{tr('按稳定图层 ID 比较已保存快照；资源内容不展开。恢复与撤销编辑独立，会建立新的保存版本。')}</p>
          {!diff.changes.length && <p>{tr('没有内容变化')}</p>}
          <ul>{diff.changes.slice(0, 500).map((change, index) => <li key={index}>
            {translateChangeKind(changeLabels[change.kind], locale)} · {change.name} · {translateDiffField(change.field, locale)} <small>({change.id})</small>
            {change.before !== undefined && <>：{translateGeneratedDiffValue(change.field, change.before, locale)} → {translateGeneratedDiffValue(change.field, change.after, locale)}</>}
          </li>)}</ul>
          {diff.changes.length > 500 && <p>{tr('仅显示前 500 项变化，请分版本查看。')}</p>}
          <button onClick={() => setDiff(null)}>{tr('关闭差异')}</button>
        </section>}
        {pending !== null && (
          <div role="alertdialog" aria-label={tr('确认恢复历史版本')}>
            <p>{confirmRestoreBody(pending, locale)}</p>
            <div className="remote-actions">
              <button
                disabled={busy}
                className="primary"
                onClick={() => {
                  const revision = pending
                  setPending(null)
                  void guarded(() => performRestore(revision))
                }}
              >
                {tr('丢弃修改并恢复')}
              </button>
              <button disabled={busy} onClick={() => setPending(null)}>{tr('保留修改，取消恢复')}</button>
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
          locale={locale}
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
  locale,
  onExit,
  onRestore,
}: {
  document: DesignDocument
  revision: number
  busy: boolean
  locale: 'zh-CN' | 'en'
  onExit: () => void
  onRestore: () => void
}) {
  const { tr } = useProfessionalDialogText()
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '')
  const backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useModalOwnership(backdrop, closeButton)
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
    <div ref={backdrop} className="feature-backdrop" onKeyDown={event => modalKeyDown(event, () => { if (!busy) onExit() })}>
      <div className="prototype-player" data-history-preview role="dialog" aria-modal="true" aria-label={tr('历史版本只读预览')} tabIndex={-1}>
        <header>
          <strong>
            {readOnlyPreviewTitle(revision, document.name, locale)}
          </strong>
          {document.pages.length > 1 &&
            userPages(document).map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={p.id === active.id}
                aria-label={previewPageLabel(p.name, locale)}
                onClick={() => setPageId(p.id)}
              >
                {p.name}
              </button>
            ))}
          <button type="button" disabled={busy} onClick={onRestore}>
            {tr('恢复此版本')}
          </button>
          <button ref={closeButton} type="button" onClick={onExit}>
            {tr('退出预览')}
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
