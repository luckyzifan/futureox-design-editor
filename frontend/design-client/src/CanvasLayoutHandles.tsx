import {useEffect,useRef,useState} from 'react'
import type {Editor} from './engine'
import type {AutoLayout,Matrix,Point} from './model'
import {apply,inverse,worldMatrix} from './geometry'
import type {CanvasCamera,CanvasSize} from './canvas-camera'
import {screenToWorld} from './canvas-camera'
import {adjustLayoutHandle,layoutHandles,type LayoutHandle} from './canvas-layout-handles'
import {NumberField} from './fields'

export function CanvasLayoutHandles({editor,view,size,visible}:{editor:Editor;view:CanvasCamera;size:CanvasSize;visible:boolean}){
  const host=useRef<HTMLDivElement>(null),[input,setInput]=useState<{handle:LayoutHandle;alt:boolean;shift:boolean}|null>(null),[feedback,setFeedback]=useState<string|null>(null)
  const active=useRef<{pointer:number;session:number;page:string;id:string;handle:LayoutHandle;layout:AutoLayout;inverse:Matrix;view:CanvasCamera;start:Point;moved:boolean}|null>(null)
  const ids=editor.topSelection(),id=ids.length===1?ids[0]:null,n=id?editor.state.doc.nodes[id]:undefined
  const cancel=()=>{const a=active.current;active.current=null;setFeedback(null);if(a?.session===editor.sessionGeneration&&a.page===editor.state.page)editor.cancel()}
  useEffect(()=>{cancel();setInput(null)},[editor.sessionGeneration,editor.state.page,id,editor.state.tool])
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(active.current||input)){e.preventDefault();e.stopImmediatePropagation();cancel();setInput(null)}};window.addEventListener('keydown',key,true);window.addEventListener('blur',cancel);return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('blur',cancel)}},[editor,input])
  if(!id||!n?.layout||n.layout.mode==='none'||n.instanceOrigin||n.instance||editor.state.tool!=='select')return null
  const matrix=worldMatrix(editor.state.doc,id),handles=layoutHandles(editor.state.doc,id)
  const point=(e:{clientX:number;clientY:number},camera=view)=>{const b=host.current!.getBoundingClientRect();return screenToWorld(camera,{x:e.clientX-b.left,y:e.clientY-b.top})}
  const start=(e:React.PointerEvent,h:LayoutHandle)=>{
    e.stopPropagation();if(e.button!==0||editor.interactionActive||editor.state.busy)return
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);setInput(null);editor.begin(h.padding===undefined?'调整自动布局间距':'调整内边距')
    const inv=inverse(matrix);active.current={pointer:e.pointerId,session:editor.sessionGeneration,page:editor.state.page,id,handle:h,layout:structuredClone(n.layout!),inverse:inv,view:{...view},start:apply(inv,point(e)),moved:false}
  }
  const move=(e:React.PointerEvent)=>{
    e.stopPropagation();const a=active.current;if(!a||a.pointer!==e.pointerId||a.session!==editor.sessionGeneration||a.page!==editor.state.page)return
    const local=apply(a.inverse,point(e,a.view)),delta=local[a.handle.axis]-a.start[a.handle.axis]
    a.moved ||= Math.abs(delta)*a.view.zoom>2;if(!a.moved)return
    const layout=adjustLayoutHandle(a.layout,a.handle,delta,{alt:e.altKey,shift:e.shiftKey,ctrl:e.ctrlKey});editor.preview({[a.id]:{layout}})
    setFeedback(String(a.handle.padding===undefined?layout[a.handle.property!]:layout.padding[a.handle.padding]))
  }
  const end=(e:React.PointerEvent)=>{const a=active.current;if(!a||a.pointer!==e.pointerId)return;move(e);active.current=null;setFeedback(null);if(a.session!==editor.sessionGeneration||a.page!==editor.state.page)return;editor.commit();if(!a.moved)setInput({handle:a.handle,alt:e.altKey,shift:e.shiftKey})}
  const screen=(p:Point)=>{const w=apply(matrix,p);return{x:w.x*view.zoom+view.x,y:w.y*view.zoom+view.y}}
  return <div ref={host} className="canvas-layout-handles" onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={()=>{if(active.current)cancel()}}>
    <svg width={size.width} height={size.height} style={{visibility:visible?'visible':'hidden'}}>{handles.map(h=>{const p=screen(h.point);return <g key={h.key} data-testid={`layout-handle-${h.key}`} pointerEvents="all" onPointerDown={e=>start(e,h)} style={{cursor:h.axis==='x'?'ew-resize':'ns-resize'}}>
      <rect x={p.x-6} y={p.y-6} width={12} height={12} fill="transparent"/>
      <line x1={p.x-(h.axis==='y'?5:0)} y1={p.y-(h.axis==='x'?5:0)} x2={p.x+(h.axis==='y'?5:0)} y2={p.y+(h.axis==='x'?5:0)} stroke="#f24eaa" strokeWidth={2.5}/>
    </g>})}</svg>
    {feedback&&<div className="layout-handle-input">{feedback}</div>}
    {input&&<div className="layout-handle-input" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}><NumberField label={input.handle.padding===undefined?'间距':'内边距'} value={input.handle.padding===undefined?n.layout[input.handle.property!]:n.layout.padding[input.handle.padding]} min={input.handle.padding===undefined?-1e6:0} onChange={value=>{const h=input.handle;editor.update([id],{layout:adjustLayoutHandle(n.layout!,{...h,value},0,{alt:input.alt,shift:input.shift,ctrl:true})},'设置自动布局');setInput(null)}}/><button onClick={()=>setInput(null)}>完成</button></div>}
  </div>
}
