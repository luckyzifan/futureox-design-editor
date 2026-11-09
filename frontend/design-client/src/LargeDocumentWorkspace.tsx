import {SOURCE_DETAIL_SAMPLE_MS,useSourceOpening,visibleMaterialDetail,type OpeningView} from './source-opening-preview'
import {renderExecutionPolicy} from './kernel/client'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Frame, Search, Undo2, Redo2, X } from 'lucide-react'
import { Editor } from './engine'
import { blank, type DesignDocument, type Point } from './model'
import type {SourceCanvasSnapshot,SourceCanvasItem} from './desktop'
import type {NativeSourceStatus} from './kernel/NativeSourceSurface'
import {includesMaterials,materialScope,thumbnailScale,visibleMaterialWindow,firstVisibleMaterialKeys,smallerMaterialRequest} from './source-material-scope'
import {fitBounds}from'./canvas-camera'
import { commitPendingEdits, hasPendingEdits, registerPendingEdit, pendingEditsChanged, subscribePendingEdits } from './pending-edits'
import { prepareDocumentJson, prepareDocumentJsonInWorker } from './prepared-document'
import { nativeDesignJson } from './native-design-json'
import { documentPreparationRuntime } from './document-preparation-identity'
import { dispatchEditorCommand, resolveDesktopEditorCommand } from './editor-commands'
import { desktopBridge, type LargeDocumentBridge, type LargeDocumentRow, type LargeDocumentPageRange, type LargeDocumentStatus, type DesktopResult } from './desktop'
import { apply, bounds, boxPoints, SpatialIndex, unionBounds } from './geometry'
import { sourceNodeEdit,type SourceNodeEdit } from './source-scene-patch'
import { validSourceObjectKey } from './source-object-key'
import { peekChangedNodes } from './document-patch'

