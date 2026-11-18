import { useId, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight, File, Plus, X } from 'lucide-react'
import type { DesktopSession } from './desktop-session'
import { useInterfacePreferences } from './interface-preference'
import { blank } from './model'

export function WorkspaceTabs({ session, activeId, sidebar = false, onOpenNewTab }: {
  session: DesktopSession; activeId: string; sidebar?: boolean; onOpenNewTab?: () => void
}) {
  const tabs = useSyncExternalStore(session.subscribeTabs, session.tabsSnapshot)
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const listId = useId()
  async function open(work: () => Promise<boolean>) { if (busy) return; setBusy(true); try { await work() } finally { setBusy(false) } }
  const newDocument = () => void open(() => session.replace(blank()))
  const newLabel = en ? (sidebar ? 'New document' : 'New document tab') : (sidebar ? '新建文档' : '新建文档标签')
  const tabLabel = onOpenNewTab ? (en ? 'Open new tab' : '打开新标签页') : newLabel
  const docsLabel = en ? 'Documents' : '文档'
  const disclosureLabel = en ? (expanded ? 'Hide Document List' : 'Show Document List') : (expanded ? '隐藏文档列表' : '显示文档列表')
  return <nav className={sidebar ? 'workspace-tabs sketch-document-list' : 'workspace-tabs'}
    data-workspace-tabs aria-label={sidebar ? docsLabel : en ? 'Design document tabs' : '设计文档标签'}>
    {sidebar && <div className="sketch-documents-header">
      <button type="button" aria-label={disclosureLabel} title={disclosureLabel} aria-expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{docsLabel}</button>
      <button type="button" title={newLabel} aria-label={newLabel} disabled={busy} onClick={newDocument}><Plus size={15} /></button>
    </div>}
    <div role="tablist" id={listId} aria-label={sidebar ? docsLabel : undefined} aria-orientation={sidebar ? 'vertical' : undefined}
      onKeyDown={sidebar ? event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ||
            !(event.target instanceof HTMLButtonElement) || event.target.getAttribute('role') !== 'tab') return
        const enabled = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
        const at = enabled.indexOf(event.target)
        if (at < 0) return
        event.preventDefault()
        event.stopPropagation()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
          (at + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
        enabled[next]?.focus()
      } : undefined}
      hidden={sidebar && !expanded}>{tabs.map(tab => <div key={tab.id} className={tab.id === activeId ? 'workspace-tab active' : 'workspace-tab'}>
      <button type="button" role="tab" aria-selected={tab.id === activeId} disabled={busy || (!tab.persisted && tab.id !== activeId)}
        tabIndex={sidebar && tab.id !== activeId ? -1 : undefined}
        title={sidebar ? tab.name : undefined} onClick={() => { if (tab.id !== activeId) void open(() => session.requestWorkspaceTab(tab.id)) }}>
        {sidebar && <File size={13} aria-hidden="true" />}<span>{tab.name}</span>
      </button>
      <button type="button" className="workspace-tab-close" aria-label={en ? `Close ${tab.name}` : `关闭文档 ${tab.name}`}
        disabled={busy} onClick={() => void open(() => session.closeWorkspaceTab(tab.id))}>{sidebar ? <X size={13} /> : '×'}</button>
    </div>)}</div>
    {!sidebar && <button type="button" className="workspace-tab-new" aria-label={tabLabel} title={tabLabel}
      disabled={busy} onClick={onOpenNewTab ?? newDocument}>＋</button>}
  </nav>
}
