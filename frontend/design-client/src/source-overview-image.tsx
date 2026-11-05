import {useEffect,useState} from 'react'
import {desktopBridge,type SourceCanvasSnapshot,type SourceCanvasBox} from './desktop'
import type {CanvasCamera} from './canvas-camera'
import type {OverviewMaterial} from './kernel/source-overview-handoff'
import {sourcePageClip} from './source-opening-preview'

type Preview={snapshot:SourceCanvasSnapshot;bounds:SourceCanvasBox;scale:number;width:number;height:number;src:string}
export function SourceOverviewImage({source,materials,view,width,height}:{source:SourceCanvasSnapshot;materials:readonly OverviewMaterial[];
  view:CanvasCamera;width:number;height:number}){
  const [preview,setPreview]=useState<Preview>()
  useEffect(()=>{
    const bridge=desktopBridge()?.largeDocument
    if(!bridge?.canvasPreview)return
    const read=bridge.canvasPreview.bind(bridge)
    let live=true,timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{
      try{
        const result=await read({owner:source.owner,expectedRevision:source.revision,token:source.token})
        if(!live||result.status!=='ok')return
        if(result.phase==='pending'){timer=setTimeout(()=>void poll(),80);return}
        if(result.phase!=='ready'||!result.bounds)return
        const src='data:image/png;base64,'+result.png
        const decoded=new Image();decoded.src=src;await decoded.decode()
        if(live&&decoded.naturalWidth===result.width&&decoded.naturalHeight===result.height)
          setPreview({snapshot:source,bounds:result.bounds,scale:result.scale,width:result.width,height:result.height,src})
      }catch{/* The catalogue and the exact scene remain available. */}
    }
    void poll()
    return ()=>{live=false;clearTimeout(timer)}
  },[source.token,source.owner.documentId,source.owner.sessionEpoch,source.revision])
  if(!preview)return null
  const old=preview.snapshot
  if(old.owner.documentId!==source.owner.documentId||old.owner.sessionEpoch!==source.owner.sessionEpoch||
    old.revision!==source.revision||old.pageId!==source.pageId||old.colorManaged!==source.colorManaged||old.rasterProfile!==source.rasterProfile)return null
  const boxes=materials.filter(b=>b.materialKey&&old.materialKeys?.includes(b.materialKey)&&b.previewScale!==undefined&&b.previewScale<preview.scale)
  if(!boxes.length)return null
  const b=preview.bounds,s=view.zoom/preview.scale
  return <div className="source-overview-image" aria-hidden="true" data-world-scale={preview.scale}
    style={{position:'absolute',inset:0,pointerEvents:'none',overflow:'hidden',clipPath:sourcePageClip(boxes,view,width,height)}}>
    <img alt="" src={preview.src} draggable={false} style={{position:'absolute',left:0,top:0,maxWidth:'none',
      width:preview.width*s,height:preview.height*s,transform:`translate(${view.x+b.x*view.zoom}px,${view.y+b.y*view.zoom}px)`}}/>
  </div>
}
