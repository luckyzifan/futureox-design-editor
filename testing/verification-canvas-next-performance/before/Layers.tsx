import { layerTreeRows } from './layer-tree'
import { CanvasContextMenu } from './CanvasContextMenu'
import { PageList } from './PageList'
import { AssetsPanel } from './AssetsPanel'
import { useMemo, useState, useSyncExternalStore, useRef, useEffect } from 'react'
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Frame,
  Layers as LayersIcon,
  Square,
  Type,
  PenTool,
  Search,
  Trash2,
  Copy,
  Diamond,
} from 'lucide-react'
import type { Editor } from './engine'
import { container } from './model'
import { allParents } from './geometry'
import { commitPendingEdits } from './pending-edits'
import { DraftInput } from './DraftInput'
import { layerSelection } from './layer-selection'
import { layerDropPlan, layerDropPosition, orderedLayerRoots, type LayerDropPosition } from './layer-drop'
import type { WorkspaceSection } from './EditorChrome'
export function Layers({ editor, section, onSection }: { editor: Editor; section?: WorkspaceSection; onSection?: (section: WorkspaceSection) => void }) {
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const renderSession = editor.sessionGeneration
  const [localTab, setLocalTab] = useState<WorkspaceSection>('layers')
  const tab = section || localTab, setTab = (next: WorkspaceSection) => { setLocalTab(next); onSection?.(next) }
  const [collapsed, setCollapsed] = useState(new Set<string>()),
    [search, setSearch] = useState(''),
    [scroll, setScroll] = useState(0),
    [height, setHeight] = useState(500)
  const list = useRef<HTMLDivElement>(null)
  const renaming = s.renamingLayer, setRenaming = (id: string | null) => editor.set({ renamingLayer: id })
  const [panelWidth, setPanelWidth] = useState(240)
  const [context, setContext] = useState<{ x: number; y: number; id: string } | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string | null; position: LayerDropPosition } | null>(null)
  const reveal = useRef<string | null>(null)
  const selectionAnchor = useRef<string | null>(null), resizeStart = useRef<{ x: number; width: number } | null>(null)
  const dragged = useRef<{ session: number; page: string; document: string; ids: string[] } | null>(null)
  const pointerDrag = useRef<{ pointer: number; target: HTMLElement; x: number; y: number; id: string; moved: boolean; plan?: {parent:string;before?:string} } | null>(null)
  const suppressClick = useRef(false), clickReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPointerDrag = () => {
    const active = pointerDrag.current; pointerDrag.current = null; dragged.current = null; setDrop(null)
    if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer)
  }
  useEffect(() => () => { if (clickReset.current) clearTimeout(clickReset.current) }, [])
  useEffect(() => {
    const cancel = () => cancelPointerDrag()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && pointerDrag.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel() } }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key, true) }
  }, [])
  const moveLayerPointer = (event: React.PointerEvent) => {
    const active = pointerDrag.current, payload = dragged.current
    if (!active || !payload || event.pointerId !== active.pointer) return
    if (payload.session !== editor.sessionGeneration || payload.page !== editor.state.page || payload.document !== editor.state.doc.id) { cancelPointerDrag(); return }
    if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4) return
    event.preventDefault()
    if (!active.moved) editor.select(payload.ids)
    active.moved = true
    const host = list.current!, bounds = host.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      active.plan = undefined; setDrop(null); return
    }
    if (event.clientY < bounds.top + 20) host.scrollTop -= 12
    else if (event.clientY > bounds.bottom - 20) host.scrollTop += 12
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-layer-id]')
    const target = row && host.contains(row) ? row.dataset.layerId! : null
    const rect = row?.getBoundingClientRect(), node = target ? editor.state.doc.nodes[target] : undefined
    const position = node && rect ? layerDropPosition(container(node), (event.clientY - rect.top) / rect.height) : 'below'
    active.plan = layerDropPlan(editor.state.doc, editor.state.page, payload.ids, target, position)
    setDrop(active.plan ? { id: target, position } : null)
  }
  const endLayerPointer = (event: React.PointerEvent) => {
    const active = pointerDrag.current, payload = dragged.current
    if (!active || !payload || event.pointerId !== active.pointer) return
    moveLayerPointer(event)
    const plan = active.plan
    if (active.moved) {
      suppressClick.current = true
      if (clickReset.current) clearTimeout(clickReset.current)
      clickReset.current = setTimeout(() => { suppressClick.current = false }, 0)
      if (plan && payload.session === editor.sessionGeneration && payload.page === editor.state.page && commitPendingEdits(editor))
        editor.reparentMany(payload.ids, plan.parent, plan.before)
    }
    cancelPointerDrag()
  }
  useEffect(() => () => editor.hoverLayer(null, 'layers'), [editor, tab, editor.sessionGeneration, s.page])
  useEffect(() => { cancelPointerDrag(); setRenaming(null); selectionAnchor.current = null; setFocused(null) }, [editor.sessionGeneration, s.page])
  useEffect(() => {
    if (!s.selection.length) { reveal.current = null; return }
    const parents = allParents(s.doc), ancestors = new Set<string>()
    for (const selected of s.selection)
      for (let id = parents.get(selected); id && s.doc.nodes[id]; id = parents.get(id)) ancestors.add(id)
    setCollapsed(old => {
      if (![...ancestors].some(id => old.has(id))) return old
      return new Set([...old].filter(id => !ancestors.has(id)))
    })
    if (!reveal.current || !s.selection.includes(reveal.current)) reveal.current = s.selection.at(-1) || null
  }, [s.selection, s.page, editor.sessionGeneration])
  useEffect(() => {
    const o = new ResizeObserver(([e]) => setHeight(e.contentRect.height))
    o.observe(list.current!)
    return () => o.disconnect()
  }, [])
  function renameIntendedPage(pageId: string) {
    const session = editor.sessionGeneration, documentId = editor.state.doc.id, currentPage = editor.state.page
    const target = editor.state.doc.pages.find((page) => page.id === pageId)
    if (!target || session !== renderSession || documentId !== s.doc.id) return
    let invalidated = false
    const check = () => {
      if (editor.sessionGeneration !== session || editor.state.doc.id !== documentId || editor.state.page !== currentPage ||
        !editor.state.doc.pages.some((page) => page.id === pageId)) invalidated = true
    }
    const unsubscribe = editor.subscribe(check)
    try {
      if (!commitPendingEdits(editor)) return
      check()
      if (invalidated) return
      const name = prompt('页面名称', target.name)
      check()
      if (!name?.trim() || invalidated || !commitPendingEdits(editor)) return
      check()
      if (invalidated) return
      // Name the explicit page. Navigation can be vetoed; it is never authority
      // to silently rename whichever page happens to remain selected.
      editor.change('重命名页面', (document) => {
        const intended = document.pages.find((page) => page.id === pageId)
        if (!intended) throw new Error('重命名目标页面已不存在')
        intended.name = name.trim()
      })
    } finally { unsubscribe() }
  }
  const rows = useMemo(() => layerTreeRows(s.doc, s.page, collapsed, search), [s.doc, s.page, collapsed, search])

  useEffect(() => {
    const id = reveal.current
    if (!id || !list.current) return
    const index = rows.findIndex(row => row.id === id)
    if (index < 0) return
    const top = index * 32, bottom = top + 32
    if (top < list.current.scrollTop) list.current.scrollTop = top
    else if (bottom > list.current.scrollTop + height) list.current.scrollTop = bottom - height
    setScroll(list.current.scrollTop)
    reveal.current = null
  }, [rows, s.selection, height])
  const start = Math.max(0, Math.floor(scroll / 32) - 6),
    end = Math.min(rows.length, start + Math.ceil(height / 32) + 12)
  function choose(id: string, range = false, toggle = false, focus = false) {
    const session = editor.sessionGeneration, documentId = editor.state.doc.id, page = editor.state.page
    if (session !== renderSession || documentId !== s.doc.id || page !== s.page) return
    if (!commitPendingEdits(editor)) return
    if (session !== editor.sessionGeneration || documentId !== editor.state.doc.id || page !== editor.state.page ||
      !editor.state.doc.nodes[id]) return
    reveal.current = id
    editor.select(layerSelection(rows.map((row) => row.id), editor.state.selection, id, selectionAnchor.current, { range, toggle }))
    // Panel selection drives the camera: the canvas pans the new selection into
    // view (it never re-scales). Canvas clicks do not route through here.
    editor.requestReveal(editor.state.selection)
    if (!range) selectionAnchor.current = id
    setFocused(id)
    if (focus) {
      const index = rows.findIndex((row) => row.id === id), top = index * 32, bottom = top + 32
      if (list.current && top < list.current.scrollTop) list.current.scrollTop = top
      if (list.current && bottom > list.current.scrollTop + height) list.current.scrollTop = bottom - height
      if (list.current) setScroll(list.current.scrollTop)
      requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-testid="layer-${id}"]`)?.focus())
    } else {
      // Figma pointer selection returns editing shortcuts to the canvas. Arrow
      // navigation entered from the keyboard retains the tree's own focus.
      document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({preventScroll:true})
    }
  }
  function dropPlan(id: string | null, position: LayerDropPosition) {
    const payload = dragged.current
    if (!payload || payload.session !== editor.sessionGeneration || payload.page !== editor.state.page || payload.document !== editor.state.doc.id) return
    return layerDropPlan(editor.state.doc, editor.state.page, payload.ids, id, position)
  }
  return (
    <aside className="layers-panel" style={{ width: panelWidth }} aria-label={tab === 'assets' ? '组件资源' : '页面与图层'}>
      <div className="workspace-title">
        <span className="workspace-icon">F</span>
        <div>
          <b>本机工作空间</b>
          <small>{s.doc.name}</small>
        </div>
      </div>
      <PageList editor={editor} onRename={renameIntendedPage} />
      <div className="pages-actions">
        <button
          title="删除当前页面"
          disabled={s.doc.pages.length === 1}
          onClick={() => {
            if (confirm('删除当前页面及其所有图层？可通过撤销恢复。')) editor.removePage()
          }}
        >
          <Trash2 size={12} />
          删除页面
        </button>
      </div>
      <div className="layer-heading">
        <button aria-pressed={tab === 'layers'} onClick={() => setTab('layers')}>
          图层
        </button>
        <button aria-pressed={tab === 'assets'} onClick={() => setTab('assets')}>
          组件
        </button>
        <button title="折叠全部图层" onClick={() => {
          const parents = allParents(s.doc), keep = new Set(s.selection)
          for (const id of s.selection) for (let parent = parents.get(id); parent && s.doc.nodes[parent]; parent = parents.get(parent)) keep.add(parent)
          setCollapsed(old => new Set([...old, ...Object.values(s.doc.nodes).filter(n => n.children.length && !keep.has(n.id)).map(n => n.id)]))
        }}><ChevronDown size={13} /></button>
        <span>{rows.length}</span>
      </div>
      {tab === 'assets' && <AssetsPanel editor={editor} />}
      <label className="layer-search" style={{ display: tab === 'assets' ? 'none' : undefined }}>
        <Search size={13} />
        <input
          aria-label="搜索图层"
          placeholder="搜索图层…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setScroll(0)
            if (list.current) list.current.scrollTop = 0
          }}
        />
      </label>
      <div
        className="layer-list"
        role="tree" aria-label="图层" aria-multiselectable="true"
        style={{ display: tab === 'assets' ? 'none' : undefined }}
        ref={list}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        onDragOver={(event) => {
          if ((event.target as Element).closest('[role="treeitem"]') || !dropPlan(null, 'below')) return
          event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop({ id: null, position: 'below' })
        }}
        onDrop={(event) => {
          if ((event.target as Element).closest('[role="treeitem"]')) return
          event.preventDefault()
          if (!commitPendingEdits(editor)) return
          const plan = dropPlan(null, 'below'), payload = dragged.current
          if (plan && payload) editor.reparentMany(payload.ids, plan.parent, plan.before)
          dragged.current = null; setDrop(null)
        }}
      >
        <div style={{ height: rows.length * 32, position: 'relative' }}>
          {rows.slice(start, end).map(({ id, depth }, offset) => {
            const n = s.doc.nodes[id],
              selected = s.selection.includes(id),
              Icon =
                n.component || n.instance || n.componentSet
                  ? Diamond
                  : container(n)
                    ? n.kind === 'group'
                      ? LayersIcon
                      : Frame
                    : n.kind === 'text'
                      ? Type
                      : n.kind === 'vector'
                        ? PenTool
                        : Square
            return (
              <div
                key={id}
                role="treeitem"
                tabIndex={focused === id || (!focused && offset === 0) ? 0 : -1}
                aria-label={n.name}
                aria-selected={selected}
                aria-level={depth + 1}
                aria-expanded={n.children.length ? !!search.trim() || !collapsed.has(id) : undefined}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault(); e.stopPropagation()
                    const at = rows.findIndex((row) => row.id === id)
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                    choose(rows[next].id, e.shiftKey, e.metaKey || e.ctrlKey, true)
                  }
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault(); e.stopPropagation()
                    const expand = e.key === 'ArrowRight'
                    if (n.children.length && collapsed.has(id) === expand) setCollapsed((old) => { const next = new Set(old); expand ? next.delete(id) : next.add(id); return next })
                    else {
                      const next = expand ? rows[rows.findIndex((row) => row.id === id) + 1] : rows.find((row) => row.id === allParents(s.doc).get(id))
                      if (next && (!expand || next.depth > depth)) choose(next.id, false, false, true)
                    }
                  }
                  if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); setRenaming(id) }
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    choose(id, e.shiftKey, e.key === ' ' || e.metaKey || e.ctrlKey)
                  }
                }}
                data-search-context={rows[start + offset]?.context || undefined}
                data-testid={`layer-${id}`}
                data-hovered={s.hover === id ? 'true' : 'false'}
                data-drop-position={drop?.id === id ? drop.position : undefined}
                onPointerEnter={() => editor.hoverLayer(id, 'layers')}
                onPointerLeave={() => editor.hoverLayer(null, 'layers')}
                className={`layer-row ${selected ? 'selected' : ''} ${!n.visible ? 'hidden-layer' : ''}`}
                style={{
                  position: 'absolute',
                  top: (start + offset) * 32,
                  height: 32,
                  left: 0,
                  right: 0,
                  paddingLeft: 10 + Math.min(depth, 8) * 14,
                  boxShadow: drop?.id === id ? drop.position === 'inside' ? 'inset 0 0 0 2px var(--workspace-accent)' : `inset 0 ${drop.position === 'above' ? 2 : -2}px var(--workspace-accent)` : undefined,
                }}
                data-layer-id={id}
                draggable={false}
                onPointerDown={event => {
                  if (event.button !== 0 || (event.target as Element).closest('button,input,textarea,select') || renaming || !commitPendingEdits(editor) || editor.interactionActive) return
                  const ids = editor.state.selection.includes(id) ? editor.topSelection() : [id]
                  dragged.current = { session: editor.sessionGeneration, page: editor.state.page, document: editor.state.doc.id, ids: orderedLayerRoots(editor.state.doc, editor.state.page, ids) }
                  pointerDrag.current = { pointer: event.pointerId, target: event.currentTarget, x: event.clientX, y: event.clientY, id, moved: false }
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={moveLayerPointer}
                onPointerUp={endLayerPointer}
                onPointerCancel={cancelPointerDrag}
                onLostPointerCapture={() => { if (pointerDrag.current) cancelPointerDrag() }}
                onDragStart={(e) => {
                  if (renaming || !commitPendingEdits(editor)) { e.preventDefault(); return }
                  if (!editor.state.selection.includes(id)) editor.select([id])
                  dragged.current = { session: editor.sessionGeneration, page: editor.state.page, document: editor.state.doc.id, ids: orderedLayerRoots(editor.state.doc, editor.state.page, editor.topSelection()) }
                  e.dataTransfer.setData('application/x-forma-layer', id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => { dragged.current = null; setDrop(null) }}
                onDragOver={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect(), position = layerDropPosition(container(n), (event.clientY - bounds.top) / bounds.height)
                  event.preventDefault(); event.stopPropagation()
                  if (!dropPlan(id, position)) { event.dataTransfer.dropEffect = 'none'; setDrop(null); return }
                  event.dataTransfer.dropEffect = 'move'; setDrop({ id, position })
                }}
                onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null) }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!commitPendingEdits(editor)) return
                  const source = e.dataTransfer.getData('application/x-forma-layer'), payload = dragged.current
                  const bounds = e.currentTarget.getBoundingClientRect(), position = layerDropPosition(container(n), (e.clientY - bounds.top) / bounds.height), plan = dropPlan(id, position)
                  if (source && payload && plan) editor.reparentMany(payload.ids, plan.parent, plan.before)
                  dragged.current = null; setDrop(null)
                }}
                onClick={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); return }; choose(id, e.shiftKey, e.metaKey || e.ctrlKey) }}
                onContextMenu={event => {
                  event.preventDefault(); event.stopPropagation()
                  if (!commitPendingEdits(editor) || editor.interactionActive) return
                  if (!editor.state.selection.includes(id)) editor.select([id])
                  setContext({ x: event.clientX, y: event.clientY, id })
                }}
                onDoubleClick={() => {
                  if (commitPendingEdits(editor)) setRenaming(id)
                }}
              >
                <button
                  className="disclosure"
                  aria-label={`${collapsed.has(id) ? '展开' : '折叠'} ${n.name}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    setCollapsed((old) => {
                      const next = new Set(old)
                      next.has(id) ? next.delete(id) : next.add(id)
                      return next
                    })
                  }}
                >
                  {n.children.length ? (
                    collapsed.has(id) ? (
                      <ChevronRight size={11} />
                    ) : (
                      <ChevronDown size={11} />
                    )
                  ) : null}
                </button>
                <Icon
                  size={13}
                  color={n.component || n.instance || n.componentSet ? 'var(--workspace-accent)' : undefined}
                  fill={n.component ? 'currentColor' : 'none'}
                />
                {renaming === id ? <span className="layer-name layer-rename" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setRenaming(null) }}
                  onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && commitPendingEdits(editor)) setRenaming(null) }}>
                  <DraftInput key={`${editor.sessionGeneration}:${id}`} editor={editor} aria-label="重命名图层" autoFocus value={n.name}
                    normalize={(value) => value.trim()} validate={(value) => !!value}
                    onCommit={(value) => { editor.update([id], { name: value }, '重命名图层'); setRenaming(null) }} />
                </span> : <span className="layer-name">
                  {n.mask ? '◐ ' : ''}
                  {n.name}
                </span>}
                <button
                  title={n.locked ? '解锁图层' : '锁定图层'}
                  className={n.locked ? 'always' : ''}
                  onClick={(e) => {
                    e.stopPropagation()
                    editor.update([id], { locked: !n.locked }, '切换锁定')
                  }}
                >
                  {n.locked ? <Lock size={11} /> : <Unlock size={11} />}
                </button>
                <button
                  title={n.visible ? '隐藏图层' : '显示图层'}
                  className={!n.visible ? 'always' : ''}
                  onClick={(e) => {
                    e.stopPropagation()
                    editor.update([id], { visible: !n.visible }, '切换可见性')
                  }}
                >
                  {n.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
      <div className="layer-footer">
        <button onClick={() => editor.group()} disabled={!s.selection.length}>
          <LayersIcon size={14} />
          编组
        </button>
        <button onClick={() => editor.duplicate()} disabled={!s.selection.length}>
          <Copy size={14} />
          复制
        </button>
      </div>
      <div className="panel-resizer" role="separator" aria-label="调整图层面板宽度" aria-orientation="vertical"
        aria-valuemin={200} aria-valuemax={360} aria-valuenow={panelWidth} tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); setPanelWidth((width) => Math.max(200, Math.min(360, width + (event.key === 'ArrowRight' ? 10 : -10)))) } }}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); resizeStart.current = { x: event.clientX, width: panelWidth }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={(event) => { if (resizeStart.current) setPanelWidth(Math.max(200, Math.min(360, resizeStart.current.width + event.clientX - resizeStart.current.x))) }}
        onPointerUp={(event) => { resizeStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={() => { resizeStart.current = null }} onLostPointerCapture={() => { resizeStart.current = null }} />
      {context && s.doc.nodes[context.id] && <CanvasContextMenu editor={editor} x={context.x} y={context.y}
        worldPoint={{ x: editor.selectionBounds().x, y: editor.selectionBounds().y }} candidates={[{ id: context.id, name: s.doc.nodes[context.id].name, locked: s.doc.nodes[context.id].locked }]} onClose={() => setContext(null)} />}
    </aside>
  )
}
