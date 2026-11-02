import { useState, useSyncExternalStore } from 'react'
import type { DesktopSession } from './desktop-session'
import { useInterfacePreferences } from './interface-preference'
import { blank } from './model'

export function WorkspaceTabs({ session, activeId }: { session: DesktopSession; activeId: string }) {
  const tabs = useSyncExternalStore(session.subscribeTabs, session.tabsSnapshot)
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const [busy, setBusy] = useState(false)
  async function open(work: () => Promise<boolean>) { if (busy) return; setBusy(true); try { await work() } finally { setBusy(false) } }
  return <nav className="workspace-tabs" data-workspace-tabs aria-label={en ? 'Design document tabs' : '设计文档标签'}>
    <div role="tablist">{tabs.map(tab => <div key={tab.id} className={tab.id === activeId ? 'workspace-tab active' : 'workspace-tab'}>
      <button role="tab" aria-selected={tab.id === activeId} disabled={busy || (!tab.persisted && tab.id !== activeId)} onClick={() => { if (tab.id !== activeId) void open(() => session.requestWorkspaceTab(tab.id)) }}>{tab.name}</button>
      <button className="workspace-tab-close" aria-label={en ? `Close ${tab.name}` : `关闭文档 ${tab.name}`} disabled={busy} onClick={() => void open(() => session.closeWorkspaceTab(tab.id))}>×</button>
    </div>)}</div>
    <button className="workspace-tab-new" aria-label={en ? 'New document tab' : '新建文档标签'} disabled={busy} onClick={() => void open(() => session.replace(blank()))}>＋</button>
  </nav>
}
