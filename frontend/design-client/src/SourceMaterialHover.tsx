import {useLayoutEffect,useRef,type RefObject} from 'react'
import {screenToWorld,type CanvasCamera} from './canvas-camera'
import type {SourceCanvasItem} from './desktop'
import {deepSelectChord} from './figma-basic-ops'
import {boxPoints} from './geometry'
import {crispOutlinePath} from './kernel/gpu/canvas-overlay'
import type {Point} from './model'
import {HOVER_BLUE,HOVER_STROKE_PX} from './selection-blue'
import {shortcutPlatform} from './shortcut-profiles'
import type {SourceHitReply,SourceHoverHub} from './source-hover-detail'

type Props={host:RefObject<HTMLDivElement|null>;view:CanvasCamera;panning:boolean;chromeSelector:string;
  pick:(point:Point)=>SourceCanvasItem|undefined;detail?:SourceHoverHub}

/** One outline, independent of the tile renderer. The catalogue can answer
 * before native pixels arrive; an already displayed source can refine the hit. */
export function SourceMaterialHover(props:Props){
  const path=useRef<SVGPathElement>(null),latest=useRef(props),refresh=useRef(()=>{})
  latest.current=props
  useLayoutEffect(()=>{
    const host=props.host.current,outline=path.current,hub=props.detail
    if(!host||!outline)return
    let position:Point|undefined,deep=false,disposed=false,epoch=0,requested=-1,busy=false,retries=0
    let frame=0,wheelTimer:ReturnType<typeof setTimeout>|undefined,retry:ReturnType<typeof setTimeout>|undefined
    let refined:SourceHitReply|undefined,drawn=''
    const hide=()=>{
      drawn='';outline.style.display='none';outline.removeAttribute('d')
      delete outline.dataset.materialId;delete outline.dataset.nodeId
    }
    const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(draw)}
    const invalidate=()=>{epoch++;refined=undefined;retries=0;clearTimeout(retry);schedule()}
    const draw=()=>{
      frame=0
      const {view,pick,panning}=latest.current
      if(!position||panning||wheelTimer!==undefined){hide();return}
      const b=host.getBoundingClientRect(),screen={x:position.x-b.left,y:position.y-b.top},point=screenToWorld(view,screen)
      const item=screen.x>=0&&screen.y>=0&&screen.x<b.width&&screen.y<b.height?pick(point):undefined
      if(!item){hide();return}
      if(refined&&!refined.hit)hide()
      else{
        const node=refined?.hit?.nodeId??item.id,corners=refined?.hit?.corners??boxPoints(item.placed)
        const key=[item.id,node,view.zoom,view.x,view.y,...corners.flatMap(p=>[p.x,p.y])].join('/')
        if(key!==drawn){
          const d=crispOutlinePath(corners,view,HOVER_STROKE_PX)
          if(!d)hide()
          else{drawn=key;outline.setAttribute('d',d);outline.dataset.materialId=item.id;outline.dataset.nodeId=node;outline.style.display=''}
        }
      }
      if(busy||requested===epoch||!hub?.pick)return
      const at=requested=epoch,owner=hub.pick,job=owner(item,point,view.zoom,deep)
      if(!job)return
      busy=true
      void job.then(result=>{
        if(disposed||epoch!==at||hub.pick!==owner)return
        if(result)refined=result
        else if(retries++<2)retry=setTimeout(()=>{if(epoch===at){requested=-1;schedule()}},100)
      }).catch(()=>{}).finally(()=>{busy=false;schedule()})
    }
    const platform=shortcutPlatform()
    const move=(e:PointerEvent)=>{
      if(e.pointerType==='touch'||e.buttons||!(e.target instanceof Element)||e.target.closest(latest.current.chromeSelector)){leave();return}
      const chord=deepSelectChord(e,platform)
      if(position?.x===e.clientX&&position.y===e.clientY&&deep===chord)return
      deep=chord;position={x:e.clientX,y:e.clientY};invalidate()
    }
    const key=(e:KeyboardEvent)=>{
      const chord=deepSelectChord(e,platform)
      if(position&&chord!==deep){deep=chord;invalidate()}
    }
    const leave=()=>{position=undefined;deep=false;clearTimeout(wheelTimer);wheelTimer=undefined;invalidate();hide()}
    const wheel=(e:WheelEvent)=>{
      if(!(e.target instanceof Element)||e.target.closest(latest.current.chromeSelector)){leave();return}
      position={x:e.clientX,y:e.clientY};deep=deepSelectChord(e,platform);invalidate();hide();clearTimeout(wheelTimer)
      wheelTimer=setTimeout(()=>{wheelTimer=undefined;schedule()},80)
    }
    refresh.current=invalidate;if(hub)hub.refresh=invalidate
    host.addEventListener('pointermove',move,true);host.addEventListener('pointerup',move,true)
    host.addEventListener('pointerdown',leave,true);host.addEventListener('pointerleave',leave)
    host.addEventListener('pointercancel',leave,true);host.addEventListener('wheel',wheel,{passive:true,capture:true})
    window.addEventListener('blur',leave);window.addEventListener('keydown',key,true);window.addEventListener('keyup',key,true)
    return ()=>{
      disposed=true;refresh.current=()=>{};if(hub?.refresh===invalidate)delete hub.refresh
      cancelAnimationFrame(frame);clearTimeout(wheelTimer);clearTimeout(retry)
      host.removeEventListener('pointermove',move,true);host.removeEventListener('pointerup',move,true)
      host.removeEventListener('pointerdown',leave,true);host.removeEventListener('pointerleave',leave)
      host.removeEventListener('pointercancel',leave,true);host.removeEventListener('wheel',wheel,true)
      window.removeEventListener('blur',leave);window.removeEventListener('keydown',key,true);window.removeEventListener('keyup',key,true)
    }
  },[props.host,props.detail])
  useLayoutEffect(()=>refresh.current(),[props.view.x,props.view.y,props.view.zoom,props.pick,props.panning])
  return <svg aria-hidden="true" className="source-material-hover" width="100%" height="100%" style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none'}}>
    <g transform={`translate(${props.view.x} ${props.view.y}) scale(${props.view.zoom})`}>
      <path ref={path} data-testid="source-hover-outline" fill={HOVER_BLUE} stroke="none" shapeRendering="crispEdges" style={{display:'none'}}/>
    </g>
  </svg>
}
