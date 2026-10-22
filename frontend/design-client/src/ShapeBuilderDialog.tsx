import { useProfessionalDialogText, shapeRegionLabel, shapeSelectionSummary } from './professional-dialog-messages'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { bounds, networkD } from './geometry'
import { applyShapeBuilder, previewShapeBuilder, type ShapeBuilderMode } from './shape-builder'
import { shapeBuilderSegmentRegions } from './shape-builder-picking'
import type { Point } from './model'
import { hasPendingEdits } from './pending-edits'
import { modalKeyDown } from './modal-keyboard'
import './shape-builder.css'

/** Shared Web/Electron host. Hover and drag act on connected curve regions,
 * not on whole operands. The source document is untouched until Apply. */
export function ShapeBuilderDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { tr, locale } = useProfessionalDialogText()
  const snapshot = useRef({ doc: editor.state.doc, page: editor.state.page, session: editor.sessionGeneration })
  const preview = useMemo(() => { try { return { value:previewShapeBuilder(snapshot.current.doc,editor.state.selection),error:'' } } catch(e) { return { value:null,error:String(e instanceof Error?e.message:e) } } },[editor])
  const [selected,setSelected]=useState<string[]>([]), [hover,setHover]=useState<string|null>(null), [error,setError]=useState('')
  const [mode,setMode]=useState<ShapeBuilderMode>('merge'), dragging=useRef(false), dialog=useRef<HTMLElement>(null), svg=useRef<SVGSVGElement>(null), lastPointer=useRef<Point|null>(null)
  useLayoutEffect(() => {
    const previous=document.activeElement as HTMLElement|null
    const background=Array.from(document.body.children).filter(e=>!e.contains(dialog.current)).map(e=>({e,inert:e.getAttribute('inert')}))
    background.forEach(({e})=>e.setAttribute('inert',''))
    const retain=(e:FocusEvent)=>{if(e.target instanceof Node&&!dialog.current?.contains(e.target))dialog.current?.focus()}
    document.addEventListener('focusin',retain); dialog.current?.focus()
    return ()=>{document.removeEventListener('focusin',retain);background.forEach(({e,inert})=>{if(inert===null)e.removeAttribute('inert');else e.setAttribute('inert',inert)});if(previous?.isConnected)previous.focus()}
  },[])
  const regionBounds=preview.value ? bounds(preview.value.regions.flatMap(r=>[...r.network.vertices,...r.network.edges.flatMap(e=>[e.c1,e.c2].filter((p):p is NonNullable<typeof p>=>!!p))])) : {x:0,y:0,width:100,height:100}
  const padding=Math.max(regionBounds.width,regionBounds.height)*.05 || 1
  const pointerPoint=(e:{clientX:number;clientY:number}):Point|null=>{
    const matrix=svg.current?.getScreenCTM?.()
    if(matrix){const inverse=matrix.inverse();return {x:inverse.a*e.clientX+inverse.c*e.clientY+inverse.e,y:inverse.b*e.clientX+inverse.d*e.clientY+inverse.f}}
    const box=svg.current?.getBoundingClientRect();if(!box||box.width<=0||box.height<=0)return null
    const width=regionBounds.width+padding*2,height=regionBounds.height+padding*2,scale=Math.min(box.width/width,box.height/height)
    return {x:regionBounds.x-padding+(e.clientX-box.left-(box.width-width*scale)/2)/scale,y:regionBounds.y-padding+(e.clientY-box.top-(box.height-height*scale)/2)/scale}
  }
  const sweep=(e:{clientX:number;clientY:number})=>{
    const point=pointerPoint(e);if(!point||!preview.value)return
    try { const hit=shapeBuilderSegmentRegions(preview.value.regions,lastPointer.current||point,point);setSelected(ids=>[...new Set([...ids,...hit])]);lastPointer.current=point }
    catch(e){dragging.current=false;lastPointer.current=null;setError(e instanceof Error?e.message:String(e))}
  }
  const finish=()=>{dragging.current=false;lastPointer.current=null}
  const commit=()=>{
    if(!preview.value)return
    if(editor.interactionActive || editor.state.busy || hasPendingEdits(editor)) {setError('请先结束当前编辑再应用形状构建');return}
    if(editor.state.doc!==snapshot.current.doc || editor.state.page!==snapshot.current.page || editor.sessionGeneration!==snapshot.current.session) {setError('文档已变化，请关闭后重新打开');return}
    const created:string[]=[]
    const result=editor.change(mode==='merge'?'形状构建：合并区域':'形状构建：删除区域',draft=>{created.push(...applyShapeBuilder(draft,preview.value!,selected,mode))},created)
    if(result.status==='committed')onClose();else setError(result.status==='rejected'?result.message:'请先结束当前编辑')
  }
  return createPortal(<div className="shape-builder-backdrop" onPointerDown={e=>{e.stopPropagation();if(e.target===e.currentTarget)onClose()}} onPointerUp={finish}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="shape-builder-title" className="shape-builder-dialog" onKeyDown={e=>modalKeyDown(e,onClose)}>
      <header><h2 id="shape-builder-title">{tr('形状构建器')}</h2><button aria-label={tr('关闭形状构建器')} onClick={onClose}>×</button></header>
      <p>{tr('拖过要合并的区域，或按住 Alt / Option 拖选要删除的区域。应用时可一次撤销。')}</p>
      <svg ref={svg} role="group" aria-label={tr('可选择的形状区域')} viewBox={`${regionBounds.x-padding} ${regionBounds.y-padding} ${regionBounds.width+2*padding} ${regionBounds.height+2*padding}`}
        onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();dragging.current=true;lastPointer.current=null;setMode(e.altKey?'erase':'merge');svg.current?.setPointerCapture?.(e.pointerId);sweep(e)}}
        onPointerMove={e=>{if(dragging.current){const samples=e.nativeEvent.getCoalescedEvents?.()||[];for(const sample of samples)sweep(sample);if(dragging.current)sweep(e)}}}
        onPointerUp={e=>{if(dragging.current)sweep(e);finish();if(svg.current?.hasPointerCapture?.(e.pointerId))svg.current.releasePointerCapture(e.pointerId)}}
        onPointerCancel={finish} onLostPointerCapture={finish} onPointerLeave={()=>setHover(null)}>
        {preview.value?.regions.map(r=><path key={r.id} data-region-id={r.id} role="button" tabIndex={0} aria-label={shapeRegionLabel(r.id,locale)} aria-pressed={selected.includes(r.id)} d={networkD(r.network)} fillRule="evenodd"
          fill={selected.includes(r.id)?(mode==='erase'?'#fda4af':'#93c5fd'):hover===r.id?'#c4b5fd':'#e2e8f0'} stroke="#475569" strokeWidth={1} vectorEffect="non-scaling-stroke"
          onPointerEnter={()=>setHover(r.id)} onFocus={()=>setHover(r.id)}
          onKeyDown={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();e.stopPropagation();setSelected(ids=>ids.includes(r.id)?ids.filter(id=>id!==r.id):[...ids,r.id])}}} />)}
      </svg>
      <p role="status">{shapeSelectionSummary(selected.length,preview.value?.regions.length || 0,locale)}</p>
      {(preview.error||error)&&<p role="alert">{tr(preview.error||error)}</p>}
      <footer><button onClick={()=>setSelected([])}>{tr('清除选择')}</button><label>{tr('操作')} <select value={mode} onChange={e=>setMode(e.target.value as ShapeBuilderMode)}><option value="merge">{tr('合并所选区域')}</option><option value="erase">{tr('删除所选区域')}</option></select></label><button onClick={onClose}>{tr('取消')}</button><button disabled={!selected.length||!preview.value} onClick={commit}>{tr('应用')}</button></footer>
    </section>
  </div>,document.body)
}
