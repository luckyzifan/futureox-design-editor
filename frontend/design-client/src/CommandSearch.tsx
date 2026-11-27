import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { commandSearchEntries, commandSearchCopy, commandSearchGroupLabel, filterCommandSearch, runCommandSearch, type CommandSearchEntry } from './command-search'
import { closeCommandSearch, commandSearchReturnTarget, commandSearchSnapshot, requestCommandSearch, subscribeCommandSearch } from './command-search-session'
import { desktopBridge } from './desktop'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { useModalOwnership } from './modal-keyboard'
import { hasPendingEdits } from './pending-edits'
import { shortcutPlatform } from './shortcut-profiles'
import { useShortcutProfile } from './shortcut-preference'
import './command-search.css'

/** Global command search. Query, highlight and focus live in the shell, not the document. */
export function CommandSearch({ editor }: { editor: Editor }) {
  const token = useSyncExternalStore(subscribeCommandSearch, commandSearchSnapshot, () => 0)
  if (!token) return null
  return createPortal(<CommandSearchDialog key={token} editor={editor} />, document.body)
}

function CommandSearchDialog({ editor }: { editor: Editor }) {
  const { locale, uiMode } = useInterfacePreferences()
  const profile = useShortcutProfile()
  const text = commandSearchCopy(uiMode, locale)
  const listId = useId()
  const dialog = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const filterMenu = useRef<HTMLDivElement>(null)
  const running = useRef(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [group, setGroup] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const revision = useSyncExternalStore(editor.subscribe, () => [
    editor.state.version, editor.state.selection.join('\n'), editor.state.tool, editor.state.page,
    editor.state.busy, editor.interactionActive, editor.canUndo, editor.canRedo,
  ].join('|'), () => '')
  const context = useMemo(() => ({ profile, platform: shortcutPlatform(), desktop: !!desktopBridge(), uiMode }), [profile, uiMode])
  const entries = useMemo(() => commandSearchEntries(editor, context, locale), [editor, context, locale, revision])
  const groups = useMemo(() => [...new Set(entries.map(entry => entry.group))], [entries])
  const scoped = useMemo(() => group ? entries.filter(entry => entry.group === group) : entries, [entries, group])
  const filtered = useMemo(() => filterCommandSearch(scoped, query), [scoped, query])
  const index = filtered.length ? Math.min(active, filtered.length - 1) : 0
  const selected = filtered[index]
  useModalOwnership(dialog, input, commandSearchReturnTarget())
  useEffect(() => {
    const option = selected ? document.getElementById(`${listId}-${selected.id}`) : null
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, listId])
  useEffect(() => {
    if (filterOpen) filterMenu.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [filterOpen])
  const closeFilter = () => {
    setFilterOpen(false)
    input.current?.focus()
  }
  const chooseGroup = (next: string | null) => {
    setGroup(next); setActive(0); setQuery(''); closeFilter()
  }
  const activate = async (entry: CommandSearchEntry | undefined) => {
    if (!entry || entry.disabled || running.current) return
    running.current = true
    const before = editor.state.doc
    const pending = hasPendingEdits(editor)
    const reopen = commandSearchReturnTarget()
    // Drop the modal before dispatch. The shared command path refuses work while a dialog owns the keyboard.
    flushSync(() => closeCommandSearch())
    try { await runCommandSearch(editor, entry, context) }
    finally { running.current = false }
    if (pending && hasPendingEdits(editor) && editor.state.doc === before) requestCommandSearch(reopen)
  }
  return <div className="command-search-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); closeCommandSearch() } }}>
    <section ref={dialog} className="command-search-dialog" role="dialog" aria-modal="true" aria-labelledby={`${listId}-title`}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        const primary = shortcutPlatform() === 'mac' ? event.metaKey : event.ctrlKey
        if (primary && !event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          if (!event.repeat) {
            if (filterOpen) closeFilter()
            else setFilterOpen(true)
          }
          return
        }
        // Sketch Command Bar: ⌘↑ enters the selected group or goes back to all
        // commands; ⌥⌘↑ always returns to all commands.
        if (primary && event.altKey && event.key === 'ArrowUp') {
          event.preventDefault()
          if (event.repeat) return
          setGroup(null); setActive(0); closeFilter()
          return
        }
        if (primary && !event.altKey && event.key === 'ArrowUp') {
          event.preventDefault()
          if (event.repeat) return
          setGroup(current => current ? null : selected?.group ?? current)
          setActive(0)
          closeFilter()
          return
        }
        if (filterOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End')) {
          event.preventDefault()
          const buttons = [...(filterMenu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          if (!buttons.length) return
          const at = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : event.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length
          buttons[next]?.focus()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault(); if (!event.repeat) { if (filterOpen) closeFilter(); else closeCommandSearch() }
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!filtered.length) return
          setActive(current => {
            const start = Math.min(current, filtered.length - 1)
            return event.key === 'ArrowDown' ? (start + 1) % filtered.length : (start - 1 + filtered.length) % filtered.length
          })
          return
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          if (filtered.length) setActive(event.key === 'Home' ? 0 : filtered.length - 1)
          return
        }
        if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault()
          if (!event.repeat) void activate(selected)
        }
      }}>
      <header>
        <h2 id={`${listId}-title`}>{text.title}</h2>
        <button type="button" className="command-search-filter" aria-haspopup="menu" aria-expanded={filterOpen}
          aria-label={text.filter} onClick={() => setFilterOpen(open => !open)}>
          {group ? commandSearchGroupLabel(group, locale) : text.filter}
        </button>
        <button type="button" aria-label={text.close} onClick={() => closeCommandSearch()}>×</button>
      </header>
      {filterOpen && <div ref={filterMenu} className="command-search-filter-menu" role="menu" aria-label={text.resultGroup}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault(); event.stopPropagation(); closeFilter()
        }}>
        <button type="button" role="menuitemradio" aria-checked={!group} onClick={() => chooseGroup(null)}>{text.allCommands}</button>
        {groups.map(item => <button type="button" role="menuitemradio" key={item} aria-checked={group === item}
          onClick={() => chooseGroup(item)}>{commandSearchGroupLabel(item, locale)}</button>)}
      </div>}
      <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined} aria-label={text.search}
        placeholder={text.placeholder} value={query} onFocus={() => setFilterOpen(false)}
        onChange={event => { setQuery(event.target.value); setActive(0) }} />
      {filtered.length ? <div id={listId} className="command-search-list" role="listbox" aria-label={text.search}>
        {filtered.map((entry, entryIndex) => <button type="button" key={entry.id} id={`${listId}-${entry.id}`} role="option"
          className="command-search-option" data-command={entry.id} aria-selected={entryIndex === index}
          aria-disabled={entry.disabled || undefined} onMouseMove={() => setActive(entryIndex)}
          onClick={() => void activate(entry)}>
          <b>{entry.label}</b>
          {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : <span />}
          {entry.reason ? <span className="command-search-reason">{entry.reason}</span> : null}
        </button>)}
      </div> : <p className="command-search-empty" role="status">{text.empty}</p>}
    </section>
  </div>
}
