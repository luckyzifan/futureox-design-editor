import { webPath } from './web-path'
import { useEffect,useLayoutEffect,useRef,useState,type ReactNode } from 'react'
import { File,FolderOpen,Grid2X2,List,MoreVertical,Plus,Search,Settings } from 'lucide-react'
import { FileMark } from './chrome-icons'
import { sourceErrorKind, sourceErrorSummary } from './source-error-text'
import { useInterfacePreferences, useInterfaceText } from './interface-preference'
import { UiModeSwitch } from './UiModeSwitch'
import { translateProfessional } from './professional-dialog-messages'
import type { HomeEntry,HomeSource } from './local-home-source'
import './local-home.css'

/** Initial Home never mounts the renderer. Once entered, retain its component
 * identity across Home visits; hiding is not a promise to suspend in-flight GPU work. */
export function HomeCanvasGate({home,children}:{home:boolean;children:ReactNode}) {
 const [admitted,setAdmitted]=useState(!home)
 useEffect(()=>{if(!home)setAdmitted(true)},[home])
 return !home||admitted?children:null
}

export function LocalHome({source,ready,busy=false,startupError,importError,currentName,chooseLayout=false,onResume,onNew,onOpenFile,onSettings,onServerWorkspace}: {
 source:HomeSource;ready:boolean;busy?:boolean;startupError?:string;importError?:string;currentName:string;chooseLayout?:boolean
 onResume:()=>void;onNew:()=>Promise<boolean>;onOpenFile:()=>Promise<boolean|'pending'>;onSettings:()=>void;onServerWorkspace?:()=>void
}) {
 const { locale } = useInterfacePreferences()
 const text = useInterfaceText()
 // Keep the chooser available for this visit if the user changes their layout.
 const [layoutEntry] = useState(chooseLayout)
 const [entries,setEntries]=useState<HomeEntry[]>([]),[query,setQuery]=useState(''),[layout,setLayout]=useState<'grid'|'list'>('grid'),[sort,setSort]=useState<'updated'|'name'>('updated')
 const [loading,setLoading]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const [menuFor,setMenuFor]=useState<string|null>(null),[renaming,setRenaming]=useState<{id:string;name:string}|null>(null)
 const root=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),alive=useRef(false),ticket=useRef(0),operation=useRef(false),latest=useRef(source),composing=useRef(false)
 latest.current=source
 const knownStatus = (value: string) => {
  const table: Record<string, string> = {
   '读取本机设计失败': text.readLocalDesignsFailed,
   '操作已取消或未完成，当前设计已保留。': text.operationCancelledDesignKept,
   '打开失败，当前设计已保留': text.openFailedDesignKept,
   '正在读取本机设计…': text.readingLocalDesigns,
   '文档操作暂不可用，仍可调整本机设置。': text.documentActionsUnavailable,
   '本地恢复失败，文档操作和自动保存已暂停。': text.localRecoveryPaused,
  }
  if (table[value]) return table[value]
  return sourceErrorKind(value) === 'window' ? sourceErrorSummary(value) : value
 }
 const shown = (value: string) => translateProfessional(knownStatus(value), locale)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++}},[])
 useLayoutEffect(()=>{
  const shell=root.current?.parentElement,previous=document.activeElement
  const background=[...(shell?.querySelectorAll<HTMLElement>(':scope > header,:scope > main.editor-workspace,:scope > nav[data-workspace-tabs]:not([data-document-chooser-strip]),:scope > footer')||[])].map(element=>({element,inert:element.getAttribute('inert')}))
  background.forEach(({element})=>element.setAttribute('inert',''));search.current?.focus()
  return()=>{background.forEach(({element,inert})=>inert===null?element.removeAttribute('inert'):element.setAttribute('inert',inert));if(previous instanceof HTMLElement&&previous.isConnected&&!previous.closest('[inert]'))previous.focus({preventScroll:true})}
 },[])
 async function refresh(keepError=false){
  const own=++ticket.current;setLoading(true);if(!keepError)setError('')
  try{const values=await latest.current.list();if(alive.current&&ticket.current===own)setEntries(values.filter(e=>!e.deleted).sort((a,b)=>b.updatedAt-a.updatedAt))}
  catch(e){if(alive.current&&ticket.current===own)setError(e instanceof Error?e.message:'读取本机设计失败')}
  finally{if(alive.current&&ticket.current===own)setLoading(false)}
 }
 useEffect(()=>{if(ready)void refresh()},[ready,source.kind])
 async function run(work:()=>Promise<boolean|'pending'>){
  if(operation.current||busy||!ready)return
  operation.current=true;setWorking(true);setError('');setNotice('')
  try{const result=await work();if(!alive.current)return;if(result===true)onResume();else if(result===false)setNotice('操作已取消或未完成，当前设计已保留。')}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'打开失败，当前设计已保留')}
  finally{operation.current=false;if(alive.current)setWorking(false)}
 }
 /** Metadata operations stay on Home: refresh on completion, keep the editor
  * snapshot untouched, and surface cancellations through the same notice path. */
 async function operate(work:()=>Promise<boolean>){
  if(operation.current||busy||!ready)return
  operation.current=true;setWorking(true);setError('');setNotice('')
  try{const ok=await work();if(alive.current&&!ok)setNotice('操作已取消或未完成，当前设计已保留。')}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'打开失败，当前设计已保留')}
  finally{operation.current=false;if(alive.current){setWorking(false);void refresh(true)}}
 }
 function commitRename(id:string,value:string){
  const previous=renaming
  setRenaming(null)
  if(!previous||previous.id!==id||!latest.current.ops)return
  const trimmed=value.trim()
  if(!trimmed||trimmed===previous.name)return
  void operate(()=>latest.current.ops!.rename(id,trimmed))
 }
 const disabled=!ready||busy||working,visible=entries.filter(e=>e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
 const ordered=sort==='name'?[...visible].sort((a,b)=>a.name.localeCompare(b.name,locale==='en'?'en':'zh-Hans')):visible
 const continueLabel = locale === 'en' ? `Continue editing · ${currentName}` : `继续编辑 · ${currentName}`
 const savedWhere = source.kind === 'web-local' ? text.savedInBrowser : text.savedOnComputer
 return <section ref={root} className="local-home" aria-label={text.localDesignHome} aria-busy={loading||working||!ready} onKeyUp={e=>e.stopPropagation()} onClick={e=>{if(menuFor&&!(e.target instanceof Element&&e.target.closest('.local-home-entry')))setMenuFor(null)}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!disabled){e.preventDefault();if(renaming){setRenaming(null);return}if(menuFor){setMenuFor(null);return}onResume()}}}>
  <aside className="local-home-sidebar"><div className="local-home-brand"><img className="brand-mark" src={webPath('/branding/futureox-desgin.svg')} width="28" height="28" alt="" /><strong>Futureox Design</strong></div><div className="local-home-identity"><span aria-hidden="true">a</span><div><strong>admin</strong><small>{text.localWorkspace}</small></div></div>
   <nav aria-label={text.homeSections}><button type="button" aria-current="page"><File size={16}/>{text.designRecentFiles}</button>
    {onServerWorkspace&&<button type="button" disabled={disabled} onClick={onServerWorkspace}><FolderOpen size={16}/>{locale==='en'?'Server workspace':'服务器工作区'}</button>}
    <button type="button" disabled={working || (ready && busy)} onClick={onSettings}><Settings size={16}/>{text.settingsTitle}</button></nav>
   <p>{text.localIdentityNote}</p>
  </aside>
  <div className="local-home-content"><header><div><h1>{text.recentDesignsTitle}</h1><p>{savedWhere}</p></div><button type="button" disabled={disabled} onClick={onResume}>{continueLabel}</button></header>
   {layoutEntry && <div className="local-home-layout-choice">
    <span>{locale === 'en' ? 'Workspace layout' : '工作区布局'}</span>
    <UiModeSwitch disabled={busy || working} />
   </div>}
   <div className="local-home-actions"><button type="button" disabled={disabled} onClick={()=>void run(onNew)}><Plus size={17}/>{text.newDesign}</button><button type="button" disabled={disabled} onClick={()=>void run(onOpenFile)}><FolderOpen size={17}/>{text.openDesignFile}</button></div>
   <div className="local-home-filter"><label><Search size={16}/><input ref={search} aria-label={text.searchRecentDesigns} placeholder={text.searchDesignNames} value={query} onChange={e=>setQuery(e.target.value)}/></label><button type="button" disabled={loading||disabled} onClick={()=>void refresh()}>{text.refresh}</button><div role="group" aria-label={text.fileDisplay}><button type="button" aria-label={text.gridDisplay} aria-pressed={layout==='grid'} onClick={()=>setLayout('grid')}><Grid2X2 size={17}/></button><button type="button" aria-label={text.listDisplay} aria-pressed={layout==='list'} onClick={()=>setLayout('list')}><List size={17}/></button></div><div role="group" className="local-home-sort" aria-label={text.sortDesigns}><button type="button" aria-pressed={sort==='updated'} onClick={()=>setSort('updated')}>{text.sortByUpdated}</button><button type="button" aria-pressed={sort==='name'} onClick={()=>setSort('name')}>{text.sortByName}</button></div></div>
   {(error||importError)&&<p role="alert" className="local-home-error">{shown(error||importError||'')}</p>}{notice&&<p role="status">{shown(notice)}</p>}
   {!ready?<p className="activity-line" role={startupError?"alert":"status"}>{shown(startupError||"正在读取本机设计…")} {shown("文档操作暂不可用，仍可调整本机设置。")}{!startupError&&<span className="activity-track" aria-hidden="true"><i/></span>}</p>:loading?<p className="activity-line" role="status">{shown("正在读取本机设计…")}<span className="activity-track" aria-hidden="true"><i/></span></p>:<div className={`local-home-files ${layout}`} aria-label={text.recentDesignList}>{ordered.map(entry=>{
    const when = new Date(entry.updatedAt).toLocaleString()
    const meta = locale === 'en' ? `Version ${entry.revision} · Updated ${when}` : `版本 ${entry.revision} · 更新于 ${when}`
    const editing = renaming?.id === entry.id ? renaming : null
    const card = <><span className="local-home-placeholder" aria-hidden="true"><FileMark kind="fd" size={40}/></span>
     <span className="local-home-file-meta">
      {editing
       ?<input className="local-home-rename" aria-label={text.renameDesignField} defaultValue={editing.name} autoFocus
         onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}}
         onKeyDown={e=>{if(composing.current||e.nativeEvent.isComposing)return
          if(e.key==='Enter'&&!e.repeat){e.preventDefault();commitRename(entry.id,e.currentTarget.value)}
          if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setRenaming(null)}}}
         onBlur={e=>commitRename(entry.id,e.currentTarget.value)}/>
       :<strong>{entry.name}</strong>}
      <small>{meta}</small>
     </span></>
    return <div className="local-home-entry" key={entry.id} onContextMenu={e=>{if(!latest.current.ops||disabled)return;e.preventDefault();setRenaming(null);setMenuFor(entry.id)}}>
    {editing ? <div className="local-home-file">{card}</div> :
      <button type="button" className="local-home-file" disabled={disabled} onClick={()=>void run(()=>latest.current.open(entry.id))}>{card}</button>}
    {latest.current.ops&&!disabled&&<button type="button" className="local-home-entry-menu" aria-label={`${text.designEntryActions} · ${entry.name}`} aria-haspopup="menu" aria-expanded={menuFor===entry.id} onClick={()=>{setRenaming(null);setMenuFor(menuFor===entry.id?null:entry.id)}}><MoreVertical size={16}/></button>}
    {menuFor===entry.id&&<div role="menu" className="local-home-entry-actions" aria-label={`${text.designEntryActions} · ${entry.name}`}>
     <button type="button" role="menuitem" onClick={()=>{setMenuFor(null);void run(()=>latest.current.open(entry.id))}}>{text.openDesignEntry}</button>
     <button type="button" role="menuitem" onClick={()=>{setRenaming({id:entry.id,name:entry.name});setMenuFor(null)}}>{text.renameDesignEntry}</button>
     <button type="button" role="menuitem" onClick={()=>{setMenuFor(null);void operate(()=>latest.current.ops!.duplicate(entry.id))}}>{text.duplicateDesignEntry}</button>
     <button type="button" role="menuitem" onClick={()=>{setMenuFor(null);void operate(()=>latest.current.ops!.trash(entry.id,entry.revision))}}>{text.trashDesignEntry}</button>
    </div>}
   </div>})}{!visible.length&&<p className="local-home-empty">{query?text.noMatchingDesigns:source.kind==='desktop-files'?text.desktopFilesEmpty:text.noSavedDesigns}</p>}</div>}
  </div>
 </section>
}
