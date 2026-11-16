import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Search } from 'lucide-react'
import type { Editor } from './engine'
import { useInterfaceText } from './interface-preference'
import {
  adjacentLayerFindResult, layerFindResults, layerFindTypes, locateLayerFindResult,
  type LayerFindScope, type LayerFindType,
} from './layer-find'
import { closeLayerFind } from './layer-find-session'

const typeTextKey = {
  text: 'findTypeText', frame: 'findTypeFrame', group: 'findTypeGroup', component: 'findTypeComponent',
  instance: 'findTypeInstance', shape: 'findTypeShape', image: 'findTypeImage', section: 'findTypeSection', other: 'findTypeOther',
} as const

type FindRow = { kind: 'heading'; key: string; label: string } | { kind: 'hit'; key: string; resultIndex: number }

/** Figma-layout Find. Replaces the layer tree while open; it does not edit the document. */
export function LayerFindPanel({ editor, generation, refocus }: { editor: Editor; generation: number; refocus: number }) {
  const text = useInterfaceText()
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<LayerFindScope>('page')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWords, setWholeWords] = useState(false)
  const [types, setTypes] = useState<ReadonlySet<LayerFindType>>(() => new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(480)
  const rowHeight = 32
  const results = useMemo(() => layerFindResults(s.doc, {
    query, scope, pageId: s.page, matchCase, wholeWords, types,
  }), [s.doc, s.page, query, scope, matchCase, wholeWords, types])
  const rows = useMemo(() => {
    const built: FindRow[] = []
    let lastPage = ''
    results.forEach((result, resultIndex) => {
      if (result.pageId !== lastPage) {
        lastPage = result.pageId
        built.push({
          kind: 'heading', key: `page:${result.pageId}`,
          label: scope === 'page' ? text.findThisPage : result.pageName,
        })
      }
      built.push({ kind: 'hit', key: result.id, resultIndex })
    })
    return built
  }, [results, scope, text.findThisPage])
  const selected = s.selection.length === 1 ? { id: s.selection[0], pageId: s.page } : null
  const selectedIndex = selected ? results.findIndex(result => result.id === selected.id && result.pageId === selected.pageId) : -1
  useLayoutEffect(() => {
    const field = input.current
    field?.focus()
    field?.select()
  }, [generation, refocus])
  useEffect(() => {
    const node = list.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height || node.clientHeight || 480))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const host = list.current
    if (!host) return
    const index = rows.findIndex(row => row.kind === 'hit' && row.resultIndex === selectedIndex)
    if (index < 0) return
    const top = index * rowHeight
    const bottom = top + rowHeight
    if (top < host.scrollTop) host.scrollTop = top
    else if (bottom > host.scrollTop + height) host.scrollTop = bottom - height
    setScroll(host.scrollTop)
  }, [rows, selectedIndex, height])
  function move(direction: 1 | -1) {
    const result = adjacentLayerFindResult(results, selectedIndex >= 0 ? results[selectedIndex] : null, direction)
    if (result) locateLayerFindResult(editor, result)
  }
  function toggleType(type: LayerFindType) {
    setTypes(current => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 4)
  const end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 8)
  const trimmed = query.trim()
  return <div className="layer-find" data-layer-find="open" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (filterOpen || settingsOpen) { setFilterOpen(false); setSettingsOpen(false); return }
      closeLayerFind()
      return
    }
    if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (event.target !== input.current) return
      move(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1)
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      event.stopPropagation()
      input.current?.select()
    }
  }}>
    <label className="layer-search">
      <Search size={13} />
      <input ref={input} aria-label={text.searchLayers} placeholder={text.searchLayersPlaceholder} value={query}
        onChange={event => { setQuery(event.target.value); setScroll(0); if (list.current) list.current.scrollTop = 0 }} />
    </label>
    <div className="layer-find-toolbar">
      <button type="button" aria-pressed={scope === 'page'} onClick={() => setScope('page')}>{text.findThisPage}</button>
      <button type="button" aria-pressed={scope === 'file'} onClick={() => setScope('file')}>{text.findAllPages}</button>
      <button type="button" aria-expanded={filterOpen} aria-controls="layer-find-types" onClick={() => { setFilterOpen(open => !open); setSettingsOpen(false) }}>{text.findFilterTypes}</button>
      <button type="button" aria-expanded={settingsOpen} aria-controls="layer-find-settings" onClick={() => { setSettingsOpen(open => !open); setFilterOpen(false) }}>{text.findSettings}</button>
    </div>
    {filterOpen && <div id="layer-find-types" className="layer-find-options">
      {layerFindTypes.map(type => <label key={type}>
        <input type="checkbox" checked={types.has(type)} onChange={() => toggleType(type)} />
        {text[typeTextKey[type]]}
      </label>)}
    </div>}
    {settingsOpen && <div id="layer-find-settings" className="layer-find-options">
      <label><input type="checkbox" checked={matchCase} onChange={() => setMatchCase(value => !value)} />{text.findMatchCase}</label>
      <label><input type="checkbox" checked={wholeWords} onChange={() => setWholeWords(value => !value)} />{text.findWholeWords}</label>
    </div>}
    <div className="layer-find-nav">
      <button type="button" aria-label={text.findPrevious} disabled={!results.length || selectedIndex === 0} onMouseDown={event => event.preventDefault()} onClick={() => move(-1)}>{text.findPrevious}</button>
      <button type="button" aria-label={text.findNext} disabled={!results.length || selectedIndex === results.length - 1} onMouseDown={event => event.preventDefault()} onClick={() => move(1)}>{text.findNext}</button>
      <span role="status">{trimmed ? (results.length ? (selectedIndex >= 0 ? `${selectedIndex + 1} / ${results.length}` : `${results.length}`) : text.findEmpty) : text.findPrompt}</span>
    </div>
    <div className="layer-list" role="listbox" aria-label={text.findResults} ref={list} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset
          const top = index * rowHeight
          if (row.kind === 'heading') return <div key={row.key} className="layer-find-page" style={{ position: 'absolute', top, left: 0, right: 0, height: rowHeight }}>{row.label}</div>
          const result = results[row.resultIndex]
          return <button key={row.key} type="button" role="option" className="layer-row" data-find-type={result.type} data-find-id={result.id}
            aria-selected={row.resultIndex === selectedIndex} style={{ position: 'absolute', top, left: 0, right: 0, height: rowHeight }}
            onMouseDown={event => event.preventDefault()} onClick={() => locateLayerFindResult(editor, result)}>
            <span className="layer-find-kind">{text[typeTextKey[result.type]]}</span>
            <span className="layer-name">{result.name}</span>
          </button>
        })}
      </div>
    </div>
  </div>
}
