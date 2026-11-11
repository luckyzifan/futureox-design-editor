import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { modalKeyDown } from './modal-keyboard'
import type { RemoteDocument } from './persistence'
import type { WebWorkspace, WebWorkspaceStatus } from './web-workspace'

export function WebWorkspacePanel({ workspace, status, documentId, canSync, locale, onOpen, onSync, onClose }: {
  workspace: WebWorkspace
  status: WebWorkspaceStatus
  documentId: string
  canSync: boolean
  locale: 'zh-CN' | 'en'
  onOpen: (record: RemoteDocument) => Promise<boolean>
  onSync: () => Promise<void>
  onClose: () => void
}) {
  const english = locale === 'en'
  const heading = useId(), panel = useRef<HTMLElement>(null), tokenInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Omit<RemoteDocument, 'document'>[]>([])
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [lifetime] = useState(() => new AbortController())
  const working = useRef(false)
  const title = english ? 'Server workspace' : '服务器工作区'
  const current = status.documentId === documentId ? status : undefined

  useLayoutEffect(() => {
    const previous = document.activeElement, dialog = panel.current
    ;(tokenInput.current ?? dialog)?.focus()
    return () => {
      if (dialog?.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (status.connected) void action(async () => { setFiles(await workspace.list(lifetime.signal)) })
    return () => lifetime.abort()
  }, [workspace])

  async function action(work: () => Promise<void>) {
    if (working.current || lifetime.signal.aborted) return
    working.current = true; setBusy(true); setError('')
    try { await work() }
    catch (value) { if (!lifetime.signal.aborted) setError(value instanceof Error ? value.message : String(value)) }
    finally { working.current = false; if (!lifetime.signal.aborted) setBusy(false) }
  }

  return <div className="modal-backdrop">
    <section ref={panel} className="remote-modal workspace-library" role="dialog" aria-modal="true" aria-labelledby={heading}
      aria-busy={busy} tabIndex={-1} onKeyDown={event => modalKeyDown(event, () => { if (!busy) onClose() })}>
      <h2><span id={heading}>{title}</span><button type="button" aria-label={english ? 'Close server workspace' : '关闭服务器工作区'} disabled={busy} onClick={onClose}>×</button></h2>
      {!status.connected ? <form className="remote-actions" onSubmit={event => {
        event.preventDefault()
        void action(async () => { setFiles(await workspace.connect(token, lifetime.signal)); setToken('') })
      }}>
        <label>{english ? 'Access token' : '访问令牌'} <input ref={tokenInput} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
        <button type="submit" disabled={busy || !token.trim()}>{english ? 'Connect' : '连接'}</button>
      </form> : <>
        <div className="remote-actions">
          <button type="button" disabled={busy || !canSync} onClick={() => void action(onSync)}>{english ? 'Sync current design' : '同步当前设计'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void action(async () => { setFiles(await workspace.list(lifetime.signal)) })}>{english ? 'Refresh' : '刷新'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => { workspace.disconnect(); setFiles([]); setError('') }}>{english ? 'Disconnect' : '断开'}</button>
        </div>
        {current?.phase === 'saving' && <p role="status">{english ? 'Syncing to server…' : '正在同步到服务器…'}</p>}
        {current?.phase === 'saved' && <p role="status">{english ? 'Synced to server' : '已同步到服务器'}</p>}
        <div className="remote-list">
          {files.map(file => <div className="local-file-row" key={file.id}>
            <button type="button" disabled={busy} onClick={() => void action(async () => {
              const remote = await workspace.open(file.id, lifetime.signal)
              if (await onOpen(remote)) onClose()
              else throw new Error(english ? 'The current design was kept.' : '当前设计已保留')
            })}>{file.name}</button>
            <span>r{file.revision}</span>
          </div>)}
          {!files.length && <p>{english ? 'No server designs' : '服务器暂无设计'}</p>}
        </div>
      </>}
      {(error || current?.error) && <p role="alert">{error || current?.error}</p>}
    </section>
  </div>
}
