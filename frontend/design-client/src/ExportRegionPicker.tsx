import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { screenToWorld, type CanvasCamera } from './canvas-camera'
import type { Bounds, Point } from './model'
import type { Editor } from './engine'

type Drag = { pointerId: number; camera: CanvasCamera; start: Point; last: Point }

export function ExportRegionPicker({ editor, canvas, english, onPick, onCancel }: {
  editor: Editor
  canvas: HTMLElement
  english: boolean
  onPick: (box: Bounds) => void
  onCancel: () => void
}) {
  const overlay = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [rect, setRect] = useState<Bounds>()
  useLayoutEffect(() => { overlay.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if(event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onCancel])
  function point(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(box.width, event.clientX - box.left)), y: Math.max(0, Math.min(box.height, event.clientY - box.top)) }
  }
  function bounds(a: Point,b: Point) {
    return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}
  }
  return createPortal(<div ref={overlay} tabIndex={-1} role="dialog" aria-label={english?'Draw export region':'框选导出区域'} className="export-region-picker"
    onWheel={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
    onPointerDown={event=>{
      event.stopPropagation()
      if(!event.isPrimary || event.button!==0 || drag.current)return
      event.preventDefault()
      const start=point(event)
      drag.current={pointerId:event.pointerId,camera:{...editor.flushPendingView()},start,last:start}
      event.currentTarget.setPointerCapture(event.pointerId)
      setRect(bounds(start,start))
    }}
    onPointerMove={event=>{
      event.stopPropagation()
      const current=drag.current
      if(!current || current.pointerId!==event.pointerId)return
      current.last=point(event)
      setRect(bounds(current.start,current.last))
    }}
    onPointerCancel={event=>{event.stopPropagation();drag.current=null;setRect(undefined)}}
    onPointerUp={event=>{
      event.stopPropagation()
      const current=drag.current
      if(!current || current.pointerId!==event.pointerId)return
      drag.current=null
      const end=point(event)
      if(Math.abs(end.x-current.start.x)<2 || Math.abs(end.y-current.start.y)<2){setRect(undefined);return}
      const pixelPoint=(p:Point)=>{const v=screenToWorld(current.camera,p);return {x:Math.round(v.x),y:Math.round(v.y)}}
      const region=bounds(pixelPoint(current.start),pixelPoint(end))
      if(region.width && region.height)onPick(region)
      else setRect(undefined)
    }}>
    <div className="export-region-prompt" onPointerDown={e=>e.stopPropagation()} onPointerUp={e=>e.stopPropagation()}>
      <span>{english?'Drag to choose the export area':'拖动框选要导出的区域'}</span><button type="button" onClick={onCancel}>{english?'Cancel':'取消'}</button>
    </div>
    {rect&&<div className="export-region-outline" style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height}}/>}
  </div>,canvas)
}
