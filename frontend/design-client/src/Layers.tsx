import { dispatchEditorCommand } from './editor-commands'
import { shortcutTargetOwnsKeyboard } from './editor-shortcuts'
import { sketchLayerFindOwnsChord } from './interface-layout'
import { getShortcutProfile } from './shortcut-preference'
import { layerExpanded, LayerRowsCache, visibleLayerBranch } from './layer-tree'
import { CanvasContextMenu } from './CanvasContextMenu'
import { PageList } from './PageList'
import { AssetsPanel } from './AssetsPanel'
import { memo, useMemo, useState, useSyncExternalStore, useRef, useEffect, useId, useLayoutEffect, type ReactNode } from 'react'
import {
  Plus as PlusGlyph,
  ChevronDown as ChevronDownGlyph,
  ChevronRight as ChevronRightGlyph,
  Eye as EyeGlyph,
  EyeOff as EyeOffGlyph,
  Lock as LockGlyph,
  Unlock as UnlockGlyph,
  Frame as FrameGlyph,
  Focus as FocusGlyph,
  Layers as LayersGlyph,
  Square as SquareGlyph,
  Type as TypeGlyph,
  PenTool as PenToolGlyph,
  Search as SearchGlyph,
  Folder as FolderGlyph,
  Diamond as DiamondGlyph,
} from 'lucide-react'
// Layer hover/property publications do not change most glyph props. Keep
// Lucide path construction out of those measured React hot updates.
const Plus = memo(PlusGlyph)
const ChevronDown = memo(ChevronDownGlyph)
const ChevronRight = memo(ChevronRightGlyph)
const Eye = memo(EyeGlyph)
const EyeOff = memo(EyeOffGlyph)
const Lock = memo(LockGlyph)
const Unlock = memo(UnlockGlyph)
const Frame = memo(FrameGlyph)
const Focus = memo(FocusGlyph)
const LayersIcon = memo(LayersGlyph)
const Square = memo(SquareGlyph)
const Type = memo(TypeGlyph)
const PenTool = memo(PenToolGlyph)
const Search = memo(SearchGlyph)
const Folder = memo(FolderGlyph)
const Diamond = memo(DiamondGlyph)

