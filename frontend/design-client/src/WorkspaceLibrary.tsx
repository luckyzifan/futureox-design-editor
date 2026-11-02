import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { History, RefreshCw, Search, Trash2 } from 'lucide-react'
import { FileMark } from './chrome-icons'
import type { DesktopSession } from './desktop-session'
import type { WorkspaceDocument } from './desktop'
import { modalKeyDown } from './modal-keyboard'

export function WorkspaceLibrary({ session, onClose }: { session: DesktopSession; onClose: () => void }) {
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([])
  const [history, setHistory] = useState<{ document: WorkspaceDocument; revisions: WorkspaceDocument[]; nextBeforeRevision?: number } | null>(null)
  const [query, setQuery] = useState(''), [trash, setTrash] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const panel = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), heading = useId()
  const visibleDocuments = documents.filter(d => d.deleted === trash && d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  useLayoutEffect(() => {
    const previous = document.activeElement, dialog = panel.current
    search.current?.focus()
    return () => { if (dialog?.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  const refresh = async () => {
    const result = await session.listWorkspace(true)
    if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '读取已取消' : result.message)
    setDocuments(result.documents)
  }
  useEffect(() => { let alive = true; session.listWorkspace(true).then(r => {
    if (!alive) return
    if (r.status === 'ok') setDocuments(r.documents)
    else if (r.status !== 'cancelled') setError(r.message)
  }).catch(e => { if (alive) setError(String(e)) }); return () => { alive = false } }, [session])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop">
    <section ref={panel} className="remote-modal workspace-library" role="dialog" aria-modal="true" aria-labelledby={heading} aria-busy={busy}
      tabIndex={-1} onKeyDown={event => modalKeyDown(event, () => { if (!busy) onClose() })}>
      <h2 id={heading}>本机文档库<button type="button" aria-label="关闭本机文档库" disabled={busy} onClick={onClose}>×</button></h2>
      <p className="dialog-description">设计与历史版本保存在本机，断网也可继续编辑。</p>
      <div className="remote-actions">
        <label className="library-search"><Search size={15} aria-hidden="true" /><input ref={search} aria-label="搜索本机设计" placeholder="搜索设计名称" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button type="button" className="secondary" aria-pressed={trash} disabled={busy} onClick={() => { setTrash(v => !v); setHistory(null) }}><Trash2 size={14} aria-hidden="true" />{trash ? '全部设计' : '回收站'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void action(refresh)}><RefreshCw size={14} aria-hidden="true" />刷新</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="library-section-heading"><strong>{trash ? '回收站' : '最近的设计'} <span>{visibleDocuments.length}</span></strong><span>{busy ? '正在处理…' : '本机存储'}</span></div>
      <div className="remote-list">
        {visibleDocuments.map(d => <div className="local-file-row" key={d.id}>
          <button type="button" disabled={busy || d.deleted} onClick={() => void action(async () => { if (await session.openWorkspace(d.id)) onClose(); else throw new Error(session.status.error || '当前设计已保留') })}>
            <span className="library-file-icon"><FileMark name={d.name} size={22} /></span><span className="library-file-name"><b>{d.name}</b><small>版本 {d.revision} · {new Date(d.updatedAt).toLocaleString()}</small></span>
          </button>
          <button type="button" className="library-row-action" disabled={busy} onClick={() => void action(async () => {
            const r = await session.listRevisions(d.id)
            if (r.status !== 'ok') throw new Error(r.status === 'cancelled' ? '已取消' : r.message)
            setHistory({ document: d, revisions: r.revisions, nextBeforeRevision: r.hasMore ? r.nextBeforeRevision : undefined })
          })}><History size={14} aria-hidden="true" />历史版本</button>
          <button type="button" className="library-row-action" disabled={busy || d.id === session.activeDocumentId} title={d.id === session.activeDocumentId ? '正在编辑的设计' : undefined} onClick={() => void action(async () => {
            const r = await session.trashWorkspace(d, !d.deleted)
            if (r.status !== 'ok') throw new Error(r.status === 'cancelled' ? '已取消' : r.message)
            await refresh()
          })}>{d.deleted ? '恢复' : '移入回收站'}</button>
        </div>)}
        {!visibleDocuments.length && <div className="library-empty">{query ? <Search size={30} aria-hidden="true" /> : trash ? <Trash2 size={30} aria-hidden="true" /> : <File size={30} aria-hidden="true" />}<strong>{query ? '没有匹配的设计' : trash ? '回收站为空' : '你的设计从这里开始'}</strong><p>{query ? '试试其他名称，或清空搜索。' : trash ? '移入回收站的设计可以在这里恢复。' : '编辑设计后会自动保存到这里。'}</p></div>}
      </div>
      {history && <section className="library-history" aria-label="文档历史版本"><h3>{history.document.name} · 历史版本</h3>
        <p>恢复会创建新版本，保留现有历史。</p>
        {history.revisions.map(r => <div className="local-file-row" key={r.revision}><span>版本 {r.revision} · {new Date(r.updatedAt).toLocaleString()}</span>
          <button type="button" disabled={busy || r.revision === history.document.revision} onClick={() => void action(async () => {
            if (await session.restoreWorkspace(history.document.id, r.revision, history.document.revision)) onClose()
            else throw new Error(session.status.error || '当前设计已保留')
          })}>恢复此版本</button></div>)}
        {history.nextBeforeRevision !== undefined && <button type="button" disabled={busy} onClick={() => void action(async () => {
          const r = await session.listRevisions(history.document.id, history.nextBeforeRevision)
          if (r.status !== 'ok') throw new Error(r.status === 'cancelled' ? '已取消' : r.message)
          setHistory({ ...history, revisions: [...history.revisions, ...r.revisions], nextBeforeRevision: r.hasMore ? r.nextBeforeRevision : undefined })
        })}>加载更早版本</button>}
      </section>}
    </section>
  </div>
}
