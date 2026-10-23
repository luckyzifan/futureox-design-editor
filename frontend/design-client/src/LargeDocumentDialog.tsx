import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { LargeDocumentBridge, LargeDocumentRow, LargeDocumentStatus, DesktopResult } from './desktop'
import { modalKeyDown } from './modal-keyboard'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { prepareDocumentJsonForEditing } from './kernel/picking'
import { commitPendingEdits, registerPendingEdit, pendingEditsChanged, hasPendingEdits, subscribePendingEdits } from './pending-edits'
import { PendingEditContext } from './pending-edit-context'

function admitted<T>(result:DesktopResult<T>):T {
  if(result.status!=='ok')throw Error(result.status==='cancelled'?'操作已取消':result.message)
  return result as T
}
const size=(value:number)=>`${(value/1024**2).toFixed(1)} MiB`
export function LargeDocumentDialog({bridge,initialFile,onClose,parentEditor,keepSession=false}:{bridge:LargeDocumentBridge;initialFile?:File;onClose:()=>void;parentEditor:Editor;keepSession?:boolean}) {
  const [status,setStatus]=useState<LargeDocumentStatus|null>(null),[rows,setRows]=useState<LargeDocumentRow[]>([]),[total,setTotal]=useState(0)
  const [parents,setParents]=useState<LargeDocumentRow[]>([]),[offset,setOffset]=useState(0),[query,setQuery]=useState(''),[filter,setFilter]=useState('')
  const [selected,setSelected]=useState<LargeDocumentRow|null>(null),[source,setSource]=useState(''),[draft,setDraft]=useState(''),[hash,setHash]=useState(''),[omitted,setOmitted]=useState<string[]>([])
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [working,setWorking]=useState<{editor:Editor;key:string;version:number}|null>(null),[workingDirty,setWorkingDirty]=useState(false)
  const alive=useRef(true),generation=useRef(0),panel=useRef<HTMLElement>(null),opened=useRef(false),started=useRef(false)
  const dirty=draft!==source
  const unsaved=dirty||workingDirty
  const request=()=>{if(!status)throw Error('请先打开文件');return {owner:status.owner,expectedRevision:status.revision}}
  useLayoutEffect(()=>{
    alive.current=true
    const previous=document.activeElement,others=[...document.body.children].filter(node=>!node.contains(panel.current)).map(node=>[node,node.getAttribute('inert')] as const)
    for(const [node]of others)node.setAttribute('inert','')
    panel.current?.focus()
    return()=>{alive.current=false;generation.current++;for(const[node,value]of others){if(value===null)node.removeAttribute('inert');else node.setAttribute('inert',value)}if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()}
  },[])
  const run=async(work:()=>Promise<void>)=>{if(pending)return;setPending(true);setError('');try{await work()}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{if(alive.current)setPending(false)}}
  const open=()=>run(async()=>{
    const useFile=initialFile&&!opened.current;opened.current=true
    const result=await (useFile?bridge.openFile(initialFile!):bridge.open())
    if(result.status==='cancelled')return
    if(alive.current){setStatus(admitted(result));setNotice('完整源文件保存在本机；这里按对象加载属性，导出包含未加载内容。')}
  })
  useEffect(()=>{if(!started.current){started.current=true;void open()}},[])
  useEffect(()=>{
    if(!status)return
    const ticket=++generation.current
    void bridge.children({...request(),key:filter?undefined:parents.at(-1)?.key,offset,limit:100,...(filter?{query:filter}:{})}).then(result=>{
      if(!alive.current||ticket!==generation.current)return
      const value=admitted(result);setRows(value.items);setTotal(value.total)
    }).catch(e=>{if(alive.current&&ticket===generation.current)setError(String(e))})
  },[status,parents,offset,filter])
  const choose=(row:LargeDocumentRow)=>run(async()=>{
    if(unsaved)throw Error('请先应用或放弃当前修改，再选择其他对象。')
    const result=admitted(await bridge.read({...request(),key:row.key}))
    if(alive.current){setWorking(null);setSelected(row);setSource(result.json);setDraft(result.json);setHash(result.hash);setOmitted(result.omittedFields)}
  })
  const apply=()=>run(async()=>{
    if(!selected)return
    const next=admitted(await bridge.apply({...request(),key:selected.key,json:draft,expectedHash:hash}))
    if(!alive.current)return
    setStatus(next)
    const result=admitted(await bridge.read({owner:next.owner,expectedRevision:next.revision,key:selected.key}))
    if(alive.current){setSource(result.json);setDraft(result.json);setHash(result.hash);setNotice(next.saveWarning||'修改已保存到本机缓存；导出完整文件可交付或重新打开。')}
  })
  const history=(kind:'undo'|'redo')=>run(async()=>{
    if(unsaved)throw Error('请先应用或还原当前修改。')
    const next=admitted(await bridge[kind](request()));if(alive.current){setStatus(next);setWorking(null);setWorkingDirty(false);setSelected(null);setSource('');setDraft('')}
  })
  const close=()=>{if(pending)return;if(unsaved){setError('请先应用或还原当前修改，再关闭。');return}void run(async()=>{if(status&&!keepSession)admitted(await bridge.close(request()));onClose()})}
  useEffect(()=>{const release=registerPendingEdit(parentEditor,{dirty:()=>unsaved,commit:()=>!unsaved});pendingEditsChanged(parentEditor);return release},[parentEditor,unsaved])
  return createPortal(<div className="modal-backdrop" data-desktop-dialog="true">
    <section ref={panel} className="remote-modal large-document-dialog" role="dialog" aria-modal="true" aria-label="大型文档" tabIndex={-1} onKeyDown={event=>modalKeyDown(event,close)}>
      <header><div><h2>{status?.name||'大型 JSON / Sketch'}</h2><p>{status?`${size(status.expandedBytes)} · ${status.indexedObjects.toLocaleString()} 个可定位对象 · 展开上限 4 GiB`:'正在建立文件索引，界面会保持响应。'}</p></div><button type="button" disabled={pending} onClick={close}>关闭</button></header>
      <div className="large-document-toolbar">
        {!status&&<button type="button" disabled={pending} onClick={()=>void open()}>选择 JSON / Sketch…</button>}
        <button type="button" disabled={!status||pending||!status.undoCount||unsaved} onClick={()=>void history('undo')}>撤销已应用修改</button>
        <button type="button" disabled={!status||pending||!status.redoCount||unsaved} onClick={()=>void history('redo')}>重做</button>
        <button type="button" disabled={!status||pending||unsaved} onClick={()=>void run(async()=>{
          const result=await bridge.export(request());if(result.status==='cancelled')return
          const next=admitted(result);if(alive.current){setStatus(next);setNotice(next.saveWarning||`完整文件已导出：${next.displayName}`)}
        })}>导出完整文件…</button>
      </div>
      {error&&<p role="alert">{error} <button type="button" disabled={pending} onClick={()=>void open()}>刷新会话状态</button></p>}
      {pending&&<p role="status">正在处理，请稍候… <button type="button" onClick={()=>void bridge.cancel().then(result=>{admitted(result);setNotice('已请求停止；已完成的步骤不会回滚。')}).catch(e=>setError(String(e)))}>停止当前操作</button></p>}{notice&&<p role="status">{notice}</p>}
      {status&&<div className="large-document-body">
        <aside aria-label="大型文档对象">
          <form onSubmit={e=>{e.preventDefault();if(unsaved){setError('请先应用或还原当前草稿。');return}setFilter(query);setOffset(0)}}><input aria-label="搜索大型文档对象" placeholder="搜索对象名称" value={query} onChange={e=>setQuery(e.target.value)} maxLength={256}/><button type="submit" disabled={pending}>搜索</button></form>
          <nav><button disabled={pending||unsaved} onClick={()=>{setParents([]);setFilter('');setQuery('');setOffset(0)}}>全部文件</button>{parents.map((row,i)=><button key={row.key} disabled={pending||unsaved} onClick={()=>{setParents(parents.slice(0,i+1));setOffset(0)}}>{row.name||row.kind}</button>)}</nav>
          <div className="large-document-rows">{rows.map(row=><div key={row.key} className={selected?.key===row.key?'selected':''}>
            <button type="button" disabled={pending} onClick={()=>void choose(row)} title={`${row.part} · ${size(row.bytes)}`}>{row.name||row.id}<small>{row.kind}</small></button>
            {row.hasChildren&&<button type="button" aria-label={`展开 ${row.name||row.kind}`} disabled={pending||unsaved} onClick={()=>{setParents([...parents,row]);setFilter('');setQuery('');setOffset(0)}}>›</button>}
          </div>)}</div>
          <footer><button disabled={offset===0||pending} onClick={()=>setOffset(Math.max(0,offset-100))}>上一页</button><span>{total?`${offset+1}–${Math.min(offset+100,total)} / ${total}`:'0'}</span><button disabled={offset+100>=total||pending} onClick={()=>setOffset(offset+100)}>下一页</button></footer>
        </aside>
        <main><h3>{selected?`${selected.name||selected.id} · JSON 属性`:'选择一个对象'}</h3>
          {selected&&!working&&<><p>编辑已有属性。子对象与大字段单独保留，完整导出时不会遗漏。</p>{omitted.length>0&&<p>未加载字段：{omitted.join('、')}</p>}
            <textarea aria-label="对象 JSON 属性" spellCheck={false} value={draft} disabled={pending} onChange={e=>{if(new TextEncoder().encode(e.target.value).length<=2*1024**2)setDraft(e.target.value);else setError('单次属性编辑最多 2 MiB，请选择更小的对象。')}}/>
            <div><button type="button" disabled={pending||!dirty} onClick={()=>void apply()}>应用 JSON 修改</button><button type="button" disabled={pending||!dirty} onClick={()=>setDraft(source)}>还原草稿</button>
            <button type="button" disabled={pending||dirty} onClick={()=>void run(async()=>{
              const result=admitted(await bridge.project({...request(),key:selected.key}));const document=prepareDocumentJsonForEditing(result.json);
              if(alive.current){setWorking({editor:new Editor(document),key:selected.key,version:0});setWorkingDirty(false);setNotice(result.warnings.join(' '))}
            })}>在画布中编辑此对象</button></div>
          </>}
          {working&&<PendingEditContext.Provider value={working.editor}><WorkingCanvas editor={working.editor} onDirty={setWorkingDirty} onSave={()=>void run(async()=>{
            if(!commitPendingEdits(working.editor)||working.editor.interactionActive)throw Error('请先结束画布操作。')
            const next=admitted(await bridge.commitCanvas({...request(),key:working.key,json:JSON.stringify(working.editor.authoredDocument)}));
            if(alive.current){setStatus(next);setWorkingDirty(false);setWorking(null);setSelected(null);setSource('');setDraft('');setNotice('画布修改已保存回完整源文件，可继续选择对象或导出完整文件。')}
          })} onCancel={()=>{setWorking(null);setWorkingDirty(false)}}/></PendingEditContext.Provider>}
        </main>
      </div>}
    </section>
  </div>,document.body)
}