const admitted=<T,>(result:DesktopResult<T>):T=>{if(result.status!=='ok')throw Error(result.status==='cancelled'?'操作已取消':result.message);return result as T}
const PREPARING_NOTICE='正在准备这个素材的原始图层…'
const sameSource=(a:LargeDocumentStatus|null,b:LargeDocumentStatus|null)=>!!a&&!!b&&a.owner.documentId===b.owner.documentId&&a.owner.sessionEpoch===b.owner.sessionEpoch&&a.revision===b.revision
type CanvasSelection=LargeDocumentRow&{afterLoad?:(id:string)=>void;catalogueMaterial?:boolean;sceneOffset?:number;sceneLimit?:number;previousRanges?:{offset:number;limit:number}[];pageId?:string}
const sceneRequest=(row:CanvasSelection)=>({key:row.key,...(row.sceneOffset?{offset:row.sceneOffset}:{}),...(row.sceneLimit===undefined?{}:{limit:row.sceneLimit})})
export type SourceWorkspace = {
  editor:Editor; ready:boolean; busy:boolean; locked:boolean; dirty:boolean; name:string; notice:string; error:string
  canvas:RefObject<HTMLDivElement|null>; navigation:ReactNode; showLayers:boolean; warnings:string[]
  dismissWarnings():void; dismissError?():void; cancel():void; save():Promise<void>; exportFile():Promise<void>; leave():Promise<void>; openFile(file:File):Promise<void>
  prepareExport(open:()=>void):void
  exportSelectedSketch?():Promise<string|undefined>
  selectMaterialAt?:(point:Point)=>void
  selectedMaterialBox?:SourceCanvasItem['placed']
  onViewport?:(box:SourceCanvasItem['placed'],anchor?:Point,density?:number)=>void
  pickMaterial?:(point:Point)=>SourceCanvasItem|undefined
  navigatingMaterials?:boolean
  prepareSourceDisplay?:boolean;openingPreview?:OpeningView; openingPage?:string; focusedMaterial?:number; onDetail?:(roots:number[])=>void; hideNative?:boolean;parkNative?:boolean; pageBoxes?:SourceCanvasItem['placed'][]; onSourcePresented?(view:{x:number;y:number;zoom:number}):void; openPreviewPoint?(point:Point):void
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
  const [selectedMaterialId,setSelectedMaterialId]=useState<string>()
  const [focusedMaterial,setFocusedMaterial]=useState<number>()
  const [detailIndices,setDetailIndices]=useState<number[]>([])
  const demand=useRef(''), demandGeneration=useRef(0),detailRunning=useRef(false),declinedDemand=useRef('')
  const viewportDemand=useRef(false),zoomAnchor=useRef<Point|undefined>(undefined)
  const requestedIndices=useRef<number[]>([]),preparingKeys=useRef<readonly string[]>([])
  const reviewedScope=useRef<{token:string;at:number}|undefined>(undefined)
  const lastMaterialToken=useRef<string|undefined>(undefined)
  const pageDetailIntent=useRef<string|undefined>(undefined)
  const requestDetail=useCallback((indices:number[],retry=false,fromViewport=false)=>{
    const key=indices.join(',')
    if(key===demand.current && !(retry && key===declinedDemand.current))return
    demandGeneration.current++;demand.current=key;declinedDemand.current='';viewportDemand.current=fromViewport;requestedIndices.current=indices;setDetailIndices(indices)
    if(!indices.length)setShowOpening(true)
    if(detailRunning.current && preparingKeys.current.length && indices.length){
      const items=itemsForSnapshot.current,wanted=indices.map(i=>items[i]?.key)
      const current=nativeSnapshotRef.current
      const active=current&&current.token===lastMaterialToken.current&&!current.viewportSubset?current:undefined
      let cancel=!includesMaterials(preparingKeys.current,wanted)||!!active&&includesMaterials(active.materialKeys,wanted)
      if(!cancel&&fromViewport&&indices.length<=2&&preparingKeys.current.length>=6&&canvas.current){
        const v=editor.effectiveView()
        const viewport={x:-v.x/v.zoom,y:-v.y/v.zoom,width:canvas.current.clientWidth/v.zoom,height:canvas.current.clientHeight/v.zoom}
        const next=materialScope(items,indices,nativePresentedToken.current===active?.token?active?.materialKeys:undefined,viewport)
        cancel=smallerMaterialRequest(items,preparingKeys.current,next)
      }
      if(cancel)
        void bridge.cancel().catch(()=>{})
    }
  },[bridge,editor])
  const requestViewportDetail=useCallback((indices:number[])=>{
    // A preview wheel or idle callback must not cancel explicit page work.
    if(pageDetailIntent.current!==demand.current)requestDetail(indices,false,true)
  },[requestDetail])

  const fittedOpening=useRef(''),pendingMaterial=useRef<{id:string;pageId:string;afterLoad?:(id:string)=>void}|null>(null)
  const [nativeRenderStatus,setNativeRenderStatus]=useState<NativeSourceStatus>()
  const [failedOpeningToken,setFailedOpeningToken]=useState<string>()
  // The import notification owns first display only. Navigation has its own
  // canvas badge and must not repeatedly reopen the large import card.
  const nativePresentedToken=useRef<string|undefined>(undefined)
  const nativeRenderError=useRef(false)
  const itemsForSnapshot=useRef<SourceCanvasItem[]>([]),catalogueStatus=useRef<LargeDocumentStatus|null>(null);
  const nativeSnapshotRef=useRef(nativeSnapshot);nativeSnapshotRef.current=nativeSnapshot
  const [busy,setBusy]=useState(false),busyRef=useRef(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const autosave=useRef<Promise<void>|undefined>(undefined)
  const rejectedAutosave=useRef<DesignDocument|undefined>(undefined)
  const [viewTab,setViewTab]=useState<'source'|'layers'>('source')
  const [editorLocked,setEditorLocked]=useState(false),[warnings,setWarnings]=useState<string[]>([])
  const navigationIntent=useRef(0),preparingOverview=useRef(false)
  const queuedLoad=useRef<CanvasSelection|null>(null),drainingLoads=useRef(false),preparingSource=useRef(false)
  const alive=useRef(true),started=useRef(false),baseline=useRef<DesignDocument|null>(null),canvas=useRef<HTMLDivElement>(null),abort=useRef<AbortController|null>(null)
  const admittedOpen=useRef<LargeDocumentStatus|null>(null)
  const openOutcome=useRef<'idle'|'pending'|'ok'|'cancelled'|'error'>('idle')
  const rebindTried=useRef(false)
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
    try{await work()}catch(error){if(alive.current&&!(queuedLoad.current&&(/取消|cancel|abort/i.test(String(error))))){setError(error instanceof Error?error.message:String(error));setNotice(current=>current===PREPARING_NOTICE?'':current)}}
    finally{busyRef.current=false;if(alive.current){setBusy(false);setEditorLocked(false);if(queuedLoad.current&&!drainingLoads.current)queueMicrotask(()=>void drainLoads())}else queueMicrotask(()=>{if(alive.current)setBusy(false)})}
  }
  const afterAutosave=async(work:()=>Promise<void>,lockEditor=false)=>{
    await autosave.current
    if(alive.current)await run(work,lockEditor)
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
  const save=async(automatic=false)=>{
    if(automatic){if(hasPendingEdits(editor)||editor.interactionActive||editor.state.busy)return}
    else if(!commitPendingEdits(editor)||editor.interactionActive)throw Error('请先完成当前输入或画布操作。')
    const original=baseline.current,current=editor.authoredDocument,row=activeRef.current
    if(!row||!original||current===original)return
    if(statusRef.current?.format==='json') {
      const next=admitted(await bridge.commitCanvas({...request(),key:row.key,json:JSON.stringify(current)}))
      if(!validSourceObjectKey(next.key))throw Error('保存回执缺少有效的源对象位置；当前画布已保留，请刷新源文件状态后重选。')
      updateStatus(next);const rebound={...row,key:next.key};activeRef.current=rebound;setActive(rebound)
      baseline.current=current
      if(!automatic&&(editor.authoredDocument!==current||hasPendingEdits(editor)))throw Error('编辑仍在进行，自动保存完成后可切换。')
      return
    }
    const {nodes:a,...aMeta}=original,{nodes:b,...bMeta}=current
    const metaKeys=new Set([...Object.keys(aMeta),...Object.keys(bMeta)])
    const metaIdentical=[...metaKeys].every(key=>Object.is((aMeta as Record<string,unknown>)[key],(bMeta as Record<string,unknown>)[key]))
    if(!metaIdentical&&JSON.stringify(aMeta)!==JSON.stringify(bMeta))throw Error('此页面会话支持已有图层的属性编辑；结构修改请先撤销，再进入局部对象编辑。')
    const changes:Record<string,SourceNodeEdit>={}
    for(const [id,node]of Object.entries(peekChangedNodes(original,current))){
      if(!node)throw Error('此页面会话支持已有图层的属性编辑；结构修改请先撤销，再进入局部对象编辑。')
      const before=a[id]
      if(!before)throw Error('新增图层需要局部对象编辑会话。')
      const edit=sourceNodeEdit(before,node);if(edit)changes[id]=edit
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
    if(!automatic&&(editor.authoredDocument!==current||hasPendingEdits(editor)))throw Error('编辑仍在进行，自动保存完成后可切换。')
    if(!automatic)setNotice('修改已自动保存到独立工作副本，原文件不变。')
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
    if(!sameSource(selectedSource,statusRef.current)||row.catalogueMaterial&&!sameSource(catalogueStatus.current,statusRef.current)){
      const current=statusRef.current,rebound=activeRef.current
      if((row.catalogueMaterial||nativeSnapshotRef.current)&&current&&selectedSource&&current.owner.documentId===selectedSource.owner.documentId&&current.owner.sessionEpoch===selectedSource.owner.sessionEpoch){
        const items:SourceCanvasItem[]=[]
        for(;;){const page=admitted(await bridge.canvasLayout({...request(),offset:items.length,limit:200}));items.push(...page.items);if(!page.hasMore)break}
        const item=items.find(item=>item.id===row.id&&(!row.pageId||item.pageId===row.pageId))
        if(!item)throw Error('该素材已不在当前源文件中')
        itemsForSnapshot.current=items;catalogueStatus.current=current;setCatalogue(items);row={...row,key:item.key}
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
    const sourceJson=nativeDesignJson(result.json)
    try {
      prepared=documentPreparationRuntime()?await prepareDocumentJsonInWorker(sourceJson,{documentId:owner.owner.documentId,version:owner.expectedRevision,generation:editor.sessionGeneration,session:owner.owner.sessionEpoch},controller.signal,current):prepareDocumentJson(sourceJson)
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
    const {afterLoad,...loaded}=row
    baseline.current=editor.authoredDocument;activeRef.current=loaded;setActive(loaded);setViewTab('source')
    setPageRange(result.pageRange??null)
    const range=result.pageRange,partial=range&&(range.offset>0||range.end<range.totalRoots)
    setWarnings(result.warnings);setNotice(partial?`${row.name}：已载入第 ${range.offset+1}–${range.end} 个画板 / 对象，共 ${range.totalRoots} 个。可切换上一部分 / 下一部分；完整导出包含全部内容。`:`${row.kind==='page'?'完整页面':'当前画板 / 对象'}已载入：${result.nodes.toLocaleString()} 个场景节点。`)
    requestAnimationFrame(fit)
    afterLoad?.(row.id)
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
      if(target){requestLoad({...target,part:target.pageName,hasChildren:true,catalogueMaterial:true,afterLoad:edit.afterLoad});return}
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
    const signature=detailIndices.join(','),generation=demandGeneration.current
    if(!signature)return
    if(declinedDemand.current===signature)return
    const items=itemsForSnapshot.current,snapshot=nativeSnapshotRef.current
    const current=snapshot && snapshot.token===lastMaterialToken.current && snapshot.owner.documentId===status.owner.documentId &&
      snapshot.owner.sessionEpoch===status.owner.sessionEpoch && snapshot.revision===status.revision ? snapshot : undefined
    const wanted=materialScope(items,detailIndices,undefined)
    if(!wanted.length)return
    if(!current?.viewportSubset&&includesMaterials(current?.materialKeys,wanted)){
      if(nativePresentedToken.current===current?.token)setShowOpening(false)
      return
    }
    const view=editor.effectiveView(),host=canvas.current
    const viewport=viewportDemand.current&&host?{x:-view.x/view.zoom,y:-view.y/view.zoom,width:host.clientWidth/view.zoom,height:host.clientHeight/view.zoom}:undefined
    const previous=nativePresentedToken.current===current?.token?current?.materialKeys:undefined
    const keys=materialScope(items,detailIndices,previous,viewport)
    const navigationWindow=viewport&&focusedMaterial===undefined?visibleMaterialWindow(items,detailIndices,viewport):undefined
    const selected=status
    const focal=viewport&&focusedMaterial===undefined?firstVisibleMaterialKeys(items,detailIndices,viewport,current?.materialKeys,zoomAnchor.current):undefined
    void run(async()=>{
      detailRunning.current=true
      try{
        // Publishing a replacement revokes the displayed snapshot. A single
        // sampled neighbour on a reversing gesture must not discard all of
        // its native tiles. Recheck the actual camera before asking the host.
        const held=current?.materialKeys
        if(viewport && focusedMaterial===undefined && current && !current.viewportSubset && held && held.length>=6 &&
            nativePresentedToken.current===current.token && wanted.some(key=>held.includes(key)) &&
            wanted.filter(key=>!held.includes(key)).length<=2 && host){
          const now=performance.now(),last=reviewedScope.current
          if(last?.token!==current.token || now-last.at>=2*SOURCE_DETAIL_SAMPLE_MS){
            reviewedScope.current={token:current.token,at:now}
            await new Promise<void>(resolve=>setTimeout(resolve,SOURCE_DETAIL_SAMPLE_MS))
          }
          if(!alive.current || activeRef.current || queuedLoad.current || !sameSource(selected,statusRef.current) ||
              demandGeneration.current!==generation || nativeSnapshotRef.current!==current || !viewportDemand.current)return
          const live=openingRef.current
          if(live){
            const needed=visibleMaterialDetail(live,editor.effectiveView(),host.clientWidth,host.clientHeight,
              window.devicePixelRatio||1,sourcePage||undefined,undefined)
            if(needed.join(',')!==signature){requestDetail(needed,false,true);return}
          }
        }
        preparingKeys.current=keys
        if(focal){
          const first=await bridge.canvasSnapshot({owner:selected.owner,expectedRevision:selected.revision,materialKeys:focal}).catch(()=>undefined)
          if(!alive.current||activeRef.current||!sameSource(selected,statusRef.current))return
          if(first?.status==='ok'){
            lastMaterialToken.current=first.token
            if(first.materialKeys?.join(',')!==focal.join(',')||first.roots!==focal.length)throw Error('素材精修范围不匹配')
            if(demandGeneration.current!==generation)return
            const subset={...first,viewportSubset:true}
            nativeSnapshotRef.current=subset;setNativeSnapshot(subset)
          }else if(demandGeneration.current!==generation||queuedLoad.current)return
        }
        const frame=admitted(await bridge.canvasSnapshot({owner:selected.owner,expectedRevision:selected.revision,materialKeys:keys,...(navigationWindow?{navigationWindow}:{})}))
        if(!alive.current || activeRef.current || !sameSource(selected,statusRef.current))return
        // A successful host publication revokes the previous token even if
        // the viewport changed while native preparation was running.
        lastMaterialToken.current=frame.token
        const latestWanted=requestedIndices.current.map(i=>itemsForSnapshot.current[i]?.key)
        if(demandGeneration.current!==generation && (!latestWanted.length||!includesMaterials(keys,latestWanted)))return
        if(frame.materialKeys?.join(',')!==keys.join(',') || frame.roots!==keys.length)throw Error('素材精修范围不匹配')
        nativeSnapshotRef.current=frame;setNativeSnapshot(frame);setWarnings(frame.warnings)
        setNativeRenderStatus({phase:'refining',done:0,total:frame.roots})
      }catch(error){
        if(demandGeneration.current!==generation || queuedLoad.current)return
        if(pageDetailIntent.current===signature)pageDetailIntent.current=undefined
        declinedDemand.current=signature;throw error
      }finally{detailRunning.current=false;preparingKeys.current=[]}
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
  const ensureStatus=async()=>{
    if(statusRef.current)return statusRef.current
    if(admittedOpen.current){updateStatus(admittedOpen.current);return statusRef.current}
    if(!bridge.status)return null
    try{
      const result=await bridge.status()
      if(!alive.current||result.status!=='ok'||statusRef.current)return statusRef.current
      admittedOpen.current=result;openOutcome.current='ok';updateStatus(result);return result
    }catch{return null}
  }
  useEffect(()=>{
    alive.current=true
    if(!started.current){started.current=true;openOutcome.current='pending';void run(async()=>{
      try{
        const result=await openSelectedFile(initialFile)
        if(result.status==='cancelled'){openOutcome.current='cancelled';if(alive.current)onExit();return}
        const next=admitted(result);admittedOpen.current=next;openOutcome.current='ok'
        if(!alive.current)return
        updateStatus(next)
        await openInitialCanvas()
      }catch(error){openOutcome.current='error';throw error}
    },true)}
    return()=>{alive.current=false;queueMicrotask(()=>{if(!alive.current){queuedLoad.current=null;abort.current?.abort();editor.dispose()}})}
  },[])
  useEffect(()=>{
    if(status||busy)return
    let cancel=false
    const recover=async()=>{
      if(admittedOpen.current&&!statusRef.current){updateStatus(admittedOpen.current);setNotice(current=>current===PREPARING_NOTICE?'':current);return}
      if(openOutcome.current!=='error'||!bridge.status||rebindTried.current)return
      rebindTried.current=true
      try{
        const result=await bridge.status()
        if(cancel||!alive.current||statusRef.current||result.status!=='ok')return
        admittedOpen.current=result;openOutcome.current='ok';updateStatus(result)
        setNotice(current=>current===PREPARING_NOTICE?'':current)
        if(!openingRef.current&&result.format==='sketch')setOpeningGeneration(++openingSerial.current)
      }catch{/* A missing status probe leaves the visible error in place. */}
    }
    void recover()
    return()=>{cancel=true}
  },[status,busy,bridge])
  useEffect(()=>{
    // The host admits one source operation at a time. Auto-entry, save and
    // history own that lane; sidebar refresh starts after their receipt.
    if(!status||busy||nativeSnapshot||opening||(status.format==='sketch'&&typeof bridge.canvasSnapshot==='function'))return
    let current=true
    const listedSource=status
    setRows([])
    void bridge.children({...request(),key:parents.at(-1)?.key,offset,limit:100,canvasOnly:true,...(filter?{query:filter}:{})}).then(result=>{if(current&&alive.current&&sameSource(listedSource,statusRef.current)){const value=admitted(result);setRows(value.items);setTotal(value.total)}}).catch(error=>{if(current&&alive.current)setError(String(error))})
    return()=>{current=false}
  },[status,parents,offset,filter,busy,nativeSnapshot,opening?.owner.documentId])
  useEffect(()=>{const timer=setTimeout(()=>{setFilter(query.trim());setOffset(0)},180);return()=>clearTimeout(timer)},[query])
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined
    const schedule=()=>{
      clearTimeout(timer)
      if(!alive.current||!activeRef.current||busyRef.current)return
      if(error){
        // Do not repeatedly retry a rejected snapshot. A corrected edit or
        // undo owns a new attempt without requiring a manual Save action.
        if(rejectedAutosave.current&&editor.authoredDocument!==rejectedAutosave.current){
          rejectedAutosave.current=undefined;setError('')
        }
        return
      }
      if(editor.authoredDocument===baseline.current)return
      timer=setTimeout(()=>{
        if(!alive.current||busyRef.current||editor.authoredDocument===baseline.current)return
        // Drafts and live gestures are never persisted as committed edits.
        // Their release/cancellation publishes another editor/draft event.
        if(hasPendingEdits(editor)||editor.interactionActive||editor.state.busy)return
        const snapshot=editor.authoredDocument
        const writing=run(async()=>{
          try{await save(true);rejectedAutosave.current=undefined}
          catch(error){rejectedAutosave.current=snapshot;throw error}
        });autosave.current=writing
        void writing.finally(()=>{if(autosave.current===writing)autosave.current=undefined})
      },600)
    }
    const off=editor.subscribe(schedule),offDrafts=subscribePendingEdits(editor,schedule)
    schedule()
    return()=>{clearTimeout(timer);off();offDrafts()}
  },[editor,bridge,active,busy,error,state.version])
  useEffect(()=>{const release=registerPendingEdit(parentEditor,{dirty:()=>true,commit:()=>false});pendingEditsChanged(parentEditor);return release},[parentEditor])
  const leave=()=>afterAutosave(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));onExit()},true)
  const exportFile=()=>afterAutosave(async()=>{await save();const result=await bridge.export(request());if(result.status==='cancelled')return;const next=admitted(result);updateStatus(next);setNotice(`完整文件已导出：${next.displayName}`)})
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
    const close=desktop?.onCloseRequested(({requestId})=>{void afterAutosave(async()=>{await save();if(statusRef.current)admitted(await bridge.close(request()));flushSync(onExit);await onWindowClose(requestId)},true).then(()=>{if(alive.current)void desktop.respondToClose({requestId,allow:false})})})
    return()=>{off?.();close?.();window.removeEventListener('keydown',key)}
  },[editor,bridge,onExit,onWindowClose])
  const history=(kind:'undo'|'redo')=>run(async()=>{
    await save();requireCleanCanvas()
    const next=admitted(await bridge[kind](request()))
    requireCleanCanvas();updateStatus(next);invalidateCanvas()
    if(nativeSnapshotRef.current){setOverview(false);await enterOverview()}
  },true)
  const openFile=(file:File)=>afterAutosave(async()=>{
    await save()
    if(statusRef.current)admitted(await bridge.close(request()))
    if(!/\.(json|sketch)$/i.test(file.name)){flushSync(()=>onExit(file));return}
    admittedOpen.current=null;openOutcome.current='pending';rebindTried.current=false
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);itemsForSnapshot.current=[]
    editor.setMutationRestriction(undefined);editor.load(blank(),true);editor.setMutationRestriction('正在准备源文件，暂时只能浏览。');editor.set({tool:'hand',selection:[]})
    openingRef.current=undefined;statusRef.current=null;setStatus(null)
    nativeSnapshotRef.current=null;setNativeSnapshot(null);setCatalogue([]);setOverview(false);setSourcePage('')
    nativePresentedToken.current=undefined
    pageDetailIntent.current=undefined;setFocusedMaterial(undefined);setSelectedMaterialId(undefined);requestDetail([]);pendingMaterial.current=null;fittedOpening.current='';exactView.current=undefined;setShowOpening(true);setOpeningGeneration(++openingSerial.current)
    let next:LargeDocumentStatus
    try{next=admitted(await openSelectedFile(file))}
    catch(error){
      openOutcome.current='error'
      const bound=await ensureStatus()
      if(!bound)throw error
      setError(error instanceof Error?error.message:String(error))
      setNotice(current=>current===PREPARING_NOTICE?'':current)
      if(!openingRef.current&&bound.format==='sketch')setOpeningGeneration(++openingSerial.current)
      return
    }
    if(!alive.current){admittedOpen.current=next;return}
    baseline.current=null;activeRef.current=null;setActive(null);setPageRange(null);nativeSnapshotRef.current=null;setNativeSnapshot(null);setCatalogue([]);setOverview(false);admittedOpen.current=next;openOutcome.current='ok';updateStatus(next)
    await openInitialCanvas()
  },true)
  const allPages=()=>{setParents([]);setOffset(0);setFilter('');setQuery('')}
  const openMaterial=(item:SourceCanvasItem,afterLoad?:(id:string)=>void)=>requestLoad({...item,part:item.pageName,hasChildren:true,catalogueMaterial:true,afterLoad})
  const materialRows=catalogue.length?catalogue:(opening?.items??[])
  const pages=useMemo(()=>{
    if(opening?.pages)return opening.pages
    const groups=new Map<string,[string,string,number]>()
    for(const row of materialRows){const page=groups.get(row.pageId);if(page)page[2]++;else groups.set(row.pageId,[row.pageId,row.pageName,1])}
    return [...groups.values()]
  },[opening?.pages,materialRows])
  const pageBoxes=useMemo(()=>sourcePage?materialRows.filter(row=>row.pageId===sourcePage).map(row=>row.placed):undefined,[materialRows,sourcePage])
  const navigate=(pageId:string,item?:SourceCanvasItem)=>{
    const host=canvas.current;if(!host)return
    navigationIntent.current++;pageDetailIntent.current=undefined;pendingMaterial.current=null;queuedLoad.current=null;setSourcePage(pageId)
    if(preparingSource.current){abort.current?.abort();void bridge.cancel().catch(()=>{})}
    const index=item?materialRows.indexOf(item):-1
    setSelectedMaterialId(item?.id);setFocusedMaterial(index>=0?index:undefined);requestDetail(index>=0?[index]:[])
    quick.focus(pageId||undefined,index>=0?index:undefined,!statusRef.current)
    const group=pageId?materialRows.filter(row=>row.pageId===pageId):materialRows
    const box=item?.placed??(group.length?unionBounds(group.map(row=>row.placed)):undefined)
    if(box){
      const view=fitBounds(box,{width:host.clientWidth,height:host.clientHeight}), exact=exactView.current
      if(opening&&(!exact||exact.zoom!==view.zoom||exact.x!==view.x||exact.y!==view.y))setShowOpening(true)
      editor.set({view})
    }
  }
  const editMaterial=(row:SourceCanvasItem,afterLoad?:(id:string)=>void)=>{
    const exact=itemsForSnapshot.current.find(item=>item.id===row.id&&item.pageId===row.pageId)
    if(exact&&statusRef.current){openMaterial(exact,afterLoad);return}
    pendingMaterial.current={id:row.id,pageId:row.pageId,afterLoad}
    setNotice(PREPARING_NOTICE)
    void (async()=>{
      if(!statusRef.current){
        const bound=await ensureStatus()
        if(!alive.current)return
        if(!bound){pendingMaterial.current=null;setNotice('');setError('源文件尚未绑定，原始图层无法准备。');return}
      }
      const ready=itemsForSnapshot.current.find(item=>item.id===row.id&&item.pageId===row.pageId)
      if(ready&&statusRef.current){pendingMaterial.current=null;setNotice('');openMaterial(ready,afterLoad);return}
      await run(()=>enterOverview(),true)
    })()
  }
  const materialIndex=useMemo(()=>new SpatialIndex(materialRows.filter(row=>!sourcePage||row.pageId===sourcePage)
    .map(row=>({id:row.key,bounds:row.placed,row}))),[materialRows,sourcePage])
  const pickMaterial=useCallback((point:Point)=>materialIndex.query({...point,width:0,height:0}).at(-1)?.row,[materialIndex])
  const openPreviewPoint=(point:Point)=>{
    const item=pickMaterial(point)
    if(item)editMaterial(item)
  }
  const chosenMaterial=materialRows.find(item=>item.id===selectedMaterialId && (!sourcePage||item.pageId===sourcePage))
  const prepareExport=(open:()=>void)=>{
    if(!active && (opening || overview)){
      if(!chosenMaterial){setError('请先在画布或左侧列表中点选要导出的素材。');return}
      editMaterial(chosenMaterial,id=>{editor.select([id]);open()})
      return
    }
    if(active && !editor.state.selection.length && editor.state.doc.nodes[active.id])editor.select([active.id])
    open()
  }
  const exportSelectedSketch=async():Promise<string|undefined>=>{
    const row=activeRef.current,source=statusRef.current
    if(!source||source.format!=='sketch'||!row||busyRef.current)throw Error('请先打开要导出的 Sketch 图层')
    if(!commitPendingEdits(editor)||editor.interactionActive)throw Error('请先完成当前编辑')
    const ids=editor.topSelection(),doc=editor.authoredDocument,epoch=editor.sessionGeneration
    if(!ids.length)throw Error('请选择要导出的图层或画板')
    const pageId=row.kind==='page'?row.id:row.pageId
    if(!pageId)throw Error('无法确定所选图层的源页面')
    const name=ids.length===1?doc.nodes[ids[0]].name:'选区'
    busyRef.current=true;setBusy(true)
    try{
      await save()
      const selected=editor.topSelection()
      if(editor.authoredDocument!==doc || editor.sessionGeneration!==epoch || activeRef.current?.id!==row.id ||
          !ids.every((id,i)=>selected[i]===id) || selected.length!==ids.length)throw Error('选区已改变，请重新导出')
      const result=await bridge.export({...request(),selection:{pageId,nodeIds:ids},selectionName:name})
      if(result.status==='cancelled')return
      const exported=admitted(result);setNotice(`选区已导出：${exported.displayName}`);return exported.displayName
    }finally{busyRef.current=false;if(alive.current)setBusy(false)}
  }
  const scopedBoxes=useMemo(()=>{
    const keys=nativeSnapshot?.materialKeys
    if(!keys)return pageBoxes
    // A retained neighbour can supply a later visit. Only the currently
    // requested roots overlay the corresponding catalogue thumbnails.
    const wanted=new Set(detailIndices.map(i=>catalogue[i]?.key))
    const selected=new Set(keys.filter(key=>wanted.has(key)))
    return catalogue.flatMap((row,i)=>selected.has(row.key)&&(!sourcePage||row.pageId===sourcePage)
      ? [{...row.placed,materialKey:row.key,previewScale:thumbnailScale(opening?.images.get(i),row.placed)}] : [])
  },[catalogue,nativeSnapshot?.materialKeys,pageBoxes,sourcePage,detailIndices,opening?.images])
  const browsing=overview||!!opening&&!active
  const nativeNavigation=<section className="source-board-navigation" data-preview-cache={opening?.cacheHit} data-thumbnail-renders={opening?.rendered} data-detail-roots={nativeSnapshot?.roots??0} data-preview-count={opening?.images.size} data-preview-complete={!!opening && opening.finished && opening.images.size===opening.items.length} data-active-source-page={sourcePage} data-listing="true" data-has-canvas={!overview} aria-label="完整画板素材">
    <div className="source-pages-heading"><Frame size={15}/><span>完整画板</span><small>{materialRows.length} 个素材</small></div>
    {browsing&&<label className="source-page-picker">页面 <select aria-label="素材页面" value={sourcePage} onChange={e=>{setQuery('');navigate(e.target.value)}}>
      <option value="">全部页面</option>{pages.map(([id,name,count])=><option key={id} value={id}>{name}（{count}）</option>)}</select></label>}
    {browsing&&opening&&(!nativeSnapshot||nativeSnapshot.materialKeys)&&<>
      {sourcePage&&pageBoxes&&pageBoxes.length>0&&pageBoxes.length<=32&&<button className="source-overview-back" disabled={busy||!status}
        onClick={()=>{
          const indices=materialRows.flatMap((item,i)=>item.pageId===sourcePage?[i]:[])
          pageDetailIntent.current=indices.join(',')
          requestDetail(indices,true)
        }}>精修当前页</button>}
      <button className="source-overview-back" disabled={busy} onClick={()=>void run(async()=>{if(!statusRef.current){const bound=await ensureStatus();if(!bound)throw Error('源文件尚未打开')};setNotice(current=>current===PREPARING_NOTICE?'':current);await enterOverview(true)},true)}>精修完整画板</button>
    </>}
    {!browsing&&<button className="source-overview-back" disabled={busy} onClick={()=>void run(enterOverview,true)}><ArrowLeft size={14}/>返回完整画板</button>}
    <form className="layer-search source-search" onSubmit={event=>event.preventDefault()}><Search size={13}/><input aria-label="搜索素材" placeholder="搜索素材…" value={query} onChange={event=>setQuery(event.target.value)}/></form>
    <div className="source-workspace-rows" role="list" aria-label="全部素材">{materialRows.filter(item=>(!sourcePage||item.pageId===sourcePage)&&`${item.name} ${item.pageName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item=><div className="source-page-row" data-active={browsing?selectedMaterialId===item.id:active?.id===item.id} role="listitem" key={item.key}>
      <button className="source-page-entry" data-source-material-id={item.id} disabled={busy&&!browsing} title={`${item.pageName} · ${item.name}；双击编辑`} onClick={event=>{if(browsing)navigate(sourcePage,item);else if(event.detail<2)editMaterial(item)}} onDoubleClick={()=>{if(browsing)editMaterial(item)}}><span className="source-row-icon"><Frame size={14}/></span><span className="source-row-copy"><span className="source-row-name">{item.name}</span><small className="source-row-page">{item.pageName}</small></span></button>
    </div>)}</div>
    <footer className="source-history"><span>完整源文件保留全部内容</span><button aria-label="撤销已保存修改" disabled={busy||!status?.undoCount} onClick={()=>void history('undo')}><Undo2 size={14}/></button><button aria-label="重做已保存修改" disabled={busy||!status?.redoCount} onClick={()=>void history('redo')}><Redo2 size={14}/></button></footer>
  </section>
  const navigation=nativeSnapshot||opening||active&&catalogue.length?nativeNavigation:<section className="source-board-navigation" data-listing={viewTab==='source'} data-has-canvas={!!active} aria-label="源文件页面">
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
  const earlyDisplay=!active && !nativeSnapshot && focusedMaterial!==undefined &&
    opening?.materialDisplay?.openingMaterial===focusedMaterial && opening.materialDisplay.token!==failedOpeningToken ? opening.materialDisplay : undefined
  const neededKeys=detailIndices.map(i=>itemsForSnapshot.current[i]?.key)
  const knownKeys=nativeSnapshot?.materialKeys
  const shared=!!knownKeys&&neededKeys.some(key=>knownKeys.includes(key))
  const missingScope=!!knownKeys&&neededKeys.length>0&&
    !(nativeSnapshot?.viewportSubset?shared:includesMaterials(knownKeys,neededKeys))
  return renderWorkbench({editor,ready:!!active||overview||!!opening,busy,locked:editorLocked,dirty:!!active&&editor.authoredDocument!==baseline.current,
    name:status?.name||initialFile?.name||'正在打开文件',notice:opening&&busy&&!active?`${pages.length} 页，素材预览 ${opening.images.size}/${materialRows.length}。可切页、平移和缩放，原始图层正在后台准备。`:notice,error,canvas,navigation,showLayers:!!active&&!overview,warnings,
    prepareExport,exportSelectedSketch:status?.format==='sketch'?exportSelectedSketch:undefined,
    selectMaterialAt:browsing?point=>setSelectedMaterialId(pickMaterial(point)?.id):undefined,
    selectedMaterialBox:browsing?chosenMaterial?.placed:undefined,
    pickMaterial:browsing?pickMaterial:undefined,
    navigatingMaterials:overview&&!!opening&&!!nativePresentedToken.current&&viewportDemand.current&&(!busy||detailRunning.current),
    prepareSourceDisplay:!active&&openingGeneration!==undefined&&/\.sketch$/i.test(initialFile?.name??''),
    openingPreview:!active?opening:undefined,openingPage:sourcePage||undefined,focusedMaterial,onDetail:requestViewportDetail,onViewport:(box,anchor,density)=>{zoomAnchor.current=anchor;quick.setViewport(box,density,anchor)},hideNative:!!opening&&(showOpening||missingScope&&!shared),
    parkNative:!!opening&&!!nativeSnapshot?.materialKeys&&(!detailIndices.length||missingScope||nativeSnapshot.token!==lastMaterialToken.current),pageBoxes:!active?scopedBoxes:undefined,openPreviewPoint,
    onSourcePresented:view=>{
      const v=editor.effectiveView(),keys=nativeSnapshotRef.current?.materialKeys
      const wanted=detailIndices.map(i=>itemsForSnapshot.current[i]?.key)
      const matches=!keys||wanted.length>0&&(nativeSnapshotRef.current?.viewportSubset?
        viewportDemand.current&&wanted.some(key=>keys.includes(key)):includesMaterials(keys,wanted))
      if(matches&&Math.abs(view.x-v.x)<0.5&&Math.abs(view.y-v.y)<0.5&&Math.abs(view.zoom-v.zoom)<0.0005)setShowOpening(false)
    },
    nativeCanvas:overview&&nativeSnapshot?{snapshot:nativeSnapshot,status:nativeRenderStatus,onStatus:status=>{
      // Quality follows every current-camera receipt, including after this
      // snapshot's first ready frame. Only onSourcePresented releases preview.
      setNativeRenderStatus(status)
      if(nativeRenderError.current&&status.phase==='ready'){nativeRenderError.current=false;setError('')}
      if(status.phase==='error')nativeRenderError.current=true
      if(nativePresentedToken.current===nativeSnapshot.token&&status.phase!=='error')return
      if(status.phase==='ready')nativePresentedToken.current=nativeSnapshot.token
      if(status.phase==='error')setError(status.error??'画板绘制未完成')
      else if(status.phase==='ready')setNotice(nativeSnapshot.materialKeys?`当前视口已精修。`:`完整画板已显示：${nativeSnapshot.roots} 个素材。双击素材进入编辑。`)
      else setNotice(status.phase==='loading'?'正在准备完整画板显示…':`正在绘制完整画板 ${status.done} / ${status.total}…`)
    },openPoint:point=>{if(busyRef.current)return;const item=pickMaterial(point);if(item)openMaterial(item)}}:earlyDisplay?{
      snapshot:earlyDisplay,
      onStatus:status=>{if(status.phase==='error'){setFailedOpeningToken(earlyDisplay.token);setShowOpening(true)}},
      openPoint:openPreviewPoint,
    }:undefined,
    dismissWarnings:()=>setWarnings([]),dismissError:()=>setError(''),cancel:()=>{abort.current?.abort();void bridge.cancel().catch(error=>setError(String(error)))},
    save:()=>run(save),exportFile,leave,openFile})
}
