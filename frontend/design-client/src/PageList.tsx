import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, MoreHorizontal, Plus, Search } from 'lucide-react'
import type { Editor } from './engine'
import { useInterfacePreferences, useInterfaceText } from './interface-preference'
import { commitPendingEdits } from './pending-edits'
import { modalKeyDown } from './modal-keyboard'
import { userPages } from './fig-document'
import { requestAgentTarget } from './design-ai/target-event'
import { clampAnchoredMenu } from './anchored-menu'
import './design-ai/design-agent.css'

export function PageList({ editor, onRename }: { editor: Editor; onRename: (id: string) => void }) {
  const text = useInterfaceText()
  const { locale } = useInterfacePreferences()
  const listId = useId()
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const [open, setOpen] = useState(true)
  const [hoverPage, setHoverPage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
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
  // Page topology cannot change underneath a captured Canvas transaction.
  // Recheck at the action boundary: begin() may not emit a React update yet.
  const canMutatePages = () => !editor.interactionActive && !editor.state.busy
  const action = (fn: (id: string) => void, mutatesPages = false) => {
    if (menu && valid(menu) && (!mutatesPages || canMutatePages()) && commitPendingEdits(editor) &&
        valid(menu) && (!mutatesPages || canMutatePages())) fn(menu.id)
    setMenu(null)
  }
  const current = state.doc.pages.find(page => page.id === state.page)
  return <>
    <div className="pages-heading">
      <button type="button" className="pages-current" aria-expanded={open} aria-controls={listId} aria-label={open ? text.collapsePages : text.expandPages}
        onClick={() => setOpen(value => !value)}>
        <ChevronDown size={14} /><span title={current?.name || text.pages}>{current?.name || text.pages}</span>
      </button>
      <button title={text.addPage} aria-label={text.addPage} onClick={() => { if (canMutatePages() && commitPendingEdits(editor) && canMutatePages()) { setSearch(''); editor.addPage() } }}><Plus size={15} /></button>
    </div>
    <div id={listId} hidden={!open}>
    <label className="layer-search page-search"><Search size={13} /><input aria-label={text.searchPages} placeholder={text.searchPagesPlaceholder} value={search}
      onChange={event => { if (commitPendingEdits(editor)) setSearch(event.target.value) }} /></label>
    <nav className="pages" aria-label={text.pageList}>
      {userPages(state.doc).filter(page => page.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(page => {
        return <div className="page-row" key={page.id} draggable
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
          <button className={state.page === page.id ? 'page active' : 'page'} onClick={() => editor.switchPage(page.id)} onDoubleClick={() => onRename(page.id)}>
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
      {!userPages(state.doc).some(page => page.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="muted">{text.noMatchingPages}</p>}
    </nav>
    </div>
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
    </div>, document.body)}
  </>
}
