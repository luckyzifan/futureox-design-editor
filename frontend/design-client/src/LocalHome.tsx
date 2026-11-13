import { webPath } from './web-path'
import { useEffect,useLayoutEffect,useRef,useState,type ReactNode } from 'react'
import { File,FolderOpen,Grid2X2,List,Plus,Search,Settings } from 'lucide-react'
import { FileMark } from './chrome-icons'
import { sourceErrorKind, sourceErrorSummary } from './source-error-text'
import { useInterfacePreferences, useInterfaceText } from './interface-preference'
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

export function LocalHome({source,ready,busy=false,startupError,importError,currentName,onResume,onNew,onOpenFile,onSettings,onServerWorkspace}: {
 source:HomeSource;ready:boolean;busy?:boolean;startupError?:string;importError?:string;currentName:string
 onResume:()=>void;onNew:()=>Promise<boolean>;onOpenFile:()=>Promise<boolean|'pending'>;onSettings:()=>void;onServerWorkspace?:()=>void
}) {
 const { locale } = useInterfacePreferences()
 const text = useInterfaceText()
 const [entries,setEntries]=useState<HomeEntry[]>([]),[query,setQuery]=useState(''),[layout,setLayout]=useState<'grid'|'list'>('grid')
 const [loading,setLoading]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const root=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),alive=useRef(false),ticket=useRef(0),operation=useRef(false),latest=useRef(source)
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
  const background=[...(shell?.querySelectorAll<HTMLElement>(':scope > header,:scope > main.editor-workspace,:scope > nav[data-workspace-tabs],:scope > footer')||[])].map(element=>({element,inert:element.getAttribute('inert')}))
  background.forEach(({element})=>element.setAttribute('inert',''));search.current?.focus()
  return()=>{background.forEach(({element,inert})=>inert===null?element.removeAttribute('inert'):element.setAttribute('inert',inert));if(previous instanceof HTMLElement&&previous.isConnected&&!previous.closest('[inert]'))previous.focus({preventScroll:true})}
 },[])
 async function refresh(){
  const own=++ticket.current;setLoading(true);setError('')
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
 const disabled=!ready||busy||working,visible=entries.filter(e=>e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
 const continueLabel = locale === 'en' ? `Continue editing · ${currentName}` : `继续编辑 · ${currentName}`
 const savedWhere = source.kind === 'web-local' ? text.savedInBrowser : text.savedOnComputer
 return <section ref={root} className="local-home" aria-label={text.localDesignHome} aria-busy={loading||working||!ready} onKeyUp={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!disabled){e.preventDefault();onResume()}}}>
  <aside className="local-home-sidebar"><div className="local-home-brand"><img className="brand-mark" src={webPath('/branding/futureox-desgin.svg')} width="28" height="28" alt="" /><strong>Futureox Design</strong></div><div className="local-home-identity"><span aria-hidden="true">a</span><div><strong>admin</strong><small>{text.localWorkspace}</small></div></div>
   <nav aria-label={text.homeSections}><button type="button" aria-current="page"><File size={16}/>{text.designRecentFiles}</button>
    {onServerWorkspace&&<button type="button" disabled={disabled} onClick={onServerWorkspace}><FolderOpen size={16}/>{locale==='en'?'Server workspace':'服务器工作区'}</button>}
    <button type="button" disabled={working || (ready && busy)} onClick={onSettings}><Settings size={16}/>{text.settingsTitle}</button></nav>
   <p>{text.localIdentityNote}</p>
  </aside>
  <div className="local-home-content"><header><div><h1>{text.recentDesignsTitle}</h1><p>{savedWhere}</p></div><button type="button" disabled={disabled} onClick={onResume}>{continueLabel}</button></header>
   <div className="local-home-actions"><button type="button" disabled={disabled} onClick={()=>void run(onNew)}><Plus size={17}/>{text.newDesign}</button><button type="button" disabled={disabled} onClick={()=>void run(onOpenFile)}><FolderOpen size={17}/>{text.openDesignFile}</button></div>
   <div className="local-home-filter"><label><Search size={16}/><input ref={search} aria-label={text.searchRecentDesigns} placeholder={text.searchDesignNames} value={query} onChange={e=>setQuery(e.target.value)}/></label><button type="button" disabled={loading||disabled} onClick={()=>void refresh()}>{text.refresh}</button><div role="group" aria-label={text.fileDisplay}><button type="button" aria-label={text.gridDisplay} aria-pressed={layout==='grid'} onClick={()=>setLayout('grid')}><Grid2X2 size={17}/></button><button type="button" aria-label={text.listDisplay} aria-pressed={layout==='list'} onClick={()=>setLayout('list')}><List size={17}/></button></div></div>
   {(error||importError)&&<p role="alert" className="local-home-error">{shown(error||importError||'')}</p>}{notice&&<p role="status">{shown(notice)}</p>}
   {!ready?<p className="activity-line" role={startupError?"alert":"status"}>{shown(startupError||"正在读取本机设计…")} {shown("文档操作暂不可用，仍可调整本机设置。")}{!startupError&&<span className="activity-track" aria-hidden="true"><i/></span>}</p>:loading?<p className="activity-line" role="status">{shown("正在读取本机设计…")}<span className="activity-track" aria-hidden="true"><i/></span></p>:<div className={`local-home-files ${layout}`} aria-label={text.recentDesignList}>{visible.map(entry=>{
    const when = new Date(entry.updatedAt).toLocaleString()
    const meta = locale === 'en' ? `Version ${entry.revision} · Updated ${when}` : `版本 ${entry.revision} · 更新于 ${when}`
    return <button type="button" className="local-home-file" key={entry.id} disabled={disabled} onClick={()=>void run(()=>latest.current.open(entry.id))}>
    <span className="local-home-placeholder" aria-hidden="true"><FileMark kind="fd" size={40}/></span><span className="local-home-file-meta"><strong>{entry.name}</strong><small>{meta}</small></span>
   </button>})}{!visible.length&&<p className="local-home-empty">{query?text.noMatchingDesigns:source.kind==='desktop-files'?text.desktopFilesEmpty:text.noSavedDesigns}</p>}</div>}
  </div>
 </section>
}
