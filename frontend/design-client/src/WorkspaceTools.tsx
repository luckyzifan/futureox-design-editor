import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, Search } from 'lucide-react'
import type { GlyphIcon } from './chrome-icons'
import { useInterfacePreferences } from './interface-preference'

export type WorkspaceToolGroup = {
  label: string
  items: { label: string; icon: GlyphIcon; shortcut?: string; disabled?: boolean; activate: () => void }[]
}

export function WorkspaceTools({ title, groups, onClose }: {
  title: ReactNode
  groups: WorkspaceToolGroup[]
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const en = locale === 'en'
  const label = en ? 'Tools' : '工具'
  const queryLabel = en ? 'Search tools' : '搜索工具'
  const wanted = query.trim().toLocaleLowerCase(locale)
  const filtered = groups.map(group => ({ ...group, items: group.items.filter(item =>
    `${item.label} ${item.shortcut ?? ''} ${group.label}`.toLocaleLowerCase(locale).includes(wanted),
  ) })).filter(group => group.items.length > 0)
  useEffect(() => { search.current?.focus({ preventScroll: true }) }, [])
  return <aside className="workspace-tool-panel" aria-label={label} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      if (query) setQuery('')
      else onClose()
    }
  }}>
    {title}
    <div className="workspace-tool-search">
      <h2>{label}</h2>
      <label>
        <Search size={14} aria-hidden="true" />
        <input ref={search} type="search" value={query} aria-label={queryLabel} placeholder={queryLabel}
          onChange={event => setQuery(event.currentTarget.value)} />
      </label>
    </div>
    <div className="workspace-tool-list">
      {filtered.map(group => <section key={group.label} aria-label={group.label}>
        <h3>{group.label}</h3>
        {group.items.map(({ label, icon: Icon, shortcut, disabled, activate }) =>
          <button key={label} type="button" aria-label={label} disabled={disabled} onClick={activate}>
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
            {shortcut ? <kbd>{shortcut}</kbd> : <ArrowUpRight size={13} aria-hidden="true" />}
          </button>)}
      </section>)}
      {!filtered.length && <p role="status">{en ? 'No matching tools' : '未找到匹配的工具'}</p>}
    </div>
  </aside>
}
