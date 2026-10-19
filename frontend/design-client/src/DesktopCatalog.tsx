import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { File, FolderOpen, RefreshCw } from 'lucide-react'
import { modalKeyDown } from './modal-keyboard'
import type { CatalogDirectory, CatalogFile, CatalogProject, DesktopBridge, DesktopResult } from './desktop'

type Catalog = { projects: CatalogProject[]; directories: CatalogDirectory[]; files: CatalogFile[] }
const emptyCatalog: Catalog = { projects: [], directories: [], files: [] }
function checked<T>(result: DesktopResult<T>): (T & { status: 'ok' }) | undefined {
  if (result.status === 'cancelled') return undefined
  if (result.status !== 'ok') throw new Error(`${result.message} (${result.code})`)
  return result
}

/** Metadata browsing never grants disk authority or replaces the active document itself. */
export function DesktopCatalog({ bridge, onOpen, onClose, disabled = false, suspended = false }: {
  bridge: DesktopBridge
  onOpen: (request: { directoryHandle: string; fileId: string }) => Promise<boolean>
  onClose: () => void
  disabled?: boolean
  suspended?: boolean
}) {
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanned, setScanned] = useState<Record<string, string>>({})
  const generation = useRef(0)
  const active = useRef(false)
  const mounted = useRef(false)
  const close = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const current = (ticket: number) => mounted.current && generation.current === ticket
  async function run(action: (ticket: number) => Promise<void>) {
    if (active.current || !mounted.current || disabled) return
    active.current = true
    const ticket = ++generation.current
    setBusy(true); setError(''); setNotice('')
    try { await action(ticket) } catch (cause) {
      if (current(ticket)) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (current(ticket)) { active.current = false; setBusy(false) }
    }
  }
  async function refresh(ticket: number) {
    const result = checked(await bridge.listCatalog())
    if (!result || !current(ticket)) return
    setCatalog(result)
    setScanned({})
    setSelected((id) => result.directories.some((directory) => directory.id === id) ? id : result.directories[0]?.id || '')
  }
  async function scan(directory: CatalogDirectory, ticket: number) {
    if (!directory.directoryHandle || directory.requiresReselection) throw new Error('请通过系统对话框重新选择此目录，以恢复本次会话的访问授权。')
    // Even a failed rescan invalidates this panel's previous open eligibility.
    setScanned((old) => { const next = { ...old }; delete next[directory.id]; return next })
    const result = checked(await bridge.scanCatalogDirectory({ directoryHandle: directory.directoryHandle }))
    if (!result || !current(ticket)) return
    if (result.directoryId !== directory.id) throw new Error('扫描响应与所选目录不一致，请重新选择目录。')
    setCatalog((old) => ({ ...old, files: [...old.files.filter((file) => file.directoryId !== directory.id), ...result.files] }))
    setScanned((old) => ({ ...old, [directory.id]: directory.directoryHandle! }))
    setNotice(result.truncated ? '目录扫描已达到上限，仅显示部分设计文件。' : `扫描完成：${result.files.length} 个设计文件`)
  }
  useLayoutEffect(() => {
    const previous = document.activeElement, dialog = panel.current
    close.current?.focus()
    return () => { if (dialog?.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    mounted.current = true
    void run(refresh)
    return () => {
      mounted.current = false; generation.current++; active.current = false
    }
  }, [bridge])
  const directory = catalog.directories.find((item) => item.id === selected)
  const authorized = !!directory?.directoryHandle && !directory.requiresReselection
  const canOpen = authorized && scanned[selected] === directory?.directoryHandle
  const files = catalog.files.filter((file) => file.directoryId === selected)
  const blocked = busy || disabled
  return <div className="modal-backdrop" style={suspended ? { display: 'none' } : undefined}>
    <section ref={panel} className="remote-modal desktop-catalog" role="dialog" aria-modal="true" aria-labelledby="desktop-catalog-title" aria-busy={busy}
      tabIndex={-1} onKeyDown={(event) => modalKeyDown(event, () => { if (!blocked) onClose() })}>
      <h2 id="desktop-catalog-title">本机项目目录<button type="button" ref={close} disabled={blocked} aria-label="关闭项目目录" onClick={onClose}>×</button></h2>
      <p className="dialog-description">从本机文件夹浏览设计文件。首次访问或授权失效时，重新选择文件夹即可。</p>
      <div className="remote-actions">
        <button type="button" className="primary" disabled={blocked} onClick={() => void run(async (ticket) => {
          const result = checked(await bridge.selectCatalogDirectory())
          if (!result || !current(ticket)) return
          await refresh(ticket)
          if (!current(ticket)) return
          setCatalog((old) => ({
            projects: [...old.projects.filter((item) => item.id !== result.project.id), result.project],
            directories: [...old.directories.filter((item) => item.id !== result.directory.id), result.directory],
            files: old.files,
          }))
          setSelected(result.directory.id)
          await scan(result.directory, ticket)
        })}><FolderOpen size={15} aria-hidden="true" />选择 / 重新授权目录</button>
        <button type="button" className="secondary" disabled={blocked} onClick={() => void run(refresh)}><RefreshCw size={14} aria-hidden="true" />刷新目录索引</button>
      </div>
      {!catalog.directories.length && !busy && <div className="library-empty"><FolderOpen size={30} aria-hidden="true" /><strong>添加你的项目文件夹</strong><p>选择本机目录后，在这里浏览与打开 .fd 设计文件。</p></div>}
      {!!catalog.directories.length && <label className="catalog-directory">项目 / 目录 <select aria-label="项目目录" value={selected} disabled={blocked} onChange={(event) => { setSelected(event.target.value); setError(''); setNotice('') }}>
        {catalog.directories.map((item) => <option key={item.id} value={item.id}>{catalog.projects.find((project) => project.id === item.projectId)?.name || '本机项目'} / {item.displayName}</option>)}
      </select></label>}
      {directory && <>
        {!authorized && <p role="status">此目录需要重新选择授权。保存的目录记录不能直接访问文件。</p>}
        {authorized && !canOpen && <p>请先扫描目录，核实本次会话中可打开的设计文件。</p>}
        <div className="library-section-heading"><strong>设计文件 <span>{files.length}</span></strong><button type="button" className="secondary" disabled={blocked || !authorized} onClick={() => void run((ticket) => scan(directory, ticket))}><RefreshCw size={13} aria-hidden="true" />扫描设计文件</button></div>
        {!files.length && !busy && <div className="library-empty"><File size={28} aria-hidden="true" /><strong>暂无已索引的 .fd 文件</strong><p>扫描文件夹以查看其中的设计文件。</p></div>}
        <div className="catalog-file-list">
          {files.map((file) => <div className="local-file-row" key={file.id}>
            <button type="button" disabled={blocked || !canOpen} onClick={() => void run(async (ticket) => {
              const opened = await onOpen({ directoryHandle: directory.directoryHandle!, fileId: file.id })
              if (!current(ticket)) return
              if (opened) onClose()
              else setNotice('未完成打开，请查看底部文件状态。若目录授权已失效，请重新选择目录；文件变动后请重新扫描。')
            })}><File size={17} className="library-file-icon" aria-hidden="true" /><span className="library-file-name">{file.relativePath}</span></button>
            <span className="library-file-size">{Math.ceil(file.size / 1024)} KiB</span>
          </div>)}
        </div>
      </>}
      {busy && <p role="status">正在处理本机目录…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error} 目录丢失或授权失效时，请重新选择目录。</p>}
    </section>
  </div>
}
