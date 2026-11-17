import { memo, useId, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DesktopSession } from './desktop-session'
import { useInterfacePreferences } from './interface-preference'
import { blank } from './model'

export const WorkspaceTabs = memo(function WorkspaceTabs({ session, activeId, placement = 'bar' }: {
  session: DesktopSession
  activeId: string
  placement?: 'bar' | 'sidebar'
}) {
  const tabs = useSyncExternalStore(session.subscribeTabs, session.tabsSnapshot)
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const listId = useId()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  async function run(work: () => Promise<boolean>) {
    if (busy) return
    setBusy(true)
    try { await work() } finally { setBusy(false) }
  }
  const copy = en
    ? { tabs: 'Design document tabs', documents: 'Documents', hide: 'Hide document list', show: 'Show document list', create: 'New document tab', close: (name: string) => `Close ${name}` }
    : { tabs: '设计文档标签', documents: '文档', hide: '隐藏文档列表', show: '显示文档列表', create: '新建文档标签', close: (name: string) => `关闭文档 ${name}` }
  const switchTo = (id: string) => { if (id !== activeId) void run(() => session.requestWorkspaceTab(id)) }
  const closeTab = (id: string) => { void run(() => session.closeWorkspaceTab(id)) }
  const createTab = () => { void run(() => session.replace(blank())) }
  if (placement === 'sidebar') {
    return <section className="layers-documents" data-sketch-documents data-workspace-tabs data-documents-expanded={open} aria-label={copy.documents}>
      <div className="pages-heading">
        <button type="button" className="pages-current" aria-expanded={open} aria-controls={listId} aria-label={open ? copy.hide : copy.show}
          onClick={() => setOpen(value => !value)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{copy.documents}</span>
        </button>
        <button type="button" className="workspace-tab-new" aria-label={copy.create} disabled={busy} onClick={createTab}>＋</button>
      </div>
      <div id={listId} className="sketch-document-list" role="listbox" aria-label={copy.documents} hidden={!open}>
        {tabs.map(tab => <div key={tab.id} className="sketch-document-row" role="presentation" data-document-id={tab.id}>
          <button type="button" role="option" className="sketch-document-switch" aria-selected={tab.id === activeId}
            disabled={busy || (!tab.persisted && tab.id !== activeId)} onClick={() => switchTo(tab.id)}>
            <span className="sketch-document-name" title={tab.name}>{tab.name}</span>
            {tab.id === activeId && <span className="page-dot" />}
          </button>
          <button type="button" className="workspace-tab-close" aria-label={copy.close(tab.name)} disabled={busy} onClick={() => closeTab(tab.id)}>×</button>
        </div>)}
      </div>
    </section>
  }
  return <nav className="workspace-tabs" data-workspace-tabs aria-label={copy.tabs}>
    <div role="tablist">{tabs.map(tab => <div key={tab.id} className={tab.id === activeId ? 'workspace-tab active' : 'workspace-tab'}>
      <button role="tab" aria-selected={tab.id === activeId} disabled={busy || (!tab.persisted && tab.id !== activeId)} onClick={() => switchTo(tab.id)}>{tab.name}</button>
      <button className="workspace-tab-close" aria-label={copy.close(tab.name)} disabled={busy} onClick={() => closeTab(tab.id)}>×</button>
    </div>)}</div>
    <button className="workspace-tab-new" aria-label={copy.create} disabled={busy} onClick={createTab}>＋</button>
  </nav>
})
