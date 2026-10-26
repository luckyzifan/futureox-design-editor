import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Editor } from './engine'
import { blank, type DesignDocument } from './model'
import { commitPendingEdits, hasPendingEdits, registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { prepareDocumentJson, prepareDocumentJsonInWorker } from './prepared-document'
import { documentPreparationRuntime } from './document-preparation-identity'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'
import { desktopBridge, type LargeDocumentBridge, type LargeDocumentRow, type LargeDocumentPageRange, type LargeDocumentStatus, type DesktopResult } from './desktop'
import { apply, bounds, boxPoints, unionBounds } from './geometry'
import { sourceNodeEdit,type SourceNodeEdit } from './source-scene-patch'

const admitted=<T,>(result:DesktopResult<T>):T=>{if(result.status!=='ok')throw Error(result.status==='cancelled'?'操作已取消':result.message);return result as T}
const sameSource=(a:LargeDocumentStatus|null,b:LargeDocumentStatus|null)=>!!a&&!!b&&a.owner.documentId===b.owner.documentId&&a.owner.sessionEpoch===b.owner.sessionEpoch&&a.revision===b.revision
type CanvasSelection=LargeDocumentRow&{sceneOffset?:number;previousOffsets?:number[]}
const sceneRequest=(row:CanvasSelection)=>({key:row.key,...(row.sceneOffset?{offset:row.sceneOffset}:{})})
export type SourceWorkspace = {
  editor:Editor; ready:boolean; busy:boolean; locked:boolean; dirty:boolean; name:string; notice:string; error:string
  canvas:RefObject<HTMLDivElement|null>; navigation:ReactNode; showLayers:boolean; warnings:string[]
  dismissWarnings():void; cancel():void; save():Promise<void>; exportFile():Promise<void>; leave():Promise<void>; openFile(file:File):Promise<void>
}
/** Source storage owns the full archive and commits only its admitted workset.
 * UI is the ordinary App workbench; no separate Canvas/Inspector implementation. */
export function LargeDocumentWorkspace({bridge,initialFile,parentEditor,onExit,onWindowClose,renderWorkbench}:{bridge:LargeDocumentBridge;initialFile?:File;parentEditor:Editor;onExit:(file?:File)=>void;onWindowClose:(requestId:string)=>Promise<void>;renderWorkbench:(source:SourceWorkspace)=>ReactNode}) {
  const [editor]=useState(()=>new Editor(blank()))
  const state=useSyncExternalStore(editor.subscribe,editor.panelSnapshot)
  const [status,setStatus]=useState<LargeDocumentStatus|null>(null),statusRef=useRef<LargeDocumentStatus|null>(null)
  const [rows,setRows]=useState<LargeDocumentRow[]>([]),[parents,setParents]=useState<LargeDocumentRow[]>([]),[offset,setOffset]=useState(0),[total,setTotal]=useState(0)
  const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[active,setActive]=useState<CanvasSelection|null>(null)
  const [pageRange,setPageRange]=useState<LargeDocumentPageRange|null>(null)
  const [busy,setBusy]=useState(false),busyRef=useRef(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [viewTab,setViewTab]=useState<'source'|'layers'>('source')
  const [editorLocked,setEditorLocked]=useState(false),[warnings,setWarnings]=useState<string[]>([])
  const queuedLoad=useRef<CanvasSelection|null>(null),drainingLoads=useRef(false),preparingSource=useRef(false)
  const alive=useRef(true),started=useRef(false),baseline=useRef<DesignDocument|null>(null),canvas=useRef<HTMLDivElement>(null),abort=useRef<AbortController|null>(null)
  const activeRef=useRef(active);activeRef.current=active
  const clearNavigation=()=>{setRows([]);setParents([]);setOffset(0);setTotal(0);setFilter('');setQuery('')}
  const updateStatus=(next:LargeDocumentStatus)=>{
    // Keys are source-index ordinals, not stable object IDs. Never carry a
    // breadcrumb or a previously listed row into a newly indexed revision.
    if(!sameSource(statusRef.current,next))clearNavigation()
    statusRef.current=next;setStatus(next)
  }
  const requireCleanCanvas=()=>{
    if((activeRef.current&&editor.authoredDocument!==baseline.current)||hasPendingEdits(editor)||editor.interactionActive)
      throw Error('源文件已变化，但当前画布还有未保存修改；请先撤销这些修改，当前画布已保留。')
  }
  const invalidateCanvas=()=>{
    // Call only after saving/dirty checks. Keep the Editor and its history in
    // memory; a new source selection is required before any further source edit.
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);setViewTab('source')
    setNotice('源文件版本已变化。请重新选择页面或对象，避免使用旧的源对象位置。')
  }
  const request=()=>{const value=statusRef.current;if(!value)throw Error('源文件尚未打开');return {owner:value.owner,expectedRevision:value.revision}}
  const run=async(work:()=>Promise<void>,lockEditor=false)=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setEditorLocked(lockEditor);setError('')
    try{await work()}catch(error){if(alive.current&&!(queuedLoad.current&&(/取消|cancel|abort/i.test(String(error)))))setError(error instanceof Error?error.message:String(error))}
    finally{busyRef.current=false;if(alive.current){setBusy(false);setEditorLocked(false);if(queuedLoad.current&&!drainingLoads.current)queueMicrotask(()=>void drainLoads())}}
  }
  async function drainLoads(){
    if(drainingLoads.current||busyRef.current)return
    drainingLoads.current=true
    try{while(alive.current&&queuedLoad.current){const row=queuedLoad.current;queuedLoad.current=null;await run(()=>load(row))}}
    finally{drainingLoads.current=false}
  }
  const requestLoad=(row:CanvasSelection)=>{
    queuedLoad.current=row
    if(preparingSource.current){abort.current?.abort();void bridge.cancel().catch(()=>{})}
    void drainLoads()
  }
  const save=async()=>{
    if(!commitPendingEdits(editor)||editor.interactionActive)throw Error('请先完成当前输入或画布操作。')
    const original=baseline.current,current=editor.authoredDocument,row=activeRef.current
    if(!row||!original||current===original)return
    if(statusRef.current?.format==='json') {
      const next=admitted(await bridge.commitCanvas({...request(),key:row.key,json:JSON.stringify(current)}))
      if(typeof next.key!=='string'||!/^\d{1,5}:\d{1,7}$/.test(next.key))throw Error('保存回执缺少有效的源对象位置；当前画布已保留，请刷新源文件状态后重选。')
      updateStatus(next);const rebound={...row,key:next.key};activeRef.current=rebound;setActive(rebound)
      baseline.current=current
      if(editor.authoredDocument!==current||hasPendingEdits(editor))throw Error('保存期间产生了新修改，请再次保存。')
      return
    }
    const {nodes:a,...aMeta}=original,{nodes:b,...bMeta}=current
    if(JSON.stringify(aMeta)!==JSON.stringify(bMeta)||Object.keys(a).length!==Object.keys(b).length)throw Error('此页面会话支持已有图层的属性编辑；结构修改请先撤销，再进入局部对象编辑。')
    const changes:Record<string,SourceNodeEdit>={}
    for(const [id,node]of Object.entries(b)){
      if(!a[id])throw Error('新增图层需要局部对象编辑会话。')
      if(node!==a[id]){const edit=sourceNodeEdit(a[id],node);if(edit)changes[id]=edit}
    }
    const json=JSON.stringify(changes)
    if(new TextEncoder().encode(json).length>2*1024**2)throw Error('本次修改超过 2 MiB，请减少同时修改的图层。')
    if(Object.keys(changes).length){
      const next=admitted(await bridge.sceneCommit({...request(),key:row.key,json}))
      // Native returns the root resolved in the newly built index. A missing
      // receipt must not bind an old ordinal to the new source revision.
      if(typeof next.key!=='string'||!/^\d{1,5}:\d{1,7}$/.test(next.key))throw Error('保存回执缺少有效的源对象位置；当前画布已保留，请刷新源文件状态后重选。')
      updateStatus(next);const rebound={...row,key:next.key};activeRef.current=rebound;setActive(rebound)
    }
    baseline.current=current
    if(editor.authoredDocument!==current||hasPendingEdits(editor))throw Error('保存期间产生了新修改，请再次保存。')
    setNotice('画布修改已保存到源文件缓存。导出会包含全部未加载内容。')
  }
  const fit=()=>{
    const doc=editor.state.doc,host=canvas.current,page=doc.pages.find(p=>p.id===editor.state.page)
    const entries=page?.children.map(id=>doc.nodes[id]).filter(Boolean).map(n=>bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(p=>apply(n.transform,p))))||[]
    if(!host||!entries.length)return
    const box=unionBounds(entries),zoom=Math.max(.001,Math.min(2,(host.clientWidth-96)/Math.max(1,box.width),(host.clientHeight-96)/Math.max(1,box.height)))
    editor.set({view:{x:(host.clientWidth-box.width*zoom)/2-box.x*zoom,y:(host.clientHeight-box.height*zoom)/2-box.y*zoom,zoom}})
  }
  const load=async(row:CanvasSelection)=>{
    const selectedSource=statusRef.current
    await save()
    if(queuedLoad.current)return
    if(!sameSource(selectedSource,statusRef.current))throw Error('修改已保存，源对象位置已更新。请从刷新后的列表重新选择页面或对象。')
    const previous=editor.authoredDocument
    const previousRow=activeRef.current
    const owner=request();setNotice(`正在准备 ${row.name}…`);preparingSource.current=true
    try {
    const result=admitted(await bridge.scene({...owner,...sceneRequest(row)}))
    if(!alive.current)return
    if(queuedLoad.current)throw new DOMException('源对象请求已过期','AbortError')
    const controller=new AbortController();abort.current=controller
    const current=()=>alive.current&&!queuedLoad.current&&statusRef.current?.owner===owner.owner&&statusRef.current.revision===owner.expectedRevision
    const prepared=documentPreparationRuntime()?await prepareDocumentJsonInWorker(result.json,{documentId:owner.owner.documentId,version:owner.expectedRevision,generation:editor.sessionGeneration,session:owner.owner.sessionEpoch},controller.signal,current):prepareDocumentJson(result.json)
    if(!current()||editor.authoredDocument!==previous||hasPendingEdits(editor)||editor.interactionActive)throw Error('页面准备期间产生了新修改；当前画布已保留。')
    if(!editor.load(prepared))throw Error(editor.state.message||'页面未能进入画布')
    baseline.current=editor.authoredDocument;activeRef.current=row;setActive(row);setViewTab('layers')
    setPageRange(result.pageRange??null)
    const range=result.pageRange,partial=range&&(range.offset>0||range.end<range.totalRoots)
    setWarnings(result.warnings);setNotice(partial?`${row.name}：已载入第 ${range.offset+1}–${range.end} 个画板 / 对象，共 ${range.totalRoots} 个。可切换上一部分 / 下一部分；完整导出包含全部内容。`:`${row.kind==='page'?'完整页面':'当前画板 / 对象'}已载入：${result.nodes.toLocaleString()} 个场景节点。`)
    requestAnimationFrame(fit)
    } catch(error) {
      preparingSource.current=false
      // Native preparation stages its source baseline before the WASM/UI gate.
      // A failed admission must leave the displayed canvas saveable as well.
      if(previousRow&&alive.current&&statusRef.current?.owner===owner.owner&&statusRef.current.revision===owner.expectedRevision){
        try{admitted(await bridge.scene({...owner,...sceneRequest(previousRow)}))}
        catch(restoreError){throw Error(`${error instanceof Error?error.message:String(error)}；原画布仍保留，但保存基线恢复失败，请重新载入原页面：${restoreError instanceof Error?restoreError.message:String(restoreError)}`)}
      }
      throw error
    }finally{preparingSource.current=false;abort.current=null}
  }
  const openInitialCanvas=async()=>{
    const top=admitted(await bridge.children({...request(),limit:100})).items
    let row=top.find(row=>row.kind==='page')||top.find(row=>!['document','rect','style'].includes(row.kind))
    // Enter one board quickly, while leaving the complete page list visible.
    // Selecting a page uses budgeted consecutive ranges with explicit paging.
    if(row?.kind==='page'&&row.hasChildren){
      const page=row,children=admitted(await bridge.children({...request(),key:page.key,limit:100})).items
      const board=children.find(row=>['artboard','symbolMaster','frame','group'].includes(row.kind))
      if(board)row=board
    }
    if(row){await load(row);setViewTab('source')}
    else setNotice('此文件没有可显示的页面或画板。')
  }
  useEffect(()=>{
    alive.current=true
    if(!started.current){started.current=true;void run(async()=>{
      const result=await (initialFile?bridge.openFile(initialFile):bridge.open());if(result.status==='cancelled'){onExit();return}
      const next=admitted(result);if(!alive.current)return;updateStatus(next)
      await openInitialCanvas()
    },true)}
    return()=>{alive.current=false;queueMicrotask(()=>{if(!alive.current){queuedLoad.current=null;abort.current?.abort();editor.dispose()}})}
  },[])
  useEffect(()=>{
    // The host admits one source operation at a time. Auto-entry, save and
    // history own that lane; sidebar refresh starts after their receipt.
    if(!status||busy)return
    let current=true
    const listedSource=status
    setRows([])
    void bridge.children({...request(),key:filter?undefined:parents.at(-1)?.key,offset,limit:100,...(filter?{query:filter}:{})}).then(result=>{if(current&&alive.current&&sameSource(listedSource,statusRef.current)){const value=admitted(result);setRows(value.items);setTotal(value.total)}}).catch(error=>{if(current&&alive.current)setError(String(error))})
    return()=>{current=false}
  },[status,parents,offset,filter,busy])
  useEffect(()=>{const release=registerPendingEdit(parentEditor,{dirty:()=>true,commit:()=>false});pendingEditsChanged(parentEditor);return release},[parentEditor])
  const leave=()=>run(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));onExit()},true)
  const exportFile=()=>run(async()=>{await save();const result=await bridge.export(request());if(result.status==='cancelled')return;const next=admitted(result);updateStatus(next);setNotice(`完整文件已导出：${next.displayName}`)})
  useEffect(()=>{
    const desktop=desktopBridge()
    const off=desktop?.onCommand(command=>{
      if(busyRef.current)return
      if(command==='save')void run(save)
      else if(command==='saveAs')void exportFile()
      else{const action=resolveDesktopEditorCommand(command);if(action)void dispatchEditorCommand(editor,action)}
    })
    const key=(event:KeyboardEvent)=>{if(event.defaultPrevented||event.isComposing||event.repeat||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='s')return;event.preventDefault();if(event.shiftKey)void exportFile();else void run(save)}
    window.addEventListener('keydown',key)
    const close=desktop?.onCloseRequested(({requestId})=>{void run(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));flushSync(onExit);await onWindowClose(requestId)},true).then(()=>{if(alive.current)void desktop.respondToClose({requestId,allow:false})})})
    return()=>{off?.();close?.();window.removeEventListener('keydown',key)}
  },[editor,bridge,onExit,onWindowClose])
  const history=(kind:'undo'|'redo')=>run(async()=>{
    await save();requireCleanCanvas()
    const next=admitted(await bridge[kind](request()))
    requireCleanCanvas();updateStatus(next);invalidateCanvas()
  },true)
  const openFile=(file:File)=>run(async()=>{
    await save()
    if(statusRef.current)admitted(await bridge.close(request()))
    if(!/\.(json|sketch)$/i.test(file.name)){flushSync(()=>onExit(file));return}
    const next=admitted(await bridge.openFile(file));if(!alive.current)return
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);updateStatus(next)
    await openInitialCanvas()
  },true)
  const navigation=<div className="source-board-navigation" data-listing={viewTab==='source'}>
    <nav><button aria-pressed={viewTab==='source'} onClick={()=>setViewTab('source')}>页面 / 画板</button><button disabled={!active} aria-pressed={viewTab==='layers'} onClick={()=>setViewTab('layers')}>图层</button></nav>
    {active&&pageRange&&(pageRange.offset>0||pageRange.nextOffset!==null)&&<nav aria-label="页面分段"><span>{active.name} · {pageRange.offset+1}–{pageRange.end} / {pageRange.totalRoots}</span><button disabled={busy||!active.previousOffsets?.length} onClick={()=>{const previous=active.previousOffsets!;requestLoad({...active,sceneOffset:previous.at(-1),previousOffsets:previous.slice(0,-1)})}}>上一部分</button><button disabled={busy||pageRange.nextOffset===null} onClick={()=>requestLoad({...active,sceneOffset:pageRange.nextOffset!,previousOffsets:[...(active.previousOffsets??[]),pageRange.offset]})}>下一部分</button></nav>}
    {viewTab==='source'&&<><form onSubmit={event=>{event.preventDefault();setFilter(query);setOffset(0)}}><input aria-label="搜索源对象" placeholder="搜索页面或画板" value={query} maxLength={256} onChange={event=>setQuery(event.target.value)}/><button>搜索</button></form><nav><button disabled={busy} onClick={()=>{setParents([]);setOffset(0);setFilter('');setQuery('')}}>全部页面</button>{parents.map((row,index)=><button key={row.key} disabled={busy} onClick={()=>{setParents(parents.slice(0,index+1));setOffset(0)}}>{row.name}</button>)}</nav>
      <div className="source-workspace-rows">{rows.map(row=><div key={row.key} data-source-key={row.key}><button disabled={['document','rect','style','exportOptions','rulerData','MSImmutableFreeformGroupLayout'].includes(row.kind)} onClick={()=>requestLoad(row)} title={`${row.kind} · ${(row.bytes/1024**2).toFixed(1)} MiB`}>{row.name||row.kind}<small>{row.kind==='page'?'载入页面':row.kind}</small></button>{row.hasChildren&&<button aria-label={`展开 ${row.name}`} disabled={busy} onClick={()=>{setParents([...parents,row]);setFilter('');setOffset(0)}}>›</button>}</div>)}</div><footer><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</button><span>{total}</span><button disabled={busy||offset+100>=total} onClick={()=>setOffset(offset+100)}>下一页</button></footer>
      <button disabled={busy||!status?.undoCount} onClick={()=>void history('undo')}>撤销已保存修改</button><button disabled={busy||!status?.redoCount} onClick={()=>void history('redo')}>重做已保存修改</button>
    </>}
  </div>
  return renderWorkbench({editor,ready:!!active,busy,locked:editorLocked,dirty:!!active&&editor.authoredDocument!==baseline.current,
    name:status?.name||initialFile?.name||'正在打开文件',notice,error,canvas,navigation,showLayers:viewTab==='layers',warnings,
    dismissWarnings:()=>setWarnings([]),cancel:()=>{abort.current?.abort();void bridge.cancel().catch(error=>setError(String(error)))},
    save:()=>run(save),exportFile,leave,openFile})
}
