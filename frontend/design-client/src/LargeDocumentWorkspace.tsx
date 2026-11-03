import {useSourceOpening,type OpeningView} from './source-opening-preview'
import {renderExecutionPolicy} from './kernel/client'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Frame, Search, Undo2, Redo2, X } from 'lucide-react'
import { Editor } from './engine'
import { blank, type DesignDocument, type Point } from './model'
import type {SourceCanvasSnapshot,SourceCanvasItem} from './desktop'
import type {NativeSourceStatus} from './kernel/NativeSourceSurface'
import {fitBounds}from'./canvas-camera'
import { commitPendingEdits, hasPendingEdits, registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { prepareDocumentJson, prepareDocumentJsonInWorker } from './prepared-document'
import { documentPreparationRuntime } from './document-preparation-identity'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'
import { desktopBridge, type LargeDocumentBridge, type LargeDocumentRow, type LargeDocumentPageRange, type LargeDocumentStatus, type DesktopResult } from './desktop'
import { apply, bounds, boxPoints, unionBounds } from './geometry'
import { sourceNodeEdit,type SourceNodeEdit } from './source-scene-patch'
import { validSourceObjectKey } from './source-object-key'

const admitted=<T,>(result:DesktopResult<T>):T=>{if(result.status!=='ok')throw Error(result.status==='cancelled'?'操作已取消':result.message);return result as T}
const sameSource=(a:LargeDocumentStatus|null,b:LargeDocumentStatus|null)=>!!a&&!!b&&a.owner.documentId===b.owner.documentId&&a.owner.sessionEpoch===b.owner.sessionEpoch&&a.revision===b.revision
type CanvasSelection=LargeDocumentRow&{sceneOffset?:number;sceneLimit?:number;previousRanges?:{offset:number;limit:number}[];pageId?:string}
const sceneRequest=(row:CanvasSelection)=>({key:row.key,...(row.sceneOffset?{offset:row.sceneOffset}:{}),...(row.sceneLimit===undefined?{}:{limit:row.sceneLimit})})
export type SourceWorkspace = {
  editor:Editor; ready:boolean; busy:boolean; locked:boolean; dirty:boolean; name:string; notice:string; error:string
  canvas:RefObject<HTMLDivElement|null>; navigation:ReactNode; showLayers:boolean; warnings:string[]
  dismissWarnings():void; dismissError?():void; cancel():void; save():Promise<void>; exportFile():Promise<void>; leave():Promise<void>; openFile(file:File):Promise<void>
  onViewport?:(box:SourceCanvasItem['placed'])=>void
  openingPreview?:OpeningView; openingPage?:string; focusedMaterial?:number; onDetail?:(roots:number[])=>void; hideNative?:boolean; pageBoxes?:SourceCanvasItem['placed'][]; onSourcePresented?(view:{x:number;y:number;zoom:number}):void; openPreviewPoint?(point:Point):void
  nativeCanvas?:{snapshot:SourceCanvasSnapshot;status?:NativeSourceStatus;onStatus(status:NativeSourceStatus):void;openPoint(point:Point):void}
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
  const [nativeSnapshot,setNativeSnapshot]=useState<SourceCanvasSnapshot|null>(null),[catalogue,setCatalogue]=useState<SourceCanvasItem[]>([]),[overview,setOverview]=useState(false)
  const [openingGeneration,setOpeningGeneration]=useState<number|undefined>(0)
  const openingSerial=useRef(0), exactView=useRef<{x:number;y:number;zoom:number}|undefined>(undefined)
  const quick=useSourceOpening(bridge,openingGeneration)
  const [showOpening,setShowOpening]=useState(true),[sourcePage,setSourcePage]=useState('')
  const opening=quick.view && (!status || status.revision===0 && status.owner.documentId===quick.view.owner.documentId &&
    status.owner.sessionEpoch===quick.view.owner.sessionEpoch) ? quick.view : undefined
  const openingRef=useRef(opening);openingRef.current=opening
  const [focusedMaterial,setFocusedMaterial]=useState<number>()
  const [detailIndices,setDetailIndices]=useState<number[]>([])
  const demand=useRef(''),detailRunning=useRef(false),declinedDemand=useRef('')
  const requestDetail=useCallback((indices:number[])=>{
    const key=indices.join(',')
    if(key===demand.current)return
    demand.current=key;declinedDemand.current='';setDetailIndices(indices);setShowOpening(true)
    if(detailRunning.current)void bridge.cancel().catch(()=>{})
  },[bridge])

  const fittedOpening=useRef(''),pendingMaterial=useRef<{id:string;pageId:string}|null>(null)
  const [nativeRenderStatus,setNativeRenderStatus]=useState<NativeSourceStatus>()
  // The import notification owns first display only. Navigation has its own
  // canvas badge and must not repeatedly reopen the large import card.
  const nativePresentedToken=useRef<string|undefined>(undefined)
  const nativeRenderError=useRef(false)
  const itemsForSnapshot=useRef<SourceCanvasItem[]>([]),catalogueStatus=useRef<LargeDocumentStatus|null>(null);
  const nativeSnapshotRef=useRef(nativeSnapshot);nativeSnapshotRef.current=nativeSnapshot
  const [busy,setBusy]=useState(false),busyRef=useRef(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [viewTab,setViewTab]=useState<'source'|'layers'>('source')
  const [editorLocked,setEditorLocked]=useState(false),[warnings,setWarnings]=useState<string[]>([])
  const navigationIntent=useRef(0),preparingOverview=useRef(false)
  const queuedLoad=useRef<CanvasSelection|null>(null),drainingLoads=useRef(false),preparingSource=useRef(false)
  const alive=useRef(true),started=useRef(false),baseline=useRef<DesignDocument|null>(null),canvas=useRef<HTMLDivElement>(null),abort=useRef<AbortController|null>(null)
  const activeRef=useRef(active);activeRef.current=active
  const clearNavigation=()=>{setRows([]);setParents([]);setOffset(0);setTotal(0);setFilter('');setQuery('')}
  const updateStatus=(next:LargeDocumentStatus)=>{
    // Keys are source-index ordinals, not stable object IDs. Never carry a
    // breadcrumb or a previously listed row into a newly indexed revision.
    if(!sameSource(statusRef.current,next))clearNavigation()
    if(next.revision!==0){pendingMaterial.current=null;openingRef.current=undefined;setOpeningGeneration(undefined);setShowOpening(false)}
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
  useEffect(()=>{
    if(!opening || nativeSnapshotRef.current || activeRef.current || fittedOpening.current===opening.owner.documentId)return
    const host=canvas.current
    if(!host || !host.clientWidth || !host.clientHeight)return
    fittedOpening.current=opening.owner.documentId
    editor.setMutationRestriction('素材预览正在精修，编辑将在原始图层就绪后开启。')
    editor.set({tool:'hand',selection:[],view:fitBounds(opening.bounds,{width:host.clientWidth,height:host.clientHeight})})
  },[opening,editor])
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
    navigationIntent.current++
    queuedLoad.current={...row,pageId:row.kind==='page'?row.id:row.pageId??parents.find(parent=>parent.kind==='page')?.id}
    if(preparingSource.current||preparingOverview.current||detailRunning.current){abort.current?.abort();void bridge.cancel().catch(()=>{})}
    void drainLoads()
  }
  const save=async()=>{
    if(!commitPendingEdits(editor)||editor.interactionActive)throw Error('请先完成当前输入或画布操作。')
    const original=baseline.current,current=editor.authoredDocument,row=activeRef.current
    if(!row||!original||current===original)return
    if(statusRef.current?.format==='json') {
      const next=admitted(await bridge.commitCanvas({...request(),key:row.key,json:JSON.stringify(current)}))
      if(!validSourceObjectKey(next.key))throw Error('保存回执缺少有效的源对象位置；当前画布已保留，请刷新源文件状态后重选。')
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
      if(!validSourceObjectKey(next.key))throw Error('保存回执缺少有效的源对象位置；当前画布已保留，请刷新源文件状态后重选。')
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
    const intent=navigationIntent.current
    const selectedSource=statusRef.current
    const selectedPage=activeRef.current
    await save()
    if(queuedLoad.current||navigationIntent.current!==intent)return
    if(!sameSource(selectedSource,statusRef.current)){
      const current=statusRef.current,rebound=activeRef.current
      if(nativeSnapshotRef.current&&current&&selectedSource&&current.owner.documentId===selectedSource.owner.documentId&&current.owner.sessionEpoch===selectedSource.owner.sessionEpoch){
        const items:SourceCanvasItem[]=[]
        for(;;){const page=admitted(await bridge.canvasLayout({...request(),offset:items.length,limit:200}));items.push(...page.items);if(!page.hasMore)break}
        const item=items.find(item=>item.id===row.id)
        if(!item)throw Error('该素材已不在当前源文件中')
        setCatalogue(items);row={...row,key:item.key}
      }
      // Property-only source saves keep page-root order. A paging request for
      // that same active page can use its new native key receipt immediately.
      else if(row.sceneOffset!==undefined&&row.kind==='page'&&selectedPage?.key===row.key&&selectedPage.id===row.id&&rebound?.id===row.id&&selectedSource&&current&&selectedSource.owner.documentId===current.owner.documentId&&selectedSource.owner.sessionEpoch===current.owner.sessionEpoch)
        row={...row,key:rebound.key}
      else throw Error('修改已保存，源对象位置已更新。请从刷新后的列表重新选择页面或对象。')
    }
    const previous=editor.authoredDocument
    const previousRow=activeRef.current
    const owner=request();setNotice(`正在准备 ${row.name}…`);preparingSource.current=true
    try {
    for (;;) {
    const result=admitted(await bridge.scene({...owner,...sceneRequest(row)}))
    if(!alive.current)return
    if(queuedLoad.current||navigationIntent.current!==intent)throw new DOMException('源对象请求已过期','AbortError')
    const controller=new AbortController();abort.current=controller
    const current=()=>alive.current&&navigationIntent.current===intent&&!queuedLoad.current&&statusRef.current?.owner===owner.owner&&statusRef.current.revision===owner.expectedRevision
    let prepared:ReturnType<typeof prepareDocumentJson>
    try {
      prepared=documentPreparationRuntime()?await prepareDocumentJsonInWorker(result.json,{documentId:owner.owner.documentId,version:owner.expectedRevision,generation:editor.sessionGeneration,session:owner.owner.sessionEpoch},controller.signal,current):prepareDocumentJson(result.json)
    } catch (error) {
      const range=result.pageRange, count=range?range.end-range.offset:0
      // Authored source bytes can fit while resolved component children do
      // not. Retry only an actual admission failure, using fewer whole source
      // roots at the same offset. Every retry goes through the original native
      // and WASM gates; cancellation/stale ownership never permits a retry.
      if (row.kind!=='page'||!range||count<=1||controller.signal.aborted||!current()||
          !/DOCUMENT_RESOURCE_LIMIT:|DOCUMENT_TOO_LARGE/.test(error instanceof Error?error.message:String(error))) throw error
      row={...row,sceneLimit:Math.floor(count/2)}
      setNotice(`${row.name}：正在按当前内存分段准备页面…`)
      continue
    }
    if(!current()||editor.authoredDocument!==previous||hasPendingEdits(editor)||editor.interactionActive)throw Error('页面准备期间产生了新修改；当前画布已保留。')
    editor.setMutationRestriction(undefined)
    if(!editor.load(prepared)){
      if(overview)editor.setMutationRestriction('请双击素材进入编辑。完整画板中的其他素材会保留。')
      throw Error(editor.state.message||'页面未能进入画布')
    }
    setOverview(false)
    baseline.current=editor.authoredDocument;activeRef.current=row;setActive(row);setViewTab('source')
    setPageRange(result.pageRange??null)
    const range=result.pageRange,partial=range&&(range.offset>0||range.end<range.totalRoots)
    setWarnings(result.warnings);setNotice(partial?`${row.name}：已载入第 ${range.offset+1}–${range.end} 个画板 / 对象，共 ${range.totalRoots} 个。可切换上一部分 / 下一部分；完整导出包含全部内容。`:`${row.kind==='page'?'完整页面':'当前画板 / 对象'}已载入：${result.nodes.toLocaleString()} 个场景节点。`)
    requestAnimationFrame(fit)
    break
    }
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
  const enterOverview=async(forceFull=false)=>{
    await save()
    const owner=request(), current=statusRef.current
    const known=sameSource(current,catalogueStatus.current)
    const items:SourceCanvasItem[]=known?itemsForSnapshot.current:[]
    if(!known)for(;;){
      const batch=admitted(await bridge.canvasLayout({...owner,offset:items.length,limit:200}))
      items.push(...batch.items)
      if(!batch.hasMore)break
    }
    if(!alive.current||!sameSource(current,statusRef.current))return
    itemsForSnapshot.current=items;catalogueStatus.current=current;setCatalogue(items)
    const edit=pendingMaterial.current;pendingMaterial.current=null
    if(edit){
      const target=items.find(row=>row.pageId===edit.pageId&&row.id===edit.id)
      if(target){requestLoad({...target,part:target.pageName,hasChildren:true});return}
    }
    const provisional=openingRef.current
    const canBrowse=!!provisional && provisional.owner.documentId===owner.owner.documentId &&
      provisional.owner.sessionEpoch===owner.owner.sessionEpoch && owner.expectedRevision===0 &&
      provisional.items.length===items.length && items.every((row,i)=>{
        const early=provisional.items[i],a=row.placed,b=early.placed
        return row.id===early.id && row.pageId===early.pageId && a.x===b.x && a.y===b.y && a.width===b.width && a.height===b.height
      })
    if(provisional&&!canBrowse){openingRef.current=undefined;setOpeningGeneration(undefined);setShowOpening(false)}
    let snapshot=nativeSnapshotRef.current
    if(canBrowse&&!forceFull){
      // The source and every material remain addressable in the catalogue.
      // No full-scene conversion or GPU draw is needed to show the overview.
      snapshot=null;nativeSnapshotRef.current=null;setNativeSnapshot(null);setShowOpening(true)
    } else if(!snapshot || snapshot.materialKeys || snapshot.owner.documentId!==owner.owner.documentId ||
        snapshot.owner.sessionEpoch!==owner.owner.sessionEpoch || snapshot.revision!==owner.expectedRevision){
      preparingOverview.current=true
      try{snapshot=admitted(await bridge.canvasSnapshot({...owner,navigationPreview:!canBrowse && !renderExecutionPolicy.cpuOnly && !renderExecutionPolicy.hdrCompositing}))}
      finally{preparingOverview.current=false}
      if(queuedLoad.current||!alive.current||!sameSource(current,statusRef.current))return
      if(items.length!==snapshot.roots)throw Error('完整画板目录与源内容不一致')
      nativeSnapshotRef.current=snapshot;setNativeSnapshot(snapshot)
    }
    const keepView=canBrowse && !activeRef.current?editor.effectiveView():undefined
    editor.setMutationRestriction(undefined)
    if(activeRef.current && !editor.load(blank(),true))throw Error('画板导航未能准备完成')
    editor.setMutationRestriction('请双击素材进入编辑。完整画板中的其他素材会保留。')
    editor.set({tool:'hand',selection:[],...(keepView?{view:keepView}:{})})
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);setOverview(true);setViewTab('source')
    setNativeRenderStatus(snapshot?{phase:'loading',done:0,total:0}:undefined);setWarnings(snapshot?.warnings??[])
    setNotice(`共 ${items.length} 个素材。可切换页面，放大查看细节，或双击进入编辑。`)
    const bounds=snapshot?.bounds??provisional?.bounds
    if(!keepView && bounds)requestAnimationFrame(()=>{const host=canvas.current;if(host)editor.set({view:fitBounds(bounds,{width:host.clientWidth,height:host.clientHeight})})})
  }
  useEffect(()=>{
    if(!overview || !opening || !status || busy || active || !itemsForSnapshot.current.length)return
    if(nativeSnapshotRef.current && !nativeSnapshotRef.current.materialKeys)return
    const signature=detailIndices.join(',')
    if(!signature){
      if(nativeSnapshotRef.current?.materialKeys){nativeSnapshotRef.current=null;setNativeSnapshot(null);setNativeRenderStatus(undefined);setShowOpening(true)}
      return
    }
    if(declinedDemand.current===signature)return
    const keys=detailIndices.map(i=>itemsForSnapshot.current[i]?.key).filter((key):key is string=>!!key).sort()
    if(!keys.length || nativeSnapshotRef.current?.materialKeys?.join(',')===keys.join(','))return
    const selected=status
    void run(async()=>{
      detailRunning.current=true;setShowOpening(true)
      try{
        const frame=admitted(await bridge.canvasSnapshot({owner:selected.owner,expectedRevision:selected.revision,materialKeys:keys}))
        if(!alive.current || demand.current!==signature || activeRef.current || !sameSource(selected,statusRef.current))return
        if(frame.materialKeys?.join(',')!==keys.join(',') || frame.roots!==keys.length)throw Error('素材精修范围不匹配')
        nativeSnapshotRef.current=frame;setNativeSnapshot(frame);setWarnings(frame.warnings)
        setNativeRenderStatus({phase:'refining',done:0,total:frame.roots})
      }catch(error){
        if(demand.current!==signature || queuedLoad.current)return
        declinedDemand.current=signature;throw error
      }finally{detailRunning.current=false}
    })
  },[overview,opening?.owner.documentId,status,busy,active,detailIndices,bridge])
  useEffect(()=>{
    if(overview && !busy && !active && status && !opening && !nativeSnapshotRef.current && !error)
      void run(()=>enterOverview(true),true)
  },[overview,busy,active,status,opening,error])
  const openSelectedFile=async(file?:File)=>{
    try{return await (file?bridge.openFile(file):bridge.open())}
    catch(error){openingRef.current=undefined;setOpeningGeneration(undefined);setShowOpening(false);throw error}
  }
  const openInitialCanvas=async()=>{
    if(statusRef.current?.format==='sketch'&&typeof bridge.canvasSnapshot==='function'){await enterOverview();return}
    const top=admitted(await bridge.children({...request(),limit:100,canvasOnly:true})).items
    let row=top.find(row=>row.kind==='page')||top.find(row=>!['document','rect','style'].includes(row.kind))
    // Enter one board quickly, while leaving the complete page list visible.
    // Selecting a page uses budgeted consecutive ranges with explicit paging.
    if(row?.kind==='page'&&row.hasChildren){
      const page=row,children=admitted(await bridge.children({...request(),key:page.key,limit:100,canvasOnly:true})).items
      const board=children.find(row=>['artboard','symbolMaster','frame','group'].includes(row.kind))
      if(board)row={...board,pageId:page.id} as CanvasSelection
    }
    if(row){await load(row);setViewTab('source')}
    else setNotice('此文件没有可显示的页面或画板。')
  }
  useEffect(()=>{
    alive.current=true
    if(!started.current){started.current=true;void run(async()=>{
      const result=await openSelectedFile(initialFile);if(result.status==='cancelled'){onExit();return}
      const next=admitted(result);if(!alive.current)return;updateStatus(next)
      await openInitialCanvas()
    },true)}
    return()=>{alive.current=false;queueMicrotask(()=>{if(!alive.current){queuedLoad.current=null;abort.current?.abort();editor.dispose()}})}
  },[])
  useEffect(()=>{
    // The host admits one source operation at a time. Auto-entry, save and
    // history own that lane; sidebar refresh starts after their receipt.
    if(!status||busy||nativeSnapshot||opening)return
    let current=true
    const listedSource=status
    setRows([])
    void bridge.children({...request(),key:parents.at(-1)?.key,offset,limit:100,canvasOnly:true,...(filter?{query:filter}:{})}).then(result=>{if(current&&alive.current&&sameSource(listedSource,statusRef.current)){const value=admitted(result);setRows(value.items);setTotal(value.total)}}).catch(error=>{if(current&&alive.current)setError(String(error))})
    return()=>{current=false}
  },[status,parents,offset,filter,busy,nativeSnapshot,opening?.owner.documentId])
  useEffect(()=>{const timer=setTimeout(()=>{setFilter(query.trim());setOffset(0)},180);return()=>clearTimeout(timer)},[query])
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
    if(nativeSnapshotRef.current){setOverview(false);await enterOverview()}
  },true)
  const openFile=(file:File)=>run(async()=>{
    await save()
    if(statusRef.current)admitted(await bridge.close(request()))
    if(!/\.(json|sketch)$/i.test(file.name)){flushSync(()=>onExit(file));return}
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);itemsForSnapshot.current=[]
    editor.setMutationRestriction(undefined);editor.load(blank(),true);editor.setMutationRestriction('正在准备源文件，暂时只能浏览。');editor.set({tool:'hand',selection:[]})
    openingRef.current=undefined;statusRef.current=null;setStatus(null)
    nativeSnapshotRef.current=null;setNativeSnapshot(null);setCatalogue([]);setOverview(false);setSourcePage('')
    setFocusedMaterial(undefined);requestDetail([]);pendingMaterial.current=null;fittedOpening.current='';exactView.current=undefined;setShowOpening(true);setOpeningGeneration(++openingSerial.current)
    const next=admitted(await openSelectedFile(file));if(!alive.current)return
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);nativeSnapshotRef.current=null;setNativeSnapshot(null);setCatalogue([]);setOverview(false);updateStatus(next)
    await openInitialCanvas()
  },true)
  const allPages=()=>{setParents([]);setOffset(0);setFilter('');setQuery('')}
  const openMaterial=(item:SourceCanvasItem)=>requestLoad({...item,part:item.pageName,hasChildren:true})
  const materialRows=nativeSnapshot?catalogue:(opening?.items??[])
  const pages=useMemo(()=>{
    if(opening?.pages)return opening.pages
    const groups=new Map<string,[string,string,number]>()
    for(const row of materialRows){const page=groups.get(row.pageId);if(page)page[2]++;else groups.set(row.pageId,[row.pageId,row.pageName,1])}
    return [...groups.values()]
  },[opening?.pages,materialRows])
  const pageBoxes=useMemo(()=>sourcePage?materialRows.filter(row=>row.pageId===sourcePage).map(row=>row.placed):undefined,[materialRows,sourcePage])
  const navigate=(pageId:string,item?:SourceCanvasItem)=>{
    const host=canvas.current;if(!host)return
    navigationIntent.current++;pendingMaterial.current=null;queuedLoad.current=null;setSourcePage(pageId)
    if(preparingSource.current){abort.current?.abort();void bridge.cancel().catch(()=>{})}
    const index=item?materialRows.indexOf(item):-1
    setFocusedMaterial(index>=0?index:undefined);requestDetail(index>=0?[index]:[])
    quick.focus(pageId||undefined,index>=0?index:undefined)
    const group=pageId?materialRows.filter(row=>row.pageId===pageId):materialRows
    const box=item?.placed??(group.length?unionBounds(group.map(row=>row.placed)):undefined)
    if(box){
      const view=fitBounds(box,{width:host.clientWidth,height:host.clientHeight}), exact=exactView.current
      if(opening&&(!exact||exact.zoom!==view.zoom||exact.x!==view.x||exact.y!==view.y))setShowOpening(true)
      editor.set({view})
    }
  }
  const editMaterial=(row:SourceCanvasItem)=>{
    const exact=itemsForSnapshot.current.find(item=>item.id===row.id&&item.pageId===row.pageId)
    if(!exact||!statusRef.current){pendingMaterial.current={id:row.id,pageId:row.pageId};setNotice('正在准备这个素材的原始图层…');return}
    openMaterial(exact)
  }
  const openPreviewPoint=(point:Point)=>{
    const item=materialRows.find(row=>point.x>=row.placed.x&&point.y>=row.placed.y&&point.x<=row.placed.x+row.placed.width&&point.y<=row.placed.y+row.placed.height)
    if(item)editMaterial(item)
  }
  const scopedBoxes=useMemo(()=>{
    const keys=nativeSnapshot?.materialKeys
    if(!keys)return pageBoxes
    const selected=new Set(keys)
    return catalogue.filter(row=>selected.has(row.key)&&(!sourcePage||row.pageId===sourcePage)).map(row=>row.placed)
  },[catalogue,nativeSnapshot?.materialKeys,pageBoxes,sourcePage])
  const browsing=overview||!!opening&&!active
  const nativeNavigation=<section className="source-board-navigation" data-preview-cache={opening?.cacheHit} data-thumbnail-renders={opening?.rendered} data-detail-roots={nativeSnapshot?.roots??0} data-preview-count={opening?.images.size} data-preview-complete={!!opening && opening.finished && opening.images.size===opening.items.length} data-active-source-page={sourcePage} data-listing="true" data-has-canvas={!overview} aria-label="完整画板素材">
    <div className="source-pages-heading"><Frame size={15}/><span>完整画板</span><small>{materialRows.length} 个素材</small></div>
    {browsing&&<label className="source-page-picker">页面 <select aria-label="素材页面" value={sourcePage} onChange={e=>{setQuery('');navigate(e.target.value)}}>
      <option value="">全部页面</option>{pages.map(([id,name,count])=><option key={id} value={id}>{name}（{count}）</option>)}</select></label>}
    {browsing&&opening&&(!nativeSnapshot||nativeSnapshot.materialKeys)&&<button className="source-overview-back" disabled={busy} onClick={()=>void run(()=>enterOverview(true),true)}>精修完整画板</button>}
    {!browsing&&<button className="source-overview-back" disabled={busy} onClick={()=>void run(enterOverview,true)}><ArrowLeft size={14}/>返回完整画板</button>}
    <form className="layer-search source-search" onSubmit={event=>event.preventDefault()}><Search size={13}/><input aria-label="搜索素材" placeholder="搜索素材…" value={query} onChange={event=>setQuery(event.target.value)}/></form>
    <div className="source-workspace-rows" role="list" aria-label="全部素材">{materialRows.filter(item=>(!sourcePage||item.pageId===sourcePage)&&`${item.name} ${item.pageName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item=><div className="source-page-row" data-active={active?.id===item.id} role="listitem" key={item.key}>
      <button className="source-page-entry" disabled={busy&&!browsing} title={`${item.pageName} · ${item.name}；双击编辑`} onClick={()=>{if(browsing)navigate(sourcePage,item);else openMaterial(item)}} onDoubleClick={()=>editMaterial(item)}><span className="source-row-icon"><Frame size={14}/></span><span className="source-row-name">{item.name}</span><small className="source-row-page">{item.pageName}</small></button>
    </div>)}</div>
    <footer className="source-history"><span>完整源文件保留全部内容</span><button aria-label="撤销已保存修改" disabled={busy||!status?.undoCount} onClick={()=>void history('undo')}><Undo2 size={14}/></button><button aria-label="重做已保存修改" disabled={busy||!status?.redoCount} onClick={()=>void history('redo')}><Redo2 size={14}/></button></footer>
  </section>
  const navigation=nativeSnapshot||opening?nativeNavigation:<section className="source-board-navigation" data-listing={viewTab==='source'} data-has-canvas={!!active} aria-label="源文件页面">
    <nav className="source-view-tabs" aria-label="侧栏视图"><button aria-pressed={viewTab==='source'} onClick={()=>setViewTab('source')}>页面 / 画板</button><button disabled={!active} aria-pressed={viewTab==='layers'} onClick={()=>setViewTab('layers')}>图层</button></nav>
    {viewTab==='source'&&<>
      <div className="source-pages-heading">{parents.length>0?<button className="source-back" aria-label="全部页面" title="返回全部页面" disabled={busy} onClick={allPages}><ArrowLeft size={14}/></button>:null}<span title={parents.at(-1)?.name}>{parents.at(-1)?.name||'页面'}</span><small>{total}</small></div>
      <form className="layer-search source-search" onSubmit={event=>{event.preventDefault();setFilter(query.trim());setOffset(0)}}><Search size={13}/><input aria-label="搜索源对象" placeholder={parents.length?'搜索当前画板…':'搜索页面…'} value={query} maxLength={256} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={12}/></button>}</form>
      <div className="source-workspace-rows" role="list" aria-label={parents.length?'源画板列表':'源页面列表'}>{rows.map((row,index)=>{
        const selected=active?.key===row.key||(row.kind==='page'&&row.id===(active?.kind==='page'?active.id:active?.pageId))
        return <div className="source-page-row" key={row.key} data-source-key={row.key} role="listitem" data-active={selected}>
          <button className="source-page-entry" aria-current={selected?'true':undefined} aria-label={`${row.kind==='page'?'载入页面':'载入'} ${row.name}`} disabled={['document','rect','style','exportOptions','rulerData','MSImmutableFreeformGroupLayout'].includes(row.kind)} onClick={()=>requestLoad(row)} title={row.name}>
            <span className="source-row-icon">{row.kind==='page'?String(offset+index+1).padStart(2,'0'):<Frame size={14}/>}</span><span className="source-row-name">{row.name||'未命名'}</span>{selected&&<span className="page-dot"/>}
          </button>{row.hasChildren&&<button className="source-row-expand" aria-label={`展开 ${row.name}`} title="浏览画板与图层" disabled={busy} onClick={()=>{setParents([...parents,row]);setQuery('');setFilter('');setOffset(0)}}><ChevronRight size={14}/></button>}
        </div>
      })}{!busy&&rows.length===0&&<p className="source-list-empty">{filter?'没有匹配的页面或画板':'没有可显示的页面或画板'}</p>}</div>
      {total>100&&<div className="source-list-paging"><button aria-label="上一页" disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}><ChevronLeft size={14}/></button><span>{offset+1}–{Math.min(offset+100,total)} / {total}</span><button aria-label="下一页" disabled={busy||offset+100>=total} onClick={()=>setOffset(offset+100)}><ChevronRight size={14}/></button></div>}
    </>}
    {active&&pageRange&&(pageRange.offset>0||pageRange.nextOffset!==null)&&<nav className="source-page-range" aria-label="页面分段"><span title={active.name}>内容 {pageRange.offset+1}–{pageRange.end} / {pageRange.totalRoots}</span><button aria-label="上一部分" title="上一部分" disabled={busy||!active.previousRanges?.length} onClick={()=>{const previous=active.previousRanges!,range=previous.at(-1)!;requestLoad({...active,sceneOffset:range.offset,sceneLimit:range.limit,previousRanges:previous.slice(0,-1)})}}><ChevronLeft size={14}/></button><button aria-label="下一部分" title="下一部分" disabled={busy||pageRange.nextOffset===null} onClick={()=>requestLoad({...active,sceneOffset:pageRange.nextOffset!,previousRanges:[...(active.previousRanges??[]),{offset:pageRange.offset,limit:pageRange.end-pageRange.offset}]})}><ChevronRight size={14}/></button></nav>}
    <footer className="source-history"><span>全部内容随文件导出</span><button aria-label="撤销已保存修改" title="撤销已保存修改" disabled={busy||!status?.undoCount} onClick={()=>void history('undo')}><Undo2 size={14}/></button><button aria-label="重做已保存修改" title="重做已保存修改" disabled={busy||!status?.redoCount} onClick={()=>void history('redo')}><Redo2 size={14}/></button></footer>
  </section>
  return renderWorkbench({editor,ready:!!active||overview||!!opening,busy,locked:editorLocked,dirty:!!active&&editor.authoredDocument!==baseline.current,
    name:status?.name||initialFile?.name||'正在打开文件',notice:opening&&busy&&!active?`${pages.length} 页，素材预览 ${opening.images.size}/${materialRows.length}。可切页、平移和缩放，原始图层正在后台准备。`:notice,error,canvas,navigation,showLayers:!!active&&!overview,warnings,
    openingPreview:!active?opening:undefined,openingPage:sourcePage||undefined,focusedMaterial,onDetail:requestDetail,onViewport:quick.setViewport,hideNative:!!opening&&showOpening,pageBoxes:!active?scopedBoxes:undefined,openPreviewPoint,
    onSourcePresented:view=>{const v=editor.effectiveView();if(view.x===v.x&&view.y===v.y&&view.zoom===v.zoom)setShowOpening(false)},
    nativeCanvas:overview&&nativeSnapshot?{snapshot:nativeSnapshot,status:nativeRenderStatus,onStatus:status=>{if(nativeRenderError.current&&status.phase==='ready'){nativeRenderError.current=false;setError('');setNativeRenderStatus(status);}if(status.phase==='error')nativeRenderError.current=true;if(nativePresentedToken.current===nativeSnapshot.token&&status.phase!=='error')return;if(status.phase==='ready')nativePresentedToken.current=nativeSnapshot.token;setNativeRenderStatus(status);if(status.phase==='error')setError(status.error??'画板绘制未完成');else if(status.phase==='ready')setNotice(nativeSnapshot.materialKeys?`当前视口已精修 ${nativeSnapshot.roots} 个素材。`:`完整画板已显示：${nativeSnapshot.roots} 个素材。双击素材进入编辑。`);else setNotice(status.phase==='loading'?'正在准备完整画板显示…':`正在绘制完整画板 ${status.done} / ${status.total}…`)},openPoint:point=>{if(busyRef.current)return;const item=catalogue.filter(item=>point.x>=item.placed.x&&point.x<=item.placed.x+item.placed.width&&point.y>=item.placed.y&&point.y<=item.placed.y+item.placed.height).sort((a,b)=>a.placed.width*a.placed.height-b.placed.width*b.placed.height)[0];if(item)openMaterial(item)}}:undefined,
    dismissWarnings:()=>setWarnings([]),dismissError:()=>setError(''),cancel:()=>{abort.current?.abort();void bridge.cancel().catch(error=>setError(String(error)))},
    save:()=>run(save),exportFile,leave,openFile})
}
