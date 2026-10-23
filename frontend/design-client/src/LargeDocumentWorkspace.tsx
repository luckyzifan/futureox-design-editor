import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { Editor } from './engine'
import { blank, type DesignDocument, type DesignNode } from './model'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { commitPendingEdits, hasPendingEdits, registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { prepareDocumentJson, prepareDocumentJsonInWorker } from './prepared-document'
import { documentPreparationRuntime } from './document-preparation-identity'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'
import { desktopBridge, type LargeDocumentBridge, type LargeDocumentRow, type LargeDocumentStatus, type DesktopResult } from './desktop'
import { LargeDocumentDialog } from './LargeDocumentDialog'
import { apply, bounds, boxPoints, unionBounds } from './geometry'
import { sourceNodeEdit,type SourceNodeEdit } from './source-scene-patch'

const admitted=<T,>(result:DesktopResult<T>):T=>{if(result.status!=='ok')throw Error(result.status==='cancelled'?'操作已取消':result.message);return result as T}
/** Source-backed storage adapter around the shared Editor/Canvas/Inspector.
 * A loaded page is never passed to the ordinary whole-document FD autosaver. */
export function LargeDocumentWorkspace({bridge,initialFile,parentEditor,onExit,onWindowClose}:{bridge:LargeDocumentBridge;initialFile?:File;parentEditor:Editor;onExit:()=>void;onWindowClose:(requestId:string)=>Promise<void>}) {
  const [editor]=useState(()=>new Editor(blank()))
  const state=useSyncExternalStore(editor.subscribe,editor.panelSnapshot)
  const [status,setStatus]=useState<LargeDocumentStatus|null>(null),statusRef=useRef<LargeDocumentStatus|null>(null)
  const [rows,setRows]=useState<LargeDocumentRow[]>([]),[parents,setParents]=useState<LargeDocumentRow[]>([]),[offset,setOffset]=useState(0),[total,setTotal]=useState(0)
  const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[active,setActive]=useState<LargeDocumentRow|null>(null)
  const [busy,setBusy]=useState(false),busyRef=useRef(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[jsonOpen,setJsonOpen]=useState(false)
  const [viewTab,setViewTab]=useState<'source'|'layers'>('source')
  const alive=useRef(true),started=useRef(false),baseline=useRef<DesignDocument|null>(null),canvas=useRef<HTMLDivElement>(null),abort=useRef<AbortController|null>(null)
  const activeRef=useRef(active);activeRef.current=active
  const updateStatus=(next:LargeDocumentStatus)=>{statusRef.current=next;setStatus(next)}
  const request=()=>{const value=statusRef.current;if(!value)throw Error('源文件尚未打开');return {owner:value.owner,expectedRevision:value.revision}}
  const run=async(work:()=>Promise<void>)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await work()}catch(error){if(alive.current)setError(error instanceof Error?error.message:String(error))}finally{busyRef.current=false;if(alive.current)setBusy(false)}}
  const save=async()=>{
    if(!commitPendingEdits(editor)||editor.interactionActive)throw Error('请先完成当前输入或画布操作。')
    const original=baseline.current,current=editor.authoredDocument,row=activeRef.current
    if(!row||!original||current===original)return
    if(statusRef.current?.format==='json') {
      updateStatus(admitted(await bridge.commitCanvas({...request(),key:row.key,json:JSON.stringify(current)})))
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
    if(Object.keys(changes).length)updateStatus(admitted(await bridge.sceneCommit({...request(),key:row.key,json})))
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
  const load=async(row:LargeDocumentRow)=>{
    await save()
    const previous=editor.authoredDocument
    const previousRow=activeRef.current
    const owner=request();setNotice(`正在准备 ${row.name}…`)
    try {
    const result=admitted(await bridge.scene({...owner,key:row.key}))
    if(!alive.current)return
    const controller=new AbortController();abort.current=controller
    const current=()=>alive.current&&statusRef.current?.owner===owner.owner&&statusRef.current.revision===owner.expectedRevision
    const prepared=documentPreparationRuntime()?await prepareDocumentJsonInWorker(result.json,{documentId:owner.owner.documentId,version:owner.expectedRevision,generation:editor.sessionGeneration,session:owner.owner.sessionEpoch},controller.signal,current):prepareDocumentJson(result.json)
    if(!current()||editor.authoredDocument!==previous||hasPendingEdits(editor)||editor.interactionActive)throw Error('页面准备期间产生了新修改；当前画布已保留。')
    if(!editor.load(prepared))throw Error(editor.state.message||'页面未能进入画布')
    baseline.current=editor.authoredDocument;activeRef.current=row;setActive(row);setViewTab('layers')
    setNotice(`${row.kind==='page'?'完整页面':'当前画板 / 对象'}已载入：${result.nodes.toLocaleString()} 个场景节点。${result.warnings.join(' ')}`)
    requestAnimationFrame(fit)
    } catch(error) {
      // Native preparation stages its source baseline before the WASM/UI gate.
      // A failed admission must leave the displayed canvas saveable as well.
      if(previousRow&&alive.current&&statusRef.current?.owner===owner.owner&&statusRef.current.revision===owner.expectedRevision){
        try{admitted(await bridge.scene({...owner,key:previousRow.key}))}
        catch(restoreError){throw Error(`${error instanceof Error?error.message:String(error)}；原画布仍保留，但保存基线恢复失败，请重新载入原页面：${restoreError instanceof Error?restoreError.message:String(restoreError)}`)}
      }
      throw error
    }
  }
  useEffect(()=>{
    alive.current=true
    if(!started.current){started.current=true;void run(async()=>{
      const result=await (initialFile?bridge.openFile(initialFile):bridge.open());if(result.status==='cancelled'){onExit();return}
      const next=admitted(result);if(!alive.current)return;updateStatus(next)
      setNotice('源文件已建立索引。选择完整页面或画板进入主画布；未加载内容仍保存在源文件中。')
    })}
    return()=>{alive.current=false;queueMicrotask(()=>{if(!alive.current){abort.current?.abort();editor.dispose()}})}
  },[])
  useEffect(()=>{
    if(!status)return
    let current=true
    setRows([])
    void bridge.children({...request(),key:filter?undefined:parents.at(-1)?.key,offset,limit:100,...(filter?{query:filter}:{})}).then(result=>{if(current&&alive.current){const value=admitted(result);setRows(value.items);setTotal(value.total)}}).catch(error=>{if(current&&alive.current)setError(String(error))})
    return()=>{current=false}
  },[status,parents,offset,filter])
  useEffect(()=>{const release=registerPendingEdit(parentEditor,{dirty:()=>true,commit:()=>false});pendingEditsChanged(parentEditor);return release},[parentEditor])
  const leave=()=>run(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));onExit()})
  const exportFile=()=>run(async()=>{await save();const result=await bridge.export(request());if(result.status==='cancelled')return;const next=admitted(result);updateStatus(next);setNotice(`完整文件已导出：${next.displayName}`)})
  useEffect(()=>{
    const desktop=desktopBridge()
    const off=desktop?.onCommand(command=>{
      if(busyRef.current||jsonOpen)return
      if(command==='save')void run(save)
      else if(command==='saveAs')void exportFile()
      else{const action=resolveDesktopEditorCommand(command);if(action)void dispatchEditorCommand(editor,action)}
    })
    const key=(event:KeyboardEvent)=>{if(event.defaultPrevented||event.isComposing||event.repeat||jsonOpen||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='s')return;event.preventDefault();if(event.shiftKey)void exportFile();else void run(save)}
    window.addEventListener('keydown',key)
    const close=desktop?.onCloseRequested(({requestId})=>{void run(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));flushSync(onExit);await onWindowClose(requestId)}).then(()=>{if(alive.current)void desktop.respondToClose({requestId,allow:false})})})
    return()=>{off?.();close?.();window.removeEventListener('keydown',key)}
  },[editor,bridge,jsonOpen,onExit,onWindowClose])
  const history=(kind:'undo'|'redo')=>run(async()=>{await save();updateStatus(admitted(await bridge[kind](request())));baseline.current=null;const row=activeRef.current;if(row)await load(row)})
  const openJson=()=>run(async()=>{await save();setJsonOpen(true)})
  return <PendingEditContext.Provider value={editor}><div className="source-workspace">
    <header className="source-workspace-header"><button type="button" disabled={busy} onClick={()=>void leave()}>返回设计</button><strong>{status?.name||'正在打开大型源文件'}</strong><span>{status?`${(status.expandedBytes/1024**2).toFixed(1)} MiB · ${status.indexedObjects.toLocaleString()} 个源对象`:''}</span><button disabled={busy||!active} onClick={()=>void run(save)}>保存修改</button><button disabled={busy||!status} onClick={()=>void exportFile()}>导出完整文件…</button><button disabled={busy||!status} onClick={()=>void openJson()}>JSON 属性</button></header>
    <div className="source-workspace-status">{error?<p role="alert">{error}</p>:<p role="status">{notice}</p>}{busy&&<button onClick={()=>{abort.current?.abort();void bridge.cancel().catch(error=>setError(String(error)))}}>停止当前操作</button>}</div>
    <main className="source-workspace-main">
      <aside className="source-workspace-navigation"><nav><button aria-pressed={viewTab==='source'} onClick={()=>setViewTab('source')}>源文件 / 页面</button><button disabled={!active} aria-pressed={viewTab==='layers'} onClick={()=>setViewTab('layers')}>当前画布图层</button></nav>
        {viewTab==='layers'?<Layers editor={editor}/>:<><form onSubmit={event=>{event.preventDefault();setFilter(query);setOffset(0)}}><input aria-label="搜索源对象" placeholder="搜索页面或画板" value={query} maxLength={256} onChange={event=>setQuery(event.target.value)}/><button>搜索</button></form><nav><button disabled={busy} onClick={()=>{setParents([]);setOffset(0);setFilter('');setQuery('')}}>全部文件</button>{parents.map((row,index)=><button key={row.key} disabled={busy} onClick={()=>{setParents(parents.slice(0,index+1));setOffset(0)}}>{row.name}</button>)}</nav>
          <div className="source-workspace-rows">{rows.map(row=><div key={row.key} data-source-key={row.key}><button disabled={busy||['document','rect','style','exportOptions','rulerData','MSImmutableFreeformGroupLayout'].includes(row.kind)} onClick={()=>void run(()=>load(row))} title={`${row.kind} · ${(row.bytes/1024**2).toFixed(1)} MiB`}>{row.name||row.kind}<small>{row.kind==='page'?'完整页面':row.kind}</small></button>{row.hasChildren&&<button aria-label={`展开 ${row.name}`} disabled={busy} onClick={()=>{setParents([...parents,row]);setFilter('');setOffset(0)}}>›</button>}</div>)}</div><footer><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</button><span>{total}</span><button disabled={busy||offset+100>=total} onClick={()=>setOffset(offset+100)}>下一页</button></footer></>}
      </aside>
      <div className="source-workspace-canvas" ref={canvas} inert={busy||jsonOpen||undefined}>
        {active?<Canvas editor={editor} compactChrome/>:<div className="source-workspace-empty">选择左侧页面，在这里显示完整页面；也可以展开页面，按需载入画板。</div>}
        {active&&<div className="source-workspace-tools"><span>{active.name}</span><button onClick={()=>editor.set({tool:'select'})}>选择</button><button onClick={()=>editor.set({tool:'hand'})}>平移</button><button onClick={fit}>显示全部</button><button disabled={!editor.canUndo} onClick={()=>editor.undo()}>撤销画布修改</button><button disabled={!editor.canRedo} onClick={()=>editor.redo()}>重做</button></div>}
      </div>
      <aside className="source-workspace-inspector" inert={busy||jsonOpen||undefined}>{active?<Inspector editor={editor}/>:<p>源文件保存在磁盘，页面按需进入共享画布。</p>}<p role="status">{state.message}</p><button disabled={busy||!status?.undoCount} onClick={()=>void history('undo')}>撤销已保存修改</button><button disabled={busy||!status?.redoCount} onClick={()=>void history('redo')}>重做已保存修改</button></aside>
    </main>
    {jsonOpen&&<LargeDocumentDialog bridge={bridge} parentEditor={editor} keepSession onClose={()=>{setJsonOpen(false);void run(async()=>{updateStatus(admitted(await bridge.open()));baseline.current=null;if(activeRef.current)await load(activeRef.current)})}}/>}
  </div></PendingEditContext.Provider>
}
