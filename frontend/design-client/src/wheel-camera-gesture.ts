import {clampCanvasZoom,wheelCamera,wheelDeltaPixels,zoomAt,type CanvasCamera,type CanvasSize} from './canvas-camera'
import type {Point} from './model'
type Wheel=Parameters<typeof wheelCamera>[1]
type WheelRun={base:CanvasCamera;last:CanvasCamera;anchor:Point;size:CanvasSize;rate:number;x:number;y:number;cx:number;cy:number}
const MAX_WHEEL_RUNS=8

/** Integrate deltas against the gesture's original camera, not an already
 * rounded intermediate pose. Equal opposite inputs then return to the same
 * camera/texture identity, even after crossing large coordinate magnitudes.
 * There is no snapping or reduction of authored zoom/translation precision. */
export class WheelCameraGesture {
  private run?:WheelRun
  private readonly previous:WheelRun[]=[]
  reset(){this.run=undefined;this.previous.length=0}
  update(view:CanvasCamera,event:Wheel,size:CanvasSize,anchor:Point,scrollWheelZoom=false,pinch=false){
    const zoom=!!(event.ctrlKey||event.metaKey)||(scrollWheelZoom&&!event.shiftKey)
    const rate=zoom?(pinch ? .01 : .003):0
    const delta=wheelDeltaPixels(zoom?{deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,shiftKey:false}:event,size)
    if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y)){this.reset();return wheelCamera(view,event,size,anchor,scrollWheelZoom,pinch)}
    let run=this.run
    if(run&&(run.last.x!==view.x||run.last.y!==view.y||run.last.zoom!==view.zoom||
      run.size.width!==size.width||run.size.height!==size.height)){
      this.reset();run=undefined
    }
    if(!run||run.rate!==rate||zoom&&(run.anchor.x!==anchor.x||run.anchor.y!==anchor.y)){
      if(run){
        this.previous.push(run)
        if(this.previous.length>MAX_WHEEL_RUNS)this.previous.shift()
      }
      run=this.run={base:{...view},last:{...view},anchor:{...anchor},size:{...size},rate,x:0,y:0,cx:0,cy:0}
    }
    const dx=delta.x-run.cx,nx=run.x+dx;run.cx=(nx-run.x)-dx;run.x=nx
    const dy=delta.y-run.cy,ny=run.y+dy;run.cy=(ny-run.y)-dy;run.y=ny
    const requested=run.base.zoom*Math.exp(-run.y*rate)
    const next=zoom?zoomAt(run.base,clampCanvasZoom(requested),anchor):{...run.base,x:run.base.x-run.x,y:run.base.y-run.y}
    run.last=next
    // A limit consumes the excess input. Reversal must respond immediately,
    // without paying back wheel deltas that could not move the camera.
    if(zoom&&requested!==next.zoom)this.reset()
    else if(run.y===0&&run.cy===0&&(zoom||run.x===0&&run.cx===0)){
      // A fully reversed pan or zoom restores its original camera. Resume
      // the earlier run so a nested reversal also returns to exact tiles.
      this.run=this.previous.pop()
    }
    return next
  }
}
