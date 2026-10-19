import { prototypeEase, type PrototypeEasing } from './prototype'

type ScrollTarget = Pick<HTMLElement,'scrollLeft'|'scrollTop'|'scrollWidth'|'scrollHeight'|'clientWidth'|'clientHeight'|'scrollTo'>
type Clock = { now(): number; request(callback: FrameRequestCallback): number; cancel(id:number): void }
/** Absolute-time sampling: browser smooth-scroll duration is not an authored
 * prototype duration. Cancellation never snaps to the old target. */
export function animatePrototypeScroll(element: ScrollTarget, point: {left:number;top:number}, duration: number,
  easing: PrototypeEasing | undefined, clock: Clock = {now:()=>performance.now(),request:requestAnimationFrame,cancel:cancelAnimationFrame}) {
  const target={left:Math.max(0,Math.min(point.left,element.scrollWidth-element.clientWidth)),
    top:Math.max(0,Math.min(point.top,element.scrollHeight-element.clientHeight))}
  let live=true, request=0
  if (!Number.isFinite(duration) || duration<=0) { element.scrollTo({...target,behavior:'instant'}); return ()=>{} }
  const from={left:element.scrollLeft,top:element.scrollTop},start=clock.now()
  const sample:FrameRequestCallback=now=>{
    if(!live)return
    const t=Math.max(0,Math.min(1,(now-start)/duration)),p=prototypeEase(easing,t)
    element.scrollTo({left:from.left+(target.left-from.left)*p,top:from.top+(target.top-from.top)*p,behavior:'instant'})
    if(t<1)request=clock.request(sample)
  }
  request=clock.request(sample)
  return ()=>{live=false;clock.cancel(request)}
}
