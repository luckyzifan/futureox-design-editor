import { useState, useSyncExternalStore } from 'react'
import type { DesktopSession } from './desktop-session'
import { blank } from './model'
export function WorkspaceTabs({session,activeId}:{session:DesktopSession;activeId:string}) {
  const tabs=useSyncExternalStore(session.subscribeTabs,session.tabsSnapshot)
  const [busy,setBusy]=useState(false)
  async function open(work:()=>Promise<boolean>){if(busy)return;setBusy(true);try{await work()}finally{setBusy(false)}}
  return <nav aria-label="设计文档标签" style={{display:'flex',flexShrink:0,minHeight:32,overflowX:'auto',background:'#f5f5f5',borderBottom:'1px solid #e5e5e5'}}>
    <div role="tablist" style={{display:'flex'}}>{tabs.map(tab=><div key={tab.id} style={{display:'flex',alignItems:'center',background:tab.id===activeId?'#fff':undefined,borderRight:'1px solid #e5e5e5'}}>
      <button role="tab" aria-selected={tab.id===activeId} disabled={busy||(!tab.persisted&&tab.id!==activeId)} onClick={()=>{if(tab.id!==activeId)void open(()=>session.openWorkspace(tab.id))}} style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',borderRadius:0,padding:'7px 12px'}}>{tab.name}</button>
      <button aria-label={`关闭文档 ${tab.name}`} disabled={busy} onClick={()=>void open(()=>session.closeWorkspaceTab(tab.id))}>×</button>
    </div>)}</div>
    <button aria-label="新建文档标签" disabled={busy} onClick={()=>void open(()=>session.replace(blank()))} style={{minWidth:32}}>＋</button>
  </nav>
}
