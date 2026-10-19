import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Plus, MoreHorizontal, Search } from 'lucide-react'
import type { Editor } from './engine'
import { commitPendingEdits } from './pending-edits'
import { modalKeyDown } from './modal-keyboard'

export function PageList({ editor, onRename }: { editor: Editor; onRename: (id: string) => void }) {
  const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
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
  const action = (fn: (id: string) => void) => {
    if (menu && valid(menu) && commitPendingEdits(editor) && valid(menu)) fn(menu.id)
    setMenu(null)
  }
  return <>
    <div className="pages-heading"><span>页面</span><button title="添加页面" onClick={() => { if (commitPendingEdits(editor)) { setSearch(''); editor.addPage() } }}><Plus size={15} /></button></div>
    <label className="layer-search page-search"><Search size={13} /><input aria-label="搜索页面" placeholder="搜索页面…" value={search}
      onChange={event => { if (commitPendingEdits(editor)) setSearch(event.target.value) }} /></label>
    <nav className="pages" aria-label="页面列表">
      {state.doc.pages.filter(page => page.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(page => {
        const index = state.doc.pages.findIndex(value => value.id === page.id)
        return <div className="page-row" key={page.id} draggable
          onDragStart={event => {
            if (!commitPendingEdits(editor) || editor.interactionActive) { event.preventDefault(); return }
            dragging.current = { id: page.id, session: editor.sessionGeneration, document: editor.state.doc.id }
            event.dataTransfer.setData('application/x-forma-page', page.id); event.dataTransfer.effectAllowed = 'move'
          }} onDragEnd={() => { dragging.current = null }}
          onDragOver={event => { if (dragging.current && valid(dragging.current)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
          onDrop={event => {
            event.preventDefault(); const payload = dragging.current; dragging.current = null
            if (!payload || !valid(payload) || payload.id === page.id || !commitPendingEdits(editor) || !valid(payload)) return
            const after = event.clientY > event.currentTarget.getBoundingClientRect().y + event.currentTarget.getBoundingClientRect().height / 2
            const at = editor.state.doc.pages.findIndex(value => value.id === page.id)
            editor.reorderPage(payload.id, after ? editor.state.doc.pages[at + 1]?.id : page.id)
          }}>
          <button className={state.page === page.id ? 'page active' : 'page'} onClick={() => editor.switchPage(page.id)} onDoubleClick={() => onRename(page.id)}>
            <span className="page-symbol">{String(index + 1).padStart(2, '0')}</span><span className="page-name">{page.name}</span>{state.page === page.id && <span className="page-dot" />}
          </button>
          <button className="page-options" aria-label={`页面操作：${page.name}`} onClick={event => {
            if (!commitPendingEdits(editor)) return
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ id: page.id, session: editor.sessionGeneration, document: state.doc.id, x: Math.max(8, Math.min(box.x, window.innerWidth - 188)), y: Math.min(box.bottom, window.innerHeight - 190) })
          }}><MoreHorizontal size={14} /></button>
        </div>
      })}
      {!state.doc.pages.some(page => page.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="muted">没有匹配页面</p>}
    </nav>
    {menu && createPortal(<div ref={menuRef} className="page-menu" role="menu" aria-label="页面操作" tabIndex={-1}
      style={{ position: 'fixed', left: menu.x, top: menu.y }} onKeyDown={event => modalKeyDown(event, () => setMenu(null))}>
      <button role="menuitem" onClick={() => action(onRename)}>重命名页面</button>
      <button role="menuitem" onClick={() => action(id => editor.duplicatePage(id))}>复制页面</button>
      <button role="menuitem" disabled={state.doc.pages[0].id === menu.id} onClick={() => action(id => {
        const at = editor.state.doc.pages.findIndex(page => page.id === id); if (at > 0) editor.reorderPage(id, editor.state.doc.pages[at - 1].id)
      })}>页面上移</button>
      <button role="menuitem" disabled={state.doc.pages.at(-1)?.id === menu.id} onClick={() => action(id => {
        const at = editor.state.doc.pages.findIndex(page => page.id === id); editor.reorderPage(id, editor.state.doc.pages[at + 2]?.id)
      })}>页面下移</button>
    </div>, document.body)}
  </>
}
