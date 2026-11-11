import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { commandSearchEntries, commandSearchText, filterCommandSearch, runCommandSearch, type CommandSearchEntry } from './command-search'
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
  const { locale } = useInterfacePreferences()
  const profile = useShortcutProfile()
  const text = commandSearchText[locale]
  const listId = useId()
  const dialog = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = useRef(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const revision = useSyncExternalStore(editor.subscribe, () => [
    editor.state.version, editor.state.selection.join('\n'), editor.state.tool, editor.state.page,
    editor.state.busy, editor.interactionActive, editor.canUndo, editor.canRedo,
  ].join('|'), () => '')
  const context = useMemo(() => ({ profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }), [profile])
  const entries = useMemo(() => commandSearchEntries(editor, context, locale), [editor, context, locale, revision])
  const filtered = useMemo(() => filterCommandSearch(entries, query), [entries, query])
  const index = filtered.length ? Math.min(active, filtered.length - 1) : 0
  const selected = filtered[index]
  useModalOwnership(dialog, input, commandSearchReturnTarget())
  useEffect(() => {
    const option = selected ? document.getElementById(`${listId}-${selected.id}`) : null
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, listId])
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
        if (event.key === 'Escape') { event.preventDefault(); if (!event.repeat) closeCommandSearch(); return }
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
        if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) void activate(selected) }
      }}>
      <header>
        <h2 id={`${listId}-title`}>{text.title}</h2>
        <button type="button" aria-label={text.close} onClick={() => closeCommandSearch()}>×</button>
      </header>
      <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined} aria-label={text.search}
        placeholder={text.placeholder} value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} />
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
