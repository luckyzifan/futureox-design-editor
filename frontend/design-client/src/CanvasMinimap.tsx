import {useEffect,useMemo,useRef} from 'react'
import type {Editor} from './engine'
import {unionBounds,type SceneEntry} from './geometry'
import type {CanvasCamera,CanvasSize} from './canvas-camera'

export function CanvasMinimap({editor,entries,view,size}:{editor:Editor;entries:SceneEntry[];view:CanvasCamera;size:CanvasSize}){
  const canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLElement>(null)
  const drag=useRef<{pointer:number;session:number;page:string;scale:number;ox:number;oy:number}|null>(null)
  const overview=useMemo(()=>{
    const bounds=unionBounds(entries.filter(e=>e.depth===0).map(e=>e.bounds)),pad=Math.max(bounds.width,bounds.height)*.08+20
    const box={x:bounds.x-pad,y:bounds.y-pad,width:Math.max(1,bounds.width+pad*2),height:Math.max(1,bounds.height+pad*2)},scale=Math.min(168/box.width,104/box.height)
    return{scale,ox:(168-box.width*scale)/2-box.x*scale,oy:(104-box.height*scale)/2-box.y*scale}
  },[entries])
  useEffect(()=>{
    const target=canvas.current;if(!target)return
    const dpr=globalThis.devicePixelRatio||1;target.width=Math.ceil(168*dpr);target.height=Math.ceil(104*dpr)
    const context=target.getContext('2d')!;context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,168,104)
    for(const entry of entries){const n=editor.state.doc.nodes[entry.id];if(!n||entry.depth>0)continue
      context.fillStyle=editor.state.selection.includes(entry.id)?'#0d99ff55':'#aeb4bc88';context.strokeStyle='#6b7280';context.lineWidth=.5
      const b=entry.bounds,x=b.x*overview.scale+overview.ox,y=b.y*overview.scale+overview.oy,w=Math.max(1,b.width*overview.scale),h=Math.max(1,b.height*overview.scale)
      context.fillRect(x,y,w,h);context.strokeRect(x,y,w,h)
    }
    const x=(-view.x/view.zoom)*overview.scale+overview.ox,y=(-view.y/view.zoom)*overview.scale+overview.oy,w=size.width/view.zoom*overview.scale,h=size.height/view.zoom*overview.scale
    context.fillStyle='#0d99ff12';context.fillRect(x,y,w,h);context.strokeStyle='#0d99ff';context.lineWidth=1.5;context.strokeRect(x,y,w,h)
  },[overview,entries,editor,editor.state.selection,view,size])
  const outside=entries.some(e=>e.depth===0&&(e.bounds.x*view.zoom+view.x<0||e.bounds.y*view.zoom+view.y<0||(e.bounds.x+e.bounds.width)*view.zoom+view.x>size.width||(e.bounds.y+e.bounds.height)*view.zoom+view.y>size.height))
  if(editor.state.minimap===false||!entries.length||!outside)return null
  const navigate=(event:React.PointerEvent)=>{
    const owner=drag.current;if(!owner||owner.pointer!==event.pointerId||owner.session!==editor.sessionGeneration||owner.page!==editor.state.page||!host.current)return
    const b=host.current.getBoundingClientRect(),x=(event.clientX-b.left-owner.ox)/owner.scale,y=(event.clientY-b.top-owner.oy)/owner.scale,zoom=editor.state.view.zoom
    editor.set({view:{x:size.width/2-x*zoom,y:size.height/2-y*zoom,zoom}})
  }
  return <section ref={host} className="canvas-minimap" aria-label="画布缩略导航" data-testid="canvas-minimap"
    onPointerDown={e=>{e.stopPropagation();if(e.button!==0||editor.interactionActive)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={pointer:e.pointerId,session:editor.sessionGeneration,page:editor.state.page,...overview};editor.hoverLayer(null,'canvas');editor.flushPendingView();navigate(e)}}
    onPointerMove={e=>{e.stopPropagation();navigate(e)}} onPointerUp={e=>{e.stopPropagation();navigate(e);drag.current=null}}
    onPointerCancel={()=>{drag.current=null}} onLostPointerCapture={()=>{drag.current=null}} onDoubleClick={e=>e.stopPropagation()} onContextMenu={e=>{e.preventDefault();e.stopPropagation()}}>
    <canvas ref={canvas} style={{width:168,height:104}} aria-label="图层边界和当前视口"/>
  </section>
}
