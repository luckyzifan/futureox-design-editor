import { utilityAction, runUtilityAction, ActionSource, CanvasAction, ActionReason, type UtilityAction } from './canvas-utility-action'
import {useEffect,useMemo,useRef,useState} from 'react'
import type {SceneEntry} from './geometry'
import type {Editor} from './engine'
import type {CanvasCamera,CanvasSize} from './canvas-camera'
import {screenToWorld} from './canvas-camera'
import {uid,type RulerGuide} from './model'
import {guideOwner,guidePosition,worldGuides,type WorldGuide} from './ruler-guides'
import {NumberField} from './fields'
import {useProfessionalDialogText} from './professional-dialog-messages'
import { ActionContextMenu } from './ActionContextMenu'
import { useInterfacePreferences } from './interface-preference'
import { commitPendingEdits } from './pending-edits'

export type GuideMeasureHit = { owner: string; id: string; axis: 'x' | 'y' | null; position: number; label: number; at: { x: number; y: number } }
export type GuideMeasureState = { selected: GuideMeasureHit | null; hover: GuideMeasureHit | null }
function guideAxis(guide: WorldGuide): { axis: 'x' | 'y'; position: number } | null {
  const dx = guide.to.x - guide.from.x, dy = guide.to.y - guide.from.y
  if (Math.abs(dx) <= 1e-6 && Math.abs(dy) > 1e-6) return { axis: 'x', position: guide.from.x }
  if (Math.abs(dy) <= 1e-6 && Math.abs(dx) > 1e-6) return { axis: 'y', position: guide.from.y }
  return null
}
export function CanvasGuides({editor,view,size,entries,intercept,guidesHidden=false,onGuideMeasure}:{editor:Editor;view:CanvasCamera;size:CanvasSize;entries?:readonly SceneEntry[];intercept:(e:React.PointerEvent)=>boolean;guidesHidden?:boolean;onGuideMeasure?:(state:GuideMeasureState)=>void}){
  const {tr}=useProfessionalDialogText()
  const {uiMode}=useInterfacePreferences()
  const host=useRef<HTMLDivElement>(null),[selected,setSelected]=useState<{owner:string;id:string}|null>(null)
  const [rulerMenu,setRulerMenu]=useState<{axis:'x'|'y';x:number;y:number;page:string;session:number}|null>(null)
  const [hoverGuide,setHoverGuide]=useState<GuideMeasureHit|null>(null)
  const active=useRef<{action:UtilityAction;pointer:number;session:number;page:string;owner:string;id:string;axis:'x'|'y';view:CanvasCamera;created:boolean;start:{x:number;y:number};moved:boolean}|null>(null)
  const doc=editor.state.doc,page=editor.state.page,shown=!!editor.state.rulers
  const guides = useMemo(() => shown && !guidesHidden ? worldGuides(doc,page,entries) : [], [shown,guidesHidden,doc,page,entries])
  const selectedGuide=selected&&guideOwner(doc,selected.owner)?.guides?.find(g=>g.id===selected.id)
  const cancel=()=>{const d=active.current;active.current=null;if(d?.session===editor.sessionGeneration&&d.page===editor.state.page)editor.cancel();d?.action.cancel()}
  useEffect(()=>{cancel();setSelected(null)},[editor.sessionGeneration,page,shown])
  useEffect(()=>setRulerMenu(null),[editor.sessionGeneration,page,shown,guidesHidden,uiMode])
  useEffect(()=>{if(!shown||guidesHidden)setHoverGuide(null)},[shown,guidesHidden])
  useEffect(()=>{
    if(!onGuideMeasure)return
    const selectedHit=selected&&selectedGuide?(()=>{const world=guides.find(g=>g.owner===selected.owner&&g.guide.id===selected.id);const axis=world&&guideAxis(world);return {owner:selected.owner,id:selected.id,axis:axis?.axis??null,position:axis?.position??selectedGuide.position,label:selectedGuide.position,at:{x:0,y:0}}})():null
    onGuideMeasure({selected:shown&&!guidesHidden?selectedHit:null,hover:shown&&!guidesHidden?hoverGuide:null})
  },[onGuideMeasure,selected,selectedGuide,hoverGuide,guides,shown,guidesHidden])
  useEffect(()=>{
    const down=(e:PointerEvent)=>{if(!host.current?.contains(e.target as Node))setSelected(null)}
    const key=(e:KeyboardEvent)=>{
      if(!selected||!shown||guidesHidden||(e.target as Element)?.closest('input,textarea,[contenteditable]'))return
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();setSelected(null)}
      if(['Delete','Backspace'].includes(e.key)&&!active.current){e.preventDefault();e.stopImmediatePropagation();runUtilityAction(editor,CanvasAction.guide,ActionSource.keyboard,()=>editor.change('删除参考线',d=>{const owner=guideOwner(d,selected.owner);if(owner)owner.guides=owner.guides?.filter(g=>g.id!==selected.id)}));setSelected(null)}
    }
    window.addEventListener('keydown',key,true);window.addEventListener('pointerdown',down,true);window.addEventListener('blur',cancel)
    return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('pointerdown',down,true);window.removeEventListener('blur',cancel)}
  },[editor,selected,shown,guidesHidden])
  if(!shown)return null
  const location=(e:{clientX:number;clientY:number},camera=view)=>{const b=host.current!.getBoundingClientRect();return screenToWorld(camera,{x:e.clientX-b.left,y:e.clientY-b.top})}
  const start=(e:React.PointerEvent,axis:'x'|'y',owner:string,existing?:RulerGuide)=>{
    if(guidesHidden)return
    e.stopPropagation();if(existing&&intercept(e))return
    const action=utilityAction(editor,CanvasAction.guide)
    if(e.button!==0||editor.state.busy||editor.interactionActive||editor.state.tool!=='select'){action.block(ActionReason.busy);return}
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);host.current?.focus({preventScroll:true})
    const id=existing&&!e.altKey?existing.id:uid();editor.begin(existing?(e.altKey?'复制参考线':'移动参考线'):'添加参考线')
    if(!existing||e.altKey)editor.change('添加参考线',d=>{const target=guideOwner(d,owner);if(!target)throw Error('参考线容器已移除');(target.guides??=[]).push({id,axis,position:existing?.position??guidePosition(d,owner,axis,location(e))})})
    active.current={action,pointer:e.pointerId,session:editor.sessionGeneration,page:editor.state.page,owner,id,axis,view:{...view},created:!existing||e.altKey,start:{x:e.clientX,y:e.clientY},moved:false};setSelected({owner,id})
  }
  const move=(e:React.PointerEvent)=>{
    e.stopPropagation();const a=active.current;if(!a||a.pointer!==e.pointerId||a.session!==editor.sessionGeneration||a.page!==editor.state.page)return
    a.action.sample({snapEnabled:!e.ctrlKey})
    a.moved ||= e.clientX!==a.start.x||e.clientY!==a.start.y
    if(!a.moved)return
    let position=guidePosition(editor.state.doc,a.owner,a.axis,location(e,a.view));const proposed=position;if(!e.ctrlKey)position=Math.round(position);a.action.sample({snapChanged:position!==proposed,intentResolvedComparison:position===proposed?1:2})
    if(!Number.isFinite(position)||Math.abs(position)>1e7)return
    editor.change('移动参考线',d=>{const guide=guideOwner(d,a.owner)?.guides?.find(g=>g.id===a.id);if(guide)guide.position=position})
  }
  const end=(e:React.PointerEvent)=>{
    const a=active.current;if(!a||a.pointer!==e.pointerId)return;move(e);active.current=null
    const b=host.current!.getBoundingClientRect(),inside=e.clientX-b.left>=20&&e.clientY-b.top>=20&&e.clientX<b.right&&e.clientY<b.bottom
    if(!inside&&a.created){editor.cancel();a.action.cancel();setSelected(null);return}
    if(!inside)editor.change('移除参考线',d=>{const target=guideOwner(d,a.owner);if(target)target.guides=target.guides?.filter(g=>g.id!==a.id)} )
    const resolved=guideOwner(editor.state.doc,a.owner)?.guides?.find(g=>g.id===a.id)?.position;editor.commit();const committed=guideOwner(editor.state.doc,a.owner)?.guides?.find(g=>g.id===a.id)?.position;a.action.finish(false,{motionObserved:a.moved,resolvedCommittedComparison:resolved===committed?1:2});if(!inside)setSelected(null)
  }
  const removeAxisGuides=()=>{
    const menu=rulerMenu
    setRulerMenu(null)
    if(!menu) return
    const current=()=>editor.sessionGeneration===menu.session && editor.state.page===menu.page &&
      !!editor.state.rulers && !editor.state.busy && !editor.interactionActive
    if(!current() || !commitPendingEdits(editor) || !current()) return
    const {axis}=menu
    const owners=[...new Set(worldGuides(editor.state.doc,menu.page).filter(g=>g.editable&&g.guide.axis===axis).map(g=>g.owner))]
    if(!owners.length)return
    runUtilityAction(editor,CanvasAction.guide,ActionSource.menu,()=>editor.change(axis==='x'?'移除全部纵向参考线':'移除全部横向参考线',d=>{
      for(const owner of owners){const target=guideOwner(d,owner);if(target)target.guides=target.guides?.filter(g=>g.axis!==axis)}
    }))
  }
  const openRulerMenu=(e:React.MouseEvent,axis:'x'|'y')=>{
    if(uiMode!=='sketch'||guidesHidden||e.button!==2||editor.state.busy||editor.interactionActive)return
    e.preventDefault();e.stopPropagation();setSelected(null)
    setRulerMenu({axis,x:e.clientX,y:e.clientY,page,session:editor.sessionGeneration})
  }
  const selectedFrame=editor.topSelection().length===1?doc.nodes[editor.topSelection()[0]]:null
  const owner=selectedFrame&&['frame','section'].includes(selectedFrame.kind)&&!selectedFrame.instance&&!selectedFrame.instanceOrigin&&!selectedFrame.locked?selectedFrame.id:page
  const targetStep=80/view.zoom,baseStep=10**Math.floor(Math.log10(targetStep)),tickStep=([1,2,5,10].find(v=>v*baseStep>=targetStep)||10)*baseStep,ticks=(axis:'x'|'y')=>{
    const offset=axis==='x'?view.x:view.y,length=axis==='x'?size.width:size.height,start=Math.floor(-offset/view.zoom/tickStep)
    return Array.from({length:Math.min(200,Math.ceil(length/view.zoom/tickStep)+2)},(_,i)=>{const value=(start+i)*tickStep;return{value,at:value*view.zoom+offset}})
  }
  return <div ref={host} tabIndex={-1} className="canvas-guide-layer" onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={()=>{if(active.current)cancel()}}>
    <svg className="ruler-guide-lines" width={size.width} height={size.height}>
      {guides.map(g=>{const a=g.page?(g.guide.axis==='x'?{x:g.from.x,y:-view.y/view.zoom}:{x:-view.x/view.zoom,y:g.from.y}):g.from,b=g.page?(g.guide.axis==='x'?{x:g.to.x,y:(size.height-view.y)/view.zoom}:{x:(size.width-view.x)/view.zoom,y:g.to.y}):g.to
        const key=g.owner+'/'+g.guide.id,isSelected=selected?.owner===g.owner&&selected.id===g.guide.id
        return <g key={key} data-testid="ruler-guide" data-owner-id={g.owner} data-guide-id={g.guide.id} onContextMenu={e=>{e.preventDefault();e.stopPropagation();if(g.editable){setSelected({owner:g.owner,id:g.guide.id});host.current?.focus()}}}>
          <line x1={a.x*view.zoom+view.x} y1={a.y*view.zoom+view.y} x2={b.x*view.zoom+view.x} y2={b.y*view.zoom+view.y} stroke={isSelected?'#0d99ff':'#f24822'} strokeWidth={1}/>
          <line x1={a.x*view.zoom+view.x} y1={a.y*view.zoom+view.y} x2={b.x*view.zoom+view.x} y2={b.y*view.zoom+view.y} stroke="transparent" strokeWidth={8} pointerEvents={g.editable&&editor.state.tool==='select'?'stroke':'none'} style={{cursor:g.guide.axis==='x'?'ew-resize':'ns-resize'}} onPointerDown={e=>start(e,g.guide.axis,g.owner,g.guide)} onDoubleClick={e=>e.stopPropagation()} onPointerEnter={e=>{const axis=guideAxis(g);setHoverGuide({owner:g.owner,id:g.guide.id,axis:axis?.axis??null,position:axis?.position??g.guide.position,label:g.guide.position,at:location(e)})}} onPointerLeave={()=>setHoverGuide(current=>current?.owner===g.owner&&current.id===g.guide.id?null:current)} onPointerMove={e=>{if(active.current)return;const at=location(e);setHoverGuide(current=>{if(!current||current.owner!==g.owner||current.id!==g.guide.id)return current;if(Math.abs(current.at.x-at.x)<0.5&&Math.abs(current.at.y-at.y)<0.5)return current;return{...current,at}})}}/>
        </g>})}
    </svg>
    <div className="canvas-ruler horizontal" data-testid="horizontal-ruler" onPointerDown={e=>start(e,'y',owner)} onContextMenu={e=>openRulerMenu(e,'y')}>{ticks('x').map(t=><span key={t.value} style={{left:t.at}}>{Number(t.value.toFixed(4))}</span>)}</div>
    <div className="canvas-ruler vertical" data-testid="vertical-ruler" onPointerDown={e=>start(e,'x',owner)} onContextMenu={e=>openRulerMenu(e,'x')}>{ticks('y').map(t=><span key={t.value} style={{top:t.at}}>{Number(t.value.toFixed(4))}</span>)}</div>
    <div className="ruler-origin"/>
    {rulerMenu&&(() => {
      const axis=rulerMenu.axis,count=guides.filter(g=>g.editable&&g.guide.axis===axis).length
      return <ActionContextMenu className="guide-ruler-menu" label={tr(axis==='x'?'纵向标尺操作':'横向标尺操作')}
        point={rulerMenu} returnFocus={host.current} onClose={()=>setRulerMenu(null)}>
        <button type="button" role="menuitem" disabled={!count} onClick={removeAxisGuides}>{tr(axis==='x'?'移除全部纵向参考线':'移除全部横向参考线')}{count?`（${count}）`:''}</button>
      </ActionContextMenu>
    })()}
    {!guidesHidden&&selected&&selectedGuide&&<div className="guide-properties" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
      <span>{tr(selected.owner===page?'页面参考线':'画板参考线')}</span>
      <NumberField label="参考线位置" value={selectedGuide.position} onChange={position=>runUtilityAction(editor,CanvasAction.guide,ActionSource.properties,()=>editor.change('设置参考线位置',d=>{const g=guideOwner(d,selected.owner)?.guides?.find(g=>g.id===selected.id);if(g)g.position=position}))}/>
      <button onClick={()=>{runUtilityAction(editor,CanvasAction.guide,ActionSource.properties,()=>editor.change('删除参考线',d=>{const o=guideOwner(d,selected.owner);if(o)o.guides=o.guides?.filter(g=>g.id!==selected.id)}));setSelected(null)}}>{tr('删除')}</button>
    </div>}
  </div>
}
