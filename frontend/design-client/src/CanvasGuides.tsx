import {useEffect,useRef,useState} from 'react'
import type {Editor} from './engine'
import type {CanvasCamera,CanvasSize} from './canvas-camera'
import {screenToWorld} from './canvas-camera'
import {uid,type RulerGuide} from './model'
import {guideOwner,guidePosition,worldGuides} from './ruler-guides'
import {NumberField} from './fields'

export function CanvasGuides({editor,view,size,intercept}:{editor:Editor;view:CanvasCamera;size:CanvasSize;intercept:(e:React.PointerEvent)=>boolean}){
  const host=useRef<HTMLDivElement>(null),[selected,setSelected]=useState<{owner:string;id:string}|null>(null)
  const active=useRef<{pointer:number;session:number;page:string;owner:string;id:string;axis:'x'|'y';view:CanvasCamera;created:boolean;start:{x:number;y:number};moved:boolean}|null>(null)
  const doc=editor.state.doc,page=editor.state.page,shown=!!editor.state.rulers
  const guides=shown?worldGuides(doc,page):[]
  const selectedGuide=selected&&guideOwner(doc,selected.owner)?.guides?.find(g=>g.id===selected.id)
  const cancel=()=>{const d=active.current;active.current=null;if(d?.session===editor.sessionGeneration&&d.page===editor.state.page)editor.cancel()}
  useEffect(()=>{cancel();setSelected(null)},[editor.sessionGeneration,page,shown])
  useEffect(()=>{
    const down=(e:PointerEvent)=>{if(!host.current?.contains(e.target as Node))setSelected(null)}
    const key=(e:KeyboardEvent)=>{
      if(!selected||!shown||(e.target as Element)?.closest('input,textarea,[contenteditable]'))return
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();setSelected(null)}
      if(['Delete','Backspace'].includes(e.key)&&!active.current){e.preventDefault();e.stopImmediatePropagation();editor.change('删除参考线',d=>{const owner=guideOwner(d,selected.owner);if(owner)owner.guides=owner.guides?.filter(g=>g.id!==selected.id)});setSelected(null)}
    }
    window.addEventListener('keydown',key,true);window.addEventListener('pointerdown',down,true);window.addEventListener('blur',cancel)
    return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('pointerdown',down,true);window.removeEventListener('blur',cancel)}
  },[editor,selected,shown])
  if(!shown)return null
  const location=(e:{clientX:number;clientY:number},camera=view)=>{const b=host.current!.getBoundingClientRect();return screenToWorld(camera,{x:e.clientX-b.left,y:e.clientY-b.top})}
  const start=(e:React.PointerEvent,axis:'x'|'y',owner:string,existing?:RulerGuide)=>{
    e.stopPropagation();if(existing&&intercept(e))return
    if(e.button!==0||editor.state.busy||editor.interactionActive||editor.state.tool!=='select')return
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);host.current?.focus({preventScroll:true})
    const id=existing&&!e.altKey?existing.id:uid();editor.begin(existing?(e.altKey?'复制参考线':'移动参考线'):'添加参考线')
    if(!existing||e.altKey)editor.change('添加参考线',d=>{const target=guideOwner(d,owner);if(!target)throw Error('参考线容器已移除');(target.guides??=[]).push({id,axis,position:existing?.position??guidePosition(d,owner,axis,location(e))})})
    active.current={pointer:e.pointerId,session:editor.sessionGeneration,page:editor.state.page,owner,id,axis,view:{...view},created:!existing||e.altKey,start:{x:e.clientX,y:e.clientY},moved:false};setSelected({owner,id})
  }
  const move=(e:React.PointerEvent)=>{
    e.stopPropagation();const a=active.current;if(!a||a.pointer!==e.pointerId||a.session!==editor.sessionGeneration||a.page!==editor.state.page)return
    a.moved ||= e.clientX!==a.start.x||e.clientY!==a.start.y
    if(!a.moved)return
    let position=guidePosition(editor.state.doc,a.owner,a.axis,location(e,a.view));if(!e.ctrlKey)position=Math.round(position)
    if(!Number.isFinite(position)||Math.abs(position)>1e7)return
    editor.change('移动参考线',d=>{const guide=guideOwner(d,a.owner)?.guides?.find(g=>g.id===a.id);if(guide)guide.position=position})
  }
  const end=(e:React.PointerEvent)=>{
    const a=active.current;if(!a||a.pointer!==e.pointerId)return;move(e);active.current=null
    const b=host.current!.getBoundingClientRect(),inside=e.clientX-b.left>=20&&e.clientY-b.top>=20&&e.clientX<b.right&&e.clientY<b.bottom
    if(!inside&&a.created){editor.cancel();setSelected(null);return}
    if(!inside)editor.change('移除参考线',d=>{const target=guideOwner(d,a.owner);if(target)target.guides=target.guides?.filter(g=>g.id!==a.id)} )
    editor.commit();if(!inside)setSelected(null)
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
          <line x1={a.x*view.zoom+view.x} y1={a.y*view.zoom+view.y} x2={b.x*view.zoom+view.x} y2={b.y*view.zoom+view.y} stroke="transparent" strokeWidth={8} pointerEvents={g.editable&&editor.state.tool==='select'?'stroke':'none'} style={{cursor:g.guide.axis==='x'?'ew-resize':'ns-resize'}} onPointerDown={e=>start(e,g.guide.axis,g.owner,g.guide)} onDoubleClick={e=>e.stopPropagation()}/>
        </g>})}
    </svg>
    <div className="canvas-ruler horizontal" data-testid="horizontal-ruler" onPointerDown={e=>start(e,'y',owner)}>{ticks('x').map(t=><span key={t.value} style={{left:t.at}}>{Number(t.value.toFixed(4))}</span>)}</div>
    <div className="canvas-ruler vertical" data-testid="vertical-ruler" onPointerDown={e=>start(e,'x',owner)}>{ticks('y').map(t=><span key={t.value} style={{top:t.at}}>{Number(t.value.toFixed(4))}</span>)}</div>
    <div className="ruler-origin"/>
    {selected&&selectedGuide&&<div className="guide-properties" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
      <span>{selected.owner===page?'页面':'画板'}参考线</span>
      <NumberField label="参考线位置" value={selectedGuide.position} onChange={position=>editor.change('设置参考线位置',d=>{const g=guideOwner(d,selected.owner)?.guides?.find(g=>g.id===selected.id);if(g)g.position=position})}/>
      <button onClick={()=>{editor.change('删除参考线',d=>{const o=guideOwner(d,selected.owner);if(o)o.guides=o.guides?.filter(g=>g.id!==selected.id)});setSelected(null)}}>删除</button>
    </div>}
  </div>
}
