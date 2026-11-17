import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search } from 'lucide-react'
import type { Editor } from './engine'
import { type UiMode, useInterfacePreferences, useInterfaceText } from './interface-preference'
import { commitPendingEdits } from './pending-edits'
import { modalKeyDown } from './modal-keyboard'
import { userPages } from './fig-document'
import { requestAgentTarget } from './design-ai/target-event'
import { clampAnchoredMenu } from './anchored-menu'
import './design-ai/design-agent.css'

export function PageList({ editor, onRename, layerDropPage }: { editor: Editor; onRename: (id: string) => void; layerDropPage?: string }) {
  const text = useInterfaceText()
  const { locale, uiMode } = useInterfacePreferences()
  const listId = useId()
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const [collapsed, setCollapsed] = useState<Record<UiMode, boolean>>({ figma: true, sketch: false })
  const [paneHeight, setPaneHeight] = useState<Record<UiMode, number>>({ figma: 209, sketch: 118 })
  const open = !collapsed[uiMode]
  const pane = useRef<HTMLElement>(null), list = useRef<HTMLElement>(null)
  const drag = useRef<{ mode: UiMode; pointer: number; y: number; height: number } | null>(null)
  const [hoverPage, setHoverPage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterInput = useRef<HTMLInputElement>(null), filterToggle = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ id: string; session: number; document: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ id: string; session: number; document: string } | null>(null)
  const valid = (value: { session: number; document: string }) => value.session === editor.sessionGeneration && value.document === editor.state.doc.id
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    const blur = () => setMenu(null)
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur) }
  }, [menu])
  useEffect(() => { setMenu(null); dragging.current = null }, [editor.sessionGeneration, state.doc.id])
  useEffect(() => {
    if (open && filterOpen && uiMode === 'figma') filterInput.current?.focus()
  }, [open, filterOpen, uiMode])
  useEffect(() => {
    const scroll = list.current, active = scroll?.querySelector('[aria-current="page"]')
    if (!open || !scroll || !active) return
    const bounds = scroll.getBoundingClientRect(), row = active.getBoundingClientRect()
    if (row.top < bounds.top) scroll.scrollTop += row.top - bounds.top
    else if (row.bottom > bounds.bottom) scroll.scrollTop += row.bottom - bounds.bottom
  }, [open, state.page, state.doc.id, uiMode])
  // Page topology cannot change underneath a captured Canvas transaction.
  // Recheck at the action boundary: begin() may not emit a React update yet.
  const canMutatePages = () => !editor.interactionActive && !editor.state.busy
  const action = (fn: (id: string) => void, mutatesPages = false) => {
    if (menu && valid(menu) && (!mutatesPages || canMutatePages()) && commitPendingEdits(editor) &&
        valid(menu) && (!mutatesPages || canMutatePages())) fn(menu.id)
    setMenu(null)
  }
  const current = state.doc.pages.find(page => page.id === state.page)
  const query = uiMode === 'figma' && filterOpen ? search.trim().toLocaleLowerCase() : ''
  const pages = userPages(state.doc).filter(page => page.name.toLocaleLowerCase().includes(query))
  const maximum = () => Math.max(60, Math.floor((pane.current?.parentElement?.clientHeight || 600) * 0.55))
  const resize = (height: number) => setPaneHeight(old => ({
    ...old, [uiMode]: Math.max(60, Math.min(maximum(), height)),
  }))
  return <section ref={pane} className="layers-pages" data-pages-expanded={open}>
    <div className="pages-heading">
      <button type="button" className="pages-current" aria-expanded={open} aria-controls={listId} aria-label={open ? text.collapsePages : text.expandPages}
        onClick={() => setCollapsed(value => ({ ...value, [uiMode]: open }))}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span title={open ? text.pages : current?.name || text.pages}>{open ? text.pages : current?.name || text.pages}</span>
      </button>
      {uiMode === 'figma' && <button type="button" ref={filterToggle} title={text.searchPages} aria-label={text.searchPages}
        aria-expanded={open && filterOpen} onClick={() => {
          if (open && filterOpen) { setFilterOpen(false); setSearch('') }
          else { setCollapsed(value => ({ ...value, figma: false })); setFilterOpen(true) }
        }}><Search size={15} /></button>}
      <button title={text.addPage} aria-label={text.addPage} onClick={() => { if (canMutatePages() && commitPendingEdits(editor) && canMutatePages()) { setSearch(''); editor.addPage() } }}><Plus size={15} /></button>
    </div>
    <div id={listId} className="page-list-body" hidden={!open} style={{ height: paneHeight[uiMode] }}>
    {uiMode === 'figma' && filterOpen && <label className="layer-search page-search"><Search size={13} /><input ref={filterInput}
      aria-label={text.searchPages} placeholder={text.searchPagesPlaceholder} value={search}
      onChange={event => { if (commitPendingEdits(editor)) setSearch(event.target.value) }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.stopPropagation(); setFilterOpen(false); setSearch(''); filterToggle.current?.focus()
      }} /></label>}
    <nav ref={list} className="pages" aria-label={text.pageList}>
      {pages.map(page => {
        return <div className="page-row" key={page.id} draggable data-layer-drop-page={page.id}
          data-layer-drop-target={layerDropPage === page.id || undefined}
          onMouseOver={() => setHoverPage(page.id)} onMouseLeave={() => setHoverPage(current => current === page.id ? null : current)}
          onDragStart={event => {
            if (!canMutatePages() || !commitPendingEdits(editor) || !canMutatePages()) { event.preventDefault(); return }
            dragging.current = { id: page.id, session: editor.sessionGeneration, document: editor.state.doc.id }
            event.dataTransfer.setData('application/x-forma-page', page.id); event.dataTransfer.effectAllowed = 'move'
          }} onDragEnd={() => { dragging.current = null }}
          onDragOver={event => { if (dragging.current && valid(dragging.current)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
          onDrop={event => {
            event.preventDefault(); const payload = dragging.current; dragging.current = null
            if (!payload || !valid(payload) || payload.id === page.id || !canMutatePages() ||
                !commitPendingEdits(editor) || !valid(payload) || !canMutatePages()) return
            const after = event.clientY > event.currentTarget.getBoundingClientRect().y + event.currentTarget.getBoundingClientRect().height / 2
            const at = editor.state.doc.pages.findIndex(value => value.id === page.id)
            editor.reorderPage(payload.id, after ? editor.state.doc.pages[at + 1]?.id : page.id)
          }}>
          <button className={state.page === page.id ? 'page active' : 'page'} aria-current={state.page === page.id ? 'page' : undefined}
            onClick={() => editor.switchPage(page.id)} onDoubleClick={() => onRename(page.id)}>
            <span className="page-name" title={page.name}>{page.name}</span>{state.page === page.id && <span className="page-dot" />}
          </button>
          {hoverPage === page.id && <button type="button" className="page-ai" aria-label={`${locale === 'en' ? 'Edit with AI' : '用 AI 修改'} ${page.name}`} onMouseDown={event => event.stopPropagation()} onClick={event => {
            event.stopPropagation()
            if (!canMutatePages() || !commitPendingEdits(editor)) return
            editor.switchPage(page.id)
            requestAgentTarget({ pageId: page.id, prompt: locale === 'en' ? `Refine: edit “${page.name}”` : `细节调整：修改「${page.name}」`, send: false })
          }}>AI</button>}
          <button className="page-options" aria-label={`${text.pageActions}：${page.name}`} onClick={event => {
            if (!commitPendingEdits(editor)) return
            const box = event.currentTarget.getBoundingClientRect()
            const next = clampAnchoredMenu(box, { width: 180, height: 180 }, { prefer: 'below' })
            setMenu({ id: page.id, session: editor.sessionGeneration, document: state.doc.id, x: next.left, y: next.top })
          }}><MoreHorizontal size={14} /></button>
        </div>
      })}
      {!pages.length && <p className="muted">{text.noMatchingPages}</p>}
    </nav>
    </div>
    {open && <div className="page-list-divider" role="separator" aria-orientation="horizontal" aria-controls={listId} tabIndex={0}
      aria-label={locale === 'en' ? 'Resize page list' : '调整页面列表高度'}
      aria-valuemin={60} aria-valuemax={maximum()} aria-valuenow={Math.min(paneHeight[uiMode], maximum())}
      onPointerDown={event => {
        if (event.button !== 0 || !canMutatePages() || !commitPendingEdits(editor)) return
        drag.current = { mode: uiMode, pointer: event.pointerId, y: event.clientY, height: list.current?.parentElement?.clientHeight || paneHeight[uiMode] }
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const active = drag.current
        if (active?.pointer === event.pointerId && active.mode === uiMode) resize(active.height + event.clientY - active.y)
      }}
      onLostPointerCapture={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !canMutatePages() || !commitPendingEdits(editor)) return
        event.preventDefault(); event.stopPropagation()
        const height = list.current?.parentElement?.clientHeight || paneHeight[uiMode]
        resize(event.key === 'Home' ? 60 : event.key === 'End' ? maximum() : height + (event.key === 'ArrowUp' ? -16 : 16))
      }} />}
    {menu && createPortal(<div ref={menuRef} className="page-menu" role="menu" aria-label={text.pageActions} tabIndex={-1}
      style={{ position: 'fixed', left: menu.x, top: menu.y }} onKeyDown={event => modalKeyDown(event, () => setMenu(null))}>
      <button role="menuitem" onClick={() => action(onRename)}>{text.renamePage}</button>
      <button role="menuitem" onClick={() => action(id => editor.duplicatePage(id), true)}>{text.duplicatePage}</button>
      <button role="menuitem" disabled={userPages(state.doc)[0].id === menu.id} onClick={() => action(id => {
        const visible = userPages(editor.state.doc), at = visible.findIndex(page => page.id === id)
        if (at > 0) editor.reorderPage(id, visible[at - 1].id)
      }, true)}>{text.movePageUp}</button>
      <button role="menuitem" disabled={userPages(state.doc).at(-1)?.id === menu.id} onClick={() => action(id => {
        const visible = userPages(editor.state.doc), at = visible.findIndex(page => page.id === id)
        editor.reorderPage(id, visible[at + 2]?.id)
      }, true)}>{text.movePageDown}</button>
      <button role="menuitem" disabled={userPages(state.doc).length <= 1} onClick={() => action(id => {
        if (confirm(text.deletePageConfirm) && valid(menu) && canMutatePages()) editor.removePage(id)
      }, true)}>{text.deletePage}</button>
    </div>, document.body)}
  </section>
}