import type { Editor } from './engine'
import { container, type DesignNode } from './model'
import { kernelSvgPaths } from './kernel/picking'
import { commitPendingEdits, hasPendingEdits } from './pending-edits'
import { DraftInput } from './DraftInput'
import { layerSelection } from './layer-selection'
import { layerDropPlan, layerDropPosition, orderedLayerRoots, pageMoveRoots, type LayerDropPosition } from './layer-drop'
import type { WorkspaceSection } from './EditorChrome'
import { interfacePreference, type UiMode, useInterfacePreferences, useInterfaceText } from './interface-preference'
import { LayerFindPanel } from './LayerFindPanel'
import { closeLayerFind, layerFindRefocus, layerFindReturnTarget, layerFindSnapshot, requestLayerFind, subscribeLayerFind } from './layer-find-session'
const DrawLayerThumbnail = memo(function DrawLayerThumbnail({ layer, fallback }: { layer: DesignNode; fallback: ReactNode }) {
  const fill = layer.fills.find(paint => paint.visible)
  const stroke = layer.strokes.find(stroke => stroke.visible)
  if ((!fill && !stroke) || layer.kind === 'text' || layer.children.length || layer.vectorBrush ||
      layer.network && layer.network.vertices.length > 128 || (layer.vectorGeometry?.fill.length ?? 0) > 128 ||
      fill && fill.kind !== 'solid' || stroke && stroke.paint.kind !== 'solid' || layer.fills.some(paint => paint.image))
    return <span className="draw-layer-thumbnail" data-layer-type-icon="" aria-hidden="true">{fallback}</span>
  const paths = kernelSvgPaths(layer)
  return <span className="draw-layer-thumbnail" data-layer-type-icon="" aria-hidden="true">
    {paths ? <svg viewBox={`0 0 ${Math.max(1, layer.width)} ${Math.max(1, layer.height)}`}>
      <path d={paths.fill} fill={fill?.color ?? 'none'} fillOpacity={fill?.opacity}
        fillRule={layer.vectorGeometry?.fillRule ?? layer.network?.fillRule} />
      {stroke && <path d={paths.stroke} fill="none" stroke={stroke.paint.color} strokeWidth={stroke.width} />}
    </svg> : fallback}
  </span>
})
export function Layers({ editor, section, onSection, showPages=true, documentTitle, documents, drawThumbnails = false }: {
  editor: Editor; section?: WorkspaceSection; onSection?: (section: WorkspaceSection) => void
  showPages?: boolean; documentTitle?: ReactNode; documents?: ReactNode; drawThumbnails?: boolean
}) {
  const text = useInterfaceText()
  const { uiMode, locale } = useInterfacePreferences()
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const renderSession = editor.sessionGeneration
  const [localTab, setLocalTab] = useState<WorkspaceSection>('layers')
  const tab = section || localTab, tabId = useId()
  const setTab = (next: WorkspaceSection) => {
    if (next === tab) return true
    if (editor.interactionActive || editor.state.busy || !commitPendingEdits(editor)) return false
    setLocalTab(next); onSection?.(next)
    return true
  }
  const [disclosure, setDisclosure] = useState<Record<UiMode, ReadonlyMap<string, boolean>>>(() => ({ figma: new Map(), sketch: new Map() })),
    [search, setSearch] = useState(''),
    [scroll, setScroll] = useState(0),
    [height, setHeight] = useState(500)
  const [relatedOnly, setRelatedOnly] = useState(false)
  const findGeneration = useSyncExternalStore(subscribeLayerFind, layerFindSnapshot)
  const findRefocus = useSyncExternalStore(subscribeLayerFind, layerFindRefocus)
  const findOpen = uiMode === 'figma' && findGeneration > 0
  const findWasOpen = useRef(false)
  const findDocument = useRef({ editor, session: renderSession, id: s.doc.id })
  const searchField = useRef<HTMLInputElement>(null), searchToggle = useRef<HTMLButtonElement>(null)
  const pendingFindFocus = useRef(false)
  const expansion = useMemo(() => ({ rootFramesOpen: uiMode === 'sketch', overrides: disclosure[uiMode] }), [disclosure, uiMode])
  const rowHeight = uiMode === 'sketch' ? 26 : 32
  const setLayerExpanded = (id: string, expanded: boolean) => setDisclosure(old => ({
    ...old, [uiMode]: new Map(old[uiMode]).set(id, expanded),
  }))
  const list = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null)
  const renaming = s.renamingLayer, setRenaming = (id: string | null) => editor.set({ renamingLayer: id })
  const [context, setContext] = useState<{ x: number; y: number; id: string } | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string | null; position: LayerDropPosition } | null>(null)
  const [layerDropPage, setLayerDropPage] = useState<string>()
  const reveal = useRef<string | null>(null)
  const selectionAnchor = useRef<string | null>(null)
  const dragged = useRef<{ session: number; page: string; document: string; ids: string[]; pageSelection?: string[]; revision?: number } | null>(null)
  const pointerDrag = useRef<{ pointer: number; target: HTMLElement; x: number; y: number; id: string; moved: boolean;
    plan?: {parent:string;before?:string}; targetPage?: string } | null>(null)
  const suppressClick = useRef(false), clickReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPointerDrag = () => {
    const active = pointerDrag.current; pointerDrag.current = null; dragged.current = null; setDrop(null)
    setLayerDropPage(undefined)
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
    if (!active.moved) editor.select(payload.pageSelection ?? payload.ids)
    active.moved = true
    const underPointer = document.elementFromPoint?.(event.clientX, event.clientY)
    const pageRow = uiMode === 'sketch' ? underPointer?.closest<HTMLElement>('[data-layer-drop-page]') : undefined
    active.targetPage = undefined
    if (pageRow && panel.current?.contains(pageRow)) {
      const target = pageRow.dataset.layerDropPage
      active.plan = undefined
      if (target && target !== payload.page && payload.pageSelection && payload.revision === editor.state.version &&
          !editor.interactionActive && !editor.state.busy &&
          pageMoveRoots(editor.state.doc, payload.page, payload.pageSelection, editor.parentMap()))
        active.targetPage = target
      setDrop(null); setLayerDropPage(active.targetPage)
      return
    }
    setLayerDropPage(undefined)
    const host = list.current!, bounds = host.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      active.plan = undefined; setDrop(null); return
    }
    if (event.clientY < bounds.top + 20) host.scrollTop -= 12
    else if (event.clientY > bounds.bottom - 20) host.scrollTop += 12
    const row = underPointer?.closest<HTMLElement>('[data-layer-id]')
    const target = row && host.contains(row) ? row.dataset.layerId! : null
    const rect = row?.getBoundingClientRect(), node = target ? editor.state.doc.nodes[target] : undefined
    const position = node && rect ? layerDropPosition(container(node), (event.clientY - rect.top) / rect.height) : 'below'
    active.plan = layerDropPlan(editor.state.doc, editor.state.page, payload.ids, target, position, editor.parentMap())
    setDrop(active.plan ? { id: target, position } : null)
  }
  const endLayerPointer = (event: React.PointerEvent) => {
    const active = pointerDrag.current, payload = dragged.current
    if (!active || !payload || event.pointerId !== active.pointer) return
    moveLayerPointer(event)
    if (pointerDrag.current !== active) return
    const plan = active.plan
    if (active.moved) {
      suppressClick.current = true
      if (clickReset.current) clearTimeout(clickReset.current)
      clickReset.current = setTimeout(() => { suppressClick.current = false }, 0)
      if (active.targetPage && payload.pageSelection) editor.moveLayersToPage(active.targetPage, payload.pageSelection)
      else if (plan && payload.session === editor.sessionGeneration && payload.page === editor.state.page && commitPendingEdits(editor))
        editor.reparentMany(payload.ids, plan.parent, plan.before)
    }
    cancelPointerDrag()
  }
  useEffect(() => () => editor.hoverLayer(null, 'layers'), [editor, tab, editor.sessionGeneration, s.page])
  useEffect(() => {
    cancelPointerDrag(); setRenaming(null); selectionAnchor.current = null; setFocused(null)
    // Searches describe this page/workset. Carrying an old query into a newly
    // loaded source page can hide every layer and make a successful switch
    // look like data loss. Ordinary edits/camera changes keep the query.
    setSearch(''); setScroll(0); setRelatedOnly(false)
    if (list.current) list.current.scrollTop = 0
  }, [editor, renderSession, s.doc.id, s.page])
  useEffect(() => setDisclosure({ figma: new Map(), sketch: new Map() }), [editor, renderSession, s.doc.id])
  useEffect(() => {
    const previous = findDocument.current
    findDocument.current = { editor, session: renderSession, id: s.doc.id }
    if (previous.editor !== editor || previous.session !== renderSession || previous.id !== s.doc.id) closeLayerFind()
  }, [editor, renderSession, s.doc.id])
  useLayoutEffect(() => {
    if (!findGeneration) {
      if (!findWasOpen.current) return
      findWasOpen.current = false
      if (uiMode !== 'figma') return
      const target = layerFindReturnTarget()
      if (target?.isConnected) target.focus()
      return
    }
    if (uiMode !== 'figma') return
    const opening = !findWasOpen.current
    findWasOpen.current = true
    if (!opening) return
    if (!interfacePreference.getSnapshot().leftOpen) interfacePreference.set({ leftOpen: true })
    if (tab !== 'layers' && !editor.interactionActive && !editor.state.busy && !hasPendingEdits(editor)) {
      setLocalTab('layers')
      onSection?.('layers')
    }
  }, [findGeneration, uiMode, tab, editor, onSection])
  useEffect(() => {
    if (!pendingFindFocus.current || uiMode !== 'sketch' || tab !== 'layers') return
    pendingFindFocus.current = false
    const field = searchField.current
    if (!field) return
    field.focus({ preventScroll: true })
    field.select()
  }, [uiMode, tab])
  useEffect(() => {
    if (uiMode !== 'sketch' || tab !== 'layers') return
    const toggle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.code !== 'KeyF' ||
          !event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !editor.state.selection.length ||
          editor.state.busy || editor.interactionActive) return
      const target = event.target
      if (target instanceof HTMLElement && target !== searchField.current &&
          (target.isContentEditable || target.matches('input, textarea, select'))) return
      event.preventDefault()
      event.stopPropagation()
      setRelatedOnly(value => !value)
    }
    window.addEventListener('keydown', toggle, true)
    return () => window.removeEventListener('keydown', toggle, true)
  }, [editor, tab, uiMode])
  useEffect(() => {
    // Capture runs before the window bubble layout chord. Only the default
    // Sketch scheme takes Option+Command+F; text and dialogs keep the key.
    if (uiMode !== 'sketch') return
    const find = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.shiftKey || !event.altKey) return
      if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return
      if (!sketchLayerFindOwnsChord(event, getShortcutProfile(), uiMode)) return
      if (shortcutTargetOwnsKeyboard(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (editor.state.busy || editor.interactionActive) return
      if (tab !== 'layers') {
        pendingFindFocus.current = true
        if (!setTab('layers')) pendingFindFocus.current = false
        return
      }
      const field = searchField.current
      field?.focus({ preventScroll: true })
      field?.select()
    }
    window.addEventListener('keydown', find, true)
    return () => window.removeEventListener('keydown', find, true)
  }, [editor, tab, uiMode])
  useEffect(() => {
    if (!s.selection.length) { reveal.current = null; return }
    const parents = editor.parentMap(s.doc), ancestors = new Set<string>()
    for (const selected of s.selection)
      for (let id = parents.get(selected); id && s.doc.nodes[id]; id = parents.get(id)) ancestors.add(id)
    setDisclosure(old => {
      if ([...ancestors].every(id => old[uiMode].get(id) === true)) return old
      const next = new Map(old[uiMode])
      for (const id of ancestors) next.set(id, true)
      return { ...old, [uiMode]: next }
    })
    if (!reveal.current || !s.selection.includes(reveal.current)) reveal.current = s.selection.at(-1) || null
  }, [s.selection, s.page, editor.sessionGeneration, uiMode])
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
  // A session owns one cache; unmount/editor replacement releases it.
  const rowCache = useMemo(() => new LayerRowsCache(), [editor, renderSession])
  const layerQuery = uiMode === 'sketch' ? search : ''
  const filterRelated = uiMode === 'sketch' && relatedOnly && s.selection.length > 0
  const allRows = useMemo(() => rowCache.read(s.doc, s.page, expansion, layerQuery), [rowCache, s.doc, s.page, expansion, layerQuery])
  const rows = useMemo(() => {
    if (!filterRelated) return allRows
    const parents = editor.parentMap(s.doc), related = new Set<string>()
    const pending = [...s.selection]
    while (pending.length) {
      const id = pending.pop()!
      if (!s.doc.nodes[id] || related.has(id)) continue
      related.add(id)
      for (const child of s.doc.nodes[id].children) pending.push(child)
    }
    for (const target of s.selection)
      for (let id = parents.get(target); id && s.doc.nodes[id]; id = parents.get(id)) related.add(id)
    return allRows.filter(row => related.has(row.id))
  }, [allRows, editor, filterRelated, s.doc, s.selection])
  useEffect(() => {
    if (!s.selection.length) setRelatedOnly(false)
  }, [s.selection.length])
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0
    setScroll(0)
    reveal.current = editor.state.selection.at(-1) || null
  }, [filterRelated])

  useEffect(() => {
    const id = reveal.current
    if (!id || !list.current) return
    const index = rows.findIndex(row => row.id === id)
    if (index < 0) return
    const top = index * rowHeight, bottom = top + rowHeight
    if (top < list.current.scrollTop) list.current.scrollTop = top
    else if (bottom > list.current.scrollTop + height) list.current.scrollTop = bottom - height
    setScroll(list.current.scrollTop)
    reveal.current = null
  }, [rows, s.selection, height, rowHeight])
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 6),
    end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 12)
  function choose(id: string, range = false, toggle = false, focus = false) {
    const session = editor.sessionGeneration, documentId = editor.state.doc.id, page = editor.state.page
    if (session !== renderSession || documentId !== s.doc.id || page !== s.page) return
    if (!commitPendingEdits(editor)) return
    if (session !== editor.sessionGeneration || documentId !== editor.state.doc.id || page !== editor.state.page ||
      !editor.state.doc.nodes[id]) return
    reveal.current = id
    editor.select(layerSelection(rows.map((row) => row.id), editor.state.selection, id, selectionAnchor.current, { range, toggle }))
    // Figma pans this selection into view and keeps the current zoom.
    // Sketch keeps that zoom and viewport; Zoom to Selection frames the layer.
    // Canvas clicks do not route through here.
    if (uiMode !== 'sketch') editor.requestReveal(editor.state.selection)
    if (!range) selectionAnchor.current = id
    setFocused(id)
    if (focus) {
      const index = rows.findIndex((row) => row.id === id), top = index * rowHeight, bottom = top + rowHeight
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
    return layerDropPlan(editor.state.doc, editor.state.page, payload.ids, id, position, editor.parentMap())
  }
  const layerSearch = <label className="layer-search">
    <Search size={13} />
    <input ref={searchField} aria-label={text.searchLayers} placeholder={text.searchLayersPlaceholder} value={search}
      onChange={event => {
        setSearch(event.target.value); setScroll(0)
        if (list.current) list.current.scrollTop = 0
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        setSearch('')
      }} />
  </label>
  const relatedLabel = locale === 'en' ? 'Show only selected and related layers' : '仅显示所选内容及相关图层'
  return (
    <aside ref={panel} className="layers-panel" aria-label={tab === 'assets' ? text.componentAssetsLabel : text.pagesAndLayersLabel}>
      {documents}
      {showPages && uiMode === 'figma' && <div className="layers-document-title" title={s.doc.name}>{documentTitle || s.doc.name}</div>}
      {showPages && <PageList editor={editor} onRename={renameIntendedPage} layerDropPage={layerDropPage} />}
      <div className="layer-heading">
        <div role="tablist" aria-label={text.sidebarContent} className="layer-tabs">
          {(['layers', 'assets'] as const).map((name, index) => <button key={name} type="button"
            id={`${tabId}-${name}-tab`} role="tab" aria-selected={tab === name} aria-pressed={tab === name}
            aria-controls={`${tabId}-${name}-panel`} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)} onKeyDown={event => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
              const next = event.key === 'Home' ? 'layers' : event.key === 'End' ? 'assets' :
                event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? (index === 0 ? 'assets' : 'layers') : null
              if (!next) return
              event.preventDefault(); event.stopPropagation()
              if (setTab(next)) document.getElementById(`${tabId}-${next}-tab`)?.focus()
            }}>{name === 'layers' ? text.layerTree : text.componentsTab}</button>)}
        </div>
        {uiMode === 'figma' && tab === 'layers' && <button type="button" ref={searchToggle} aria-label={text.searchLayers}
          title={text.searchLayers} aria-expanded={findOpen} onClick={() => {
            if (findOpen) closeLayerFind()
            else requestLayerFind(searchToggle.current)
          }}><Search size={14} /></button>}
        {tab === 'layers' && <button type="button" title={text.collapseAllLayers} aria-label={text.collapseAllLayers} onClick={() => {
          const parents = editor.parentMap(s.doc), next = new Map<string, boolean>()
          for (const id of s.doc.pages.find(page => page.id === s.page)?.children || []) next.set(id, false)
          for (const id of s.selection) for (let parent = parents.get(id); parent && s.doc.nodes[parent]; parent = parents.get(parent)) next.set(parent, true)
          setDisclosure(old => ({ ...old, [uiMode]: next }))
        }}><ChevronDown size={13} /></button>}
      </div>
      <div id={`${tabId}-assets-panel`} role="tabpanel" className="layers-tabpanel" hidden={tab !== 'assets'} aria-labelledby={`${tabId}-assets-tab`}>
        {tab === 'assets' && <AssetsPanel editor={editor} />}
      </div>
      <div id={`${tabId}-layers-panel`} role="tabpanel" className="layers-tabpanel" hidden={tab !== 'layers'} aria-labelledby={`${tabId}-layers-tab`}>
      {findOpen ? <LayerFindPanel editor={editor} generation={findGeneration} refocus={findRefocus} /> : <div
        className="layer-list"
        role="tree" aria-label={text.layerTree} aria-multiselectable="true"
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
        <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
          {rows.slice(start, end).map(({ id, depth }, offset) => {
            const n = s.doc.nodes[id],
              selected = s.selection.includes(id),
              expanded = layerExpanded(n, depth, expansion),
              Icon =
                n.component || n.instance || n.componentSet
                  ? Diamond
                  : container(n)
                    ? n.kind === 'group'
                      ? uiMode === 'sketch' ? Folder : LayersIcon
                      : n.graphic ? Square : Frame
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
                aria-expanded={n.children.length ? !!layerQuery.trim() || expanded : undefined}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  const plainKey = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
                    !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229
                  if (uiMode === 'sketch' && plainKey && e.key === 'Enter' && n.children.length) {
                    e.preventDefault(); e.stopPropagation()
                    if (!e.repeat && !layerQuery.trim()) setLayerExpanded(id, !expanded)
                    return
                  }
                  if (uiMode === 'sketch' && plainKey && e.key === 'Escape') {
                    const parent = editor.parentMap(s.doc).get(id)
                    if (parent && rows.some(row => row.id === parent)) {
                      e.preventDefault(); e.stopPropagation()
                      if (!e.repeat) choose(parent, false, false, true)
                      return
                    }
                  }
                  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                    e.preventDefault(); e.stopPropagation()
                    const at = rows.findIndex((row) => row.id === id)
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                    choose(rows[next].id, e.shiftKey, e.metaKey || e.ctrlKey, true)
                  }
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault(); e.stopPropagation()
                    const expand = e.key === 'ArrowRight'
                    if (n.children.length && !layerQuery.trim() && expanded !== expand) setLayerExpanded(id, expand)
                    else {
                      const parent = expand ? undefined : editor.parentMap(s.doc).get(id)
                      const next = expand ? rows[rows.findIndex((row) => row.id === id) + 1] : rows.find((row) => row.id === parent)
                      if (next && (!expand || next.depth > depth)) choose(next.id, false, false, true)
                    }
                  }
                  if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); if (selected && s.selection.length > 1) void dispatchEditorCommand(editor, 'rename'); else if (commitPendingEdits(editor)) setRenaming(id) }
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
                  top: (start + offset) * rowHeight,
                  height: rowHeight,
                  left: 0,
                  right: 0,
                  paddingLeft: 10 + Math.min(depth, 8) * 14,
                  boxShadow: drop?.id === id ? drop.position === 'inside' ? 'inset 0 0 0 2px var(--workspace-accent)' : `inset 0 ${drop.position === 'above' ? 2 : -2}px var(--workspace-accent)` : undefined,
                }}
                data-layer-id={id}
                draggable={false}
                onPointerDown={event => {
                  if (event.button !== 0 || (event.target as Element).closest('button,input,textarea,select') || renaming || !commitPendingEdits(editor) || editor.interactionActive) return
                  const selected = editor.state.selection.includes(id)
                  const ids = selected ? editor.topSelection() : [id]
                  dragged.current = { session: editor.sessionGeneration, page: editor.state.page, document: editor.state.doc.id,
                    ids: orderedLayerRoots(editor.state.doc, editor.state.page, ids), revision: editor.state.version,
                    pageSelection: uiMode === 'sketch' ? selected ? [...editor.state.selection] : [id] : undefined }
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
                onDoubleClick={event => {
                  if (uiMode !== 'sketch' || editor.interactionActive || editor.state.busy) return
                  // Pointer capture retargets clicks to the row after release.
                  // Recover the actual icon or name under the pointer.
                  const hitArea = '[data-layer-type-icon], .layer-name:not(.layer-rename)'
                  const hit = (event.target as Element).closest(hitArea) ??
                    document.elementFromPoint?.(event.clientX, event.clientY)?.closest(hitArea)
                  if (!hit || !event.currentTarget.contains(hit)) return
                  event.stopPropagation()
                  if (!hit.hasAttribute('data-layer-type-icon')) {
                    if (commitPendingEdits(editor)) setRenaming(id)
                    return
                  }
                  choose(id)
                  if (renderSession === editor.sessionGeneration && editor.state.doc.id === s.doc.id &&
                      editor.state.page === s.page && editor.state.selection.length === 1 && editor.state.selection[0] === id)
                    void dispatchEditorCommand(editor, 'zoom-selection')
                }}
                onContextMenu={event => {
                  event.preventDefault(); event.stopPropagation()
                  if (!commitPendingEdits(editor) || editor.interactionActive) return
                  if (!editor.state.selection.includes(id)) editor.select([id])
                  setContext({ x: event.clientX, y: event.clientY, id })
                }}
              >
                <button
                  className="disclosure"
                  aria-label={`${expanded ? text.collapseLayer : text.expandLayer} ${n.name}`}
                  disabled={!n.children.length || !!layerQuery.trim()}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (uiMode === 'sketch' && e.altKey) {
                      const branch = visibleLayerBranch(s.doc, id)
                      setDisclosure(old => {
                        if (branch.every(key => old.sketch.get(key) === true)) return old
                        const overrides = new Map(old.sketch)
                        for (const key of branch) overrides.set(key, true)
                        return { ...old, sketch: overrides }
                      })
                    } else setLayerExpanded(id, !expanded)
                  }}
                >
                  {n.children.length ? (
                    !expanded && !layerQuery.trim() ? (
                      <ChevronRight size={11} />
                    ) : (
                      <ChevronDown size={11} />
                    )
                  ) : null}
                </button>
                {drawThumbnails ? <DrawLayerThumbnail layer={n} fallback={<Icon size={13} />} /> : <Icon
                  data-layer-type-icon=""
                  size={13}
                  color={n.component || n.instance || n.componentSet ? 'var(--workspace-accent)' : undefined}
                  fill={n.component ? 'currentColor' : 'none'}
                />}
                {renaming === id ? <span className="layer-name layer-rename" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setRenaming(null) }}
                  onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && commitPendingEdits(editor)) setRenaming(null) }}>
                  <DraftInput key={`${editor.sessionGeneration}:${id}`} editor={editor} aria-label={text.renameLayer} autoFocus value={n.name}
                    normalize={(value) => value.trim()} validate={(value) => !!value}
                    onCommit={(value) => { editor.update([id], { name: value }, '重命名图层'); setRenaming(null) }} />
                </span> : <span className="layer-name" title={n.name} onDoubleClick={(event) => { event.stopPropagation(); if (commitPendingEdits(editor)) setRenaming(id) }}>
                  {n.mask ? '◐ ' : ''}
                  {n.name}
                </span>}
                <button
                  title={n.locked ? text.unlockLayer : text.lockLayer}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className={n.locked ? 'always' : ''}
                  onClick={(e) => {
                    e.stopPropagation()
                    editor.update([id], { locked: !n.locked }, '切换锁定')
                  }}
                >
                  {n.locked ? <Lock size={11} /> : <Unlock size={11} />}
                </button>
                <button
                  title={n.visible ? text.hideLayer : text.showLayer}
                  onDoubleClick={(event) => event.stopPropagation()}
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
      </div>}
      {uiMode === 'sketch' && tab === 'layers' && <footer className="sketch-layer-search">
        {layerSearch}
        <button type="button" aria-label={relatedLabel} aria-pressed={filterRelated} aria-keyshortcuts="Control+F"
          title={`${relatedLabel} (Ctrl+F)`} disabled={!s.selection.length || s.busy}
          onClick={() => setRelatedOnly(value => !value)}><Focus size={15}/></button>
      </footer>}
      </div>
      {context && s.doc.nodes[context.id] && <CanvasContextMenu editor={editor} x={context.x} y={context.y}
        origin="layers" worldPoint={editor.selectionBounds()} onClose={() => setContext(null)} />}
    </aside>
  )
}