function WorkingCanvas({editor,onDirty,onSave,onCancel}:{editor:Editor;onDirty:(value:boolean)=>void;onSave:()=>void;onCancel:()=>void}) {
  const state=useSyncExternalStore(editor.subscribe,editor.panelSnapshot),host=useRef<HTMLDivElement>(null),initial=useRef(JSON.stringify(editor.authoredDocument))
  const pending=useSyncExternalStore(listener=>subscribePendingEdits(editor,listener),()=>hasPendingEdits(editor))
  useEffect(()=>{onDirty(pending||JSON.stringify(editor.authoredDocument)!==initial.current)},[state.version,pending,onDirty,editor])
  useLayoutEffect(()=>{
    const node=editor.state.doc.nodes[editor.state.doc.pages[0].children[0]],element=host.current
    if(node&&element){const zoom=Math.min(2,Math.max(.02,Math.min((element.clientWidth-80)/Math.max(1,node.width),(element.clientHeight-80)/Math.max(1,node.height))))
      editor.set({selection:[node.id],view:{x:40-node.transform[4]*zoom,y:40-node.transform[5]*zoom,zoom}})}
    return()=>editor.dispose()
  },[editor])
  return <div className="large-working"><div className="large-document-toolbar"><span>当前对象局部画布</span><button type="button" onClick={()=>editor.set({tool:'select'})}>选择</button><button type="button" onClick={()=>editor.set({tool:'rectangle'})}>矩形</button><button type="button" onClick={()=>editor.undo()}>撤销画布修改</button><button type="button" onClick={()=>editor.redo()}>重做</button><button type="button" onClick={onSave}>应用画布修改</button><button type="button" onClick={onCancel}>放弃本次画布草稿</button></div>
    <p role="status">{state.message}</p>
    <div className="large-working-body"><div ref={host} className="large-working-canvas"><Canvas editor={editor} compactChrome/></div><aside>{state.selection.length>0?<Inspector editor={editor}/>:<p>选择图层后编辑属性。</p>}</aside></div>
  </div>
}
