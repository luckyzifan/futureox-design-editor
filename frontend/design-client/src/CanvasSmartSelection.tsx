import {useEffect,useRef,useState} from 'react'
import type {Editor} from './engine'
import type {DesignDocument,Point} from './model'
import type {CanvasCamera,CanvasSize} from './canvas-camera'
import {screenToWorld} from './canvas-camera'
import {smartSelection,smartSpacing,smartReorder,type SmartSelection} from './smart-selection'

export function CanvasSmartSelection({editor,view,size,visible}:{editor:Editor;view:CanvasCamera;size:CanvasSize;visible:boolean}){
  const host=useRef<HTMLDivElement>(null),[marked,setMarked]=useState<string[]>([]),[label,setLabel]=useState<{point:Point;text:string}|null>(null)
  const active=useRef<{pointer:number;session:number;page:string;doc:DesignDocument;model:SmartSelection;view:CanvasCamera;start:Point;axis?:'x'|'y';marked:string[];moved:boolean}|null>(null)
  const selectionKey=editor.state.selection.join('\n'),page=editor.state.page,session=editor.sessionGeneration
  const cancel=()=>{const a=active.current;active.current=null;setLabel(null);if(a?.session===editor.sessionGeneration&&a.page===editor.state.page)editor.cancel()}
  useEffect(()=>{cancel();setMarked([])},[session,page,selectionKey,editor.state.tool])
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&active.current){e.preventDefault();e.stopImmediatePropagation();cancel()}}
    window.addEventListener('keydown',key,true);window.addEventListener('blur',cancel)
    return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('blur',cancel)}
  },[editor])
  const model=smartSelection(editor.state.doc,page,editor.topSelection())||active.current?.model
  if(!model||editor.state.tool!=='select')return null
  const point=(e:{clientX:number;clientY:number},camera=view)=>{const b=host.current!.getBoundingClientRect();return screenToWorld(camera,{x:e.clientX-b.left,y:e.clientY-b.top})}
  const begin=(e:React.PointerEvent,axis?:'x'|'y',id?:string)=>{
    e.stopPropagation();if(e.button!==0||editor.interactionActive||editor.state.busy)return
    e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId)
    const next=id?(e.shiftKey&&model.x.length*model.y.length===Math.max(model.x.length,model.y.length)?marked.includes(id)?marked.filter(k=>k!==id):[...marked,id]:marked.includes(id)?marked:[id]):marked
    setMarked(next);editor.begin(axis?'调整智能选区间距':'重排智能选区')
    active.current={pointer:e.pointerId,session,page,doc:editor.state.doc,model,view:{...view},start:point(e),axis,marked:next,moved:false}
  }
  const move=(e:React.PointerEvent)=>{
    e.stopPropagation();const a=active.current;if(!a||a.pointer!==e.pointerId||a.session!==editor.sessionGeneration||a.page!==editor.state.page)return
    const p=point(e,a.view);a.moved ||= Math.hypot(p.x-a.start.x,p.y-a.start.y)*a.view.zoom>2
    if(!a.moved)return
    if(a.axis){
      let gap=(a.axis==='x'?a.model.gapX:a.model.gapY)+p[a.axis]-a.start[a.axis]
      if(!e.ctrlKey)gap=Math.round(gap/(e.shiftKey?10:1))*(e.shiftKey?10:1)
      gap=Math.max(0,Math.min(1e6,gap))
      editor.preview(smartSpacing(a.doc,a.model,a.axis,gap));setLabel({point:p,text:String(Number(gap.toFixed(3)))})
    }else{
      const nearest=a.model.ids.reduce((best,id)=>{const b=a.model.boxes[id],c=a.model.boxes[best];return Math.hypot(p.x-b.x-b.width/2,p.y-b.y-b.height/2)<Math.hypot(p.x-c.x-c.width/2,p.y-c.y-c.height/2)?id:best},a.model.ids[0])
      const patches=smartReorder(a.doc,a.model,a.marked,nearest,e.metaKey||e.ctrlKey)
      // Restore every original transform when dragging back to the source slot.
      editor.preview(Object.fromEntries(a.model.ids.map(id=>[id,patches[id]||{transform:a.doc.nodes[id].transform}])))
    }
  }
  const end=(e:React.PointerEvent)=>{const a=active.current;if(!a||a.pointer!==e.pointerId)return;move(e);active.current=null;setLabel(null);if(a.session===editor.sessionGeneration&&a.page===editor.state.page)editor.commit()}
  const screen=(p:Point)=>({x:p.x*view.zoom+view.x,y:p.y*view.zoom+view.y})
  return <div ref={host} className="canvas-smart-selection" onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={()=>{if(active.current)cancel()}}>
    <svg width={size.width} height={size.height} style={{visibility:visible?'visible':'hidden'}}>
      {model.ids.map(id=>{const b=model.boxes[id],p=screen({x:b.x+b.width/2,y:b.y+b.height/2});return <circle key={id} data-testid="smart-reorder" data-node-id={id} cx={p.x} cy={p.y} r={4} fill={marked.includes(id)?'#f24eaa':'white'} stroke="#f24eaa" strokeWidth={1.5} pointerEvents="all" style={{cursor:'move'}} onPointerDown={e=>begin(e,undefined,id)}/>})}
      {(['x','y'] as const).flatMap(axis=>model[axis].slice(1).map((t,i)=>{
        const prev=model[axis][i].bounds,b=t.bounds,length=axis==='x'?'width':'height'
        const across=axis==='x'?Math.max(prev.y,b.y)+Math.min(prev.height,b.height)/2:Math.max(prev.x,b.x)+Math.min(prev.width,b.width)/2
        const mid=(prev[axis]+prev[length]+b[axis])/2,p=screen(axis==='x'?{x:mid,y:across}:{x:across,y:mid})
        return <g key={axis+i} data-testid={`smart-gap-${axis}`} onPointerDown={e=>begin(e,axis)} style={{cursor:axis==='x'?'ew-resize':'ns-resize'}} pointerEvents="all">
          <rect x={p.x-6} y={p.y-6} width={12} height={12} fill="transparent"/>
          <line x1={p.x-(axis==='y'?5:0)} y1={p.y-(axis==='x'?5:0)} x2={p.x+(axis==='y'?5:0)} y2={p.y+(axis==='x'?5:0)} stroke="#f24eaa" strokeWidth={2.5}/>
        </g>
      }))}
      {label&&<g pointerEvents="none" transform={`translate(${screen(label.point).x+15} ${screen(label.point).y-20})`}><rect width={60} height={24} rx={4} fill="#f24eaa"/><text x={6} y={16} fill="white" fontSize={12}>{label.text}</text></g>}
    </svg>
  </div>
}
