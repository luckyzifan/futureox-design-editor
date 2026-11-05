import { useEffect,useLayoutEffect,useRef,useState,type ReactNode } from 'react'
import { File,FolderOpen,Grid2X2,List,Plus,Search,Settings } from 'lucide-react'
import { FileMark } from './chrome-icons'
import type { HomeEntry,HomeSource } from './local-home-source'
import './local-home.css'

/** Initial Home never mounts the renderer. Once entered, retain its component
 * identity across Home visits; hiding is not a promise to suspend in-flight GPU work. */
export function HomeCanvasGate({home,children}:{home:boolean;children:ReactNode}) {
 const [admitted,setAdmitted]=useState(!home)
 useEffect(()=>{if(!home)setAdmitted(true)},[home])
 return !home||admitted?children:null
}

export function LocalHome({source,ready,busy=false,startupError,importError,currentName,onResume,onNew,onOpenFile,onSettings}: {
 source:HomeSource;ready:boolean;busy?:boolean;startupError?:string;importError?:string;currentName:string
 onResume:()=>void;onNew:()=>Promise<boolean>;onOpenFile:()=>Promise<boolean|'pending'>;onSettings:()=>void
}) {
 const [entries,setEntries]=useState<HomeEntry[]>([]),[query,setQuery]=useState(''),[layout,setLayout]=useState<'grid'|'list'>('grid')
 const [loading,setLoading]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const root=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null),alive=useRef(false),ticket=useRef(0),operation=useRef(false),latest=useRef(source)
 latest.current=source
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++}},[])
 useLayoutEffect(()=>{
  const shell=root.current?.parentElement,previous=document.activeElement
  const background=[...(shell?.querySelectorAll<HTMLElement>(':scope > header,:scope > main.editor-workspace,:scope > nav[aria-label="设计文档标签"],:scope > footer')||[])].map(element=>({element,inert:element.getAttribute('inert')}))
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
 return <section ref={root} className="local-home" aria-label="本机设计首页" aria-busy={loading||working||!ready} onKeyUp={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!disabled){e.preventDefault();onResume()}}}>
  <aside className="local-home-sidebar"><div className="local-home-brand"><img className="brand-mark" src="/branding/futureox-desgin.svg" width="28" height="28" alt="" /><strong>Futureox Design</strong></div><div className="local-home-identity"><span aria-hidden="true">a</span><div><strong>admin</strong><small>本机工作空间</small></div></div>
   <nav aria-label="首页模块"><button type="button" aria-current="page"><File size={16}/>设计 · 最近文件</button><button type="button" disabled={working || (ready && busy)} onClick={onSettings}><Settings size={16}/>设置</button></nav>
   <p>仅本机使用，不连接后台。admin 是本机显示身份，不授予服务器权限。</p>
  </aside>
  <div className="local-home-content"><header><div><h1>最近的设计</h1><p>保存在{source.kind==='web-local'?'此浏览器':'此电脑'}的作品</p></div><button type="button" disabled={disabled} onClick={onResume}>继续编辑 · {currentName}</button></header>
   <div className="local-home-actions"><button type="button" disabled={disabled} onClick={()=>void run(onNew)}><Plus size={17}/>新建设计</button><button type="button" disabled={disabled} onClick={()=>void run(onOpenFile)}><FolderOpen size={17}/>打开设计文件</button></div>
   <div className="local-home-filter"><label><Search size={16}/><input ref={search} aria-label="搜索最近设计" placeholder="搜索设计名称" value={query} onChange={e=>setQuery(e.target.value)}/></label><button type="button" disabled={loading||disabled} onClick={()=>void refresh()}>刷新</button><div role="group" aria-label="文件显示方式"><button type="button" aria-label="网格显示" aria-pressed={layout==='grid'} onClick={()=>setLayout('grid')}><Grid2X2 size={17}/></button><button type="button" aria-label="列表显示" aria-pressed={layout==='list'} onClick={()=>setLayout('list')}><List size={17}/></button></div></div>
   {(error||importError)&&<p role="alert" className="local-home-error">{error||importError}</p>}{notice&&<p role="status">{notice}</p>}
   {!ready?<p className="activity-line" role={startupError?"alert":"status"}>{startupError||"正在读取本机设计…"} 文档操作暂不可用，仍可调整本机设置。{!startupError&&<span className="activity-track" aria-hidden="true"><i/></span>}</p>:loading?<p className="activity-line" role="status">正在读取本机设计…<span className="activity-track" aria-hidden="true"><i/></span></p>:<div className={`local-home-files ${layout}`} aria-label="最近设计列表">{visible.map(entry=><button type="button" className="local-home-file" key={entry.id} disabled={disabled} onClick={()=>void run(()=>latest.current.open(entry.id))}>
    <span className="local-home-placeholder" aria-hidden="true"><FileMark kind="fd" size={40}/></span><span className="local-home-file-meta"><strong>{entry.name}</strong><small>版本 {entry.revision} · 更新于 {new Date(entry.updatedAt).toLocaleString()}</small></span>
   </button>)}{!visible.length&&<p className="local-home-empty">{query?'没有匹配的设计。':source.kind==='desktop-files'?'此版本使用本机文件，可通过“打开设计文件”继续。':'还没有保存的设计。新建或打开文件开始创作。'}</p>}</div>}
  </div>
 </section>
}
