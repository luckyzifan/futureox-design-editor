import {useLayoutEffect,useRef} from 'react'
import type {SourceCanvasSnapshot} from '../../src/kernel/../desktop'
import type {CanvasCamera} from '../../src/kernel/../canvas-camera'
import {KernelClient,backendPreference,renderExecutionPolicy,type TileResult} from '../../src/kernel/client'
import {canvasSamplingProfile} from '../../src/kernel/render-policy'
import {canvasRasterPlan,canvasRasterPhaseMatches,nativeTileMotionScale} from '../../src/kernel/canvas-raster-plan'
import {planTilesAligned} from '../../src/kernel/tile-plan-aligned'
import {tilePrepareViewport} from '../../src/kernel/tile-prepare-viewport'
import {tileComputationDependsOnCamera,tileComputationKey} from '../../src/kernel/tile-computation-key'
import {tileIntersectsView} from '../../src/kernel/tile-preview'
import {useDevicePixelRatio} from '../../src/kernel/presentation'
import type {ResidentAcknowledgement} from '../../src/kernel/resident-presentation'
import type {ResidentFrame} from '../../src/kernel/gpu/resident-presenter'
import type {RasterTile} from '../../src/kernel/tile-cache'
import {createRenderDiagnostics,PREFIX} from '../../src/kernel/../../../design-desktop/src/render-terminal-diagnostics.mjs'

export type NativeSourceStatus={phase:'loading'|'refining'|'ready'|'error';done:number;total:number;error?:string}
type Props={source:SourceCanvasSnapshot;view:CanvasCamera;width:number;height:number;
  onStatus?:(status:NativeSourceStatus)=>void;onPresented?:(frame:ResidentAcknowledgement,complete:boolean)=>void}
type Tile=TileResult&{serial:number;used:number;lastSubmission:number}

/** Same native compiler/GPU/presenter, with source ownership in place of a
 * whole JS document. Tiles and camera submissions stay outside React state. */
export function NativeSourceSurface(props:Props){
  const host=useRef<HTMLDivElement>(null),latest=useRef(props),wake=useRef<()=>void>(()=>{})
  const dpr=useDevicePixelRatio(),density=useRef(dpr);density.current=dpr;latest.current=props
  useLayoutEffect(()=>{
    if(latest.current.width<=0||latest.current.height<=0)return
    const source=latest.current.source,client=new KernelClient(),element=document.createElement('canvas'),badge=document.createElement('span')
    const diagnostics=createRenderDiagnostics({enabled:window.coreDesktop?.renderDiagnostics===true,session:Math.floor(Math.random()*1e12),sink:record=>console.log(PREFIX+JSON.stringify(record))})
    const profile=canvasSamplingProfile(renderExecutionPolicy,source.rasterProfile,backendPreference(),source.colorManaged)
    element.className='kernel-compositor native-source-content'
    element.setAttribute('aria-label','全源画板')
    Object.assign(element.style,{position:'absolute',inset:'0',pointerEvents:'none'})
    host.current!.append(element)
    badge.className='kernel-status';badge.setAttribute('role','status');badge.setAttribute('aria-label','完整画板显示状态')
    Object.assign(badge.style,{position:'absolute',right:'14px',top:'var(--kernel-status-top, 12px)',fontSize:'11px',color:'#7b8190',zIndex:'5'})
    host.current!.append(badge)
    const prefix=crypto.randomUUID(),cache=new Map<string,Tile>(),retired=new Map<number,number>()
    let alive=true,initialized=false,running=false,failed=false,frameHandle=0,idleTimer:ReturnType<typeof setTimeout>|undefined
    let moving=false,serial=0,submission=0,acknowledged=0,tick=0,lastStatus='',lastStatusAt=-Infinity
    let inflight:{tile:RasterTile;controller:AbortController}|undefined
    let wanted:{id:string;sequence:number;view:CanvasCamera;width:number;height:number;dpr:number;complete:boolean;ids:Set<number>}|undefined
    const emit=(status:NativeSourceStatus)=>{
      if(!alive)return
      const signature=`${status.phase}/${status.done}/${status.total}/${status.error??''}`,now=performance.now()
      if(signature===lastStatus)return
      if(status.phase==='refining'&&lastStatus.startsWith('refining/')&&now-lastStatusAt<120)return
      lastStatus=signature;lastStatusAt=now
      badge.textContent=status.phase==='ready'?'WebGPU · 清晰':status.phase==='error'?'画板绘制未完成':status.phase==='loading'?'正在准备完整画板…':`正在绘制 ${status.done} / ${status.total}`
      badge.title=status.error??'当前视口完成全部瓦片与采样密度校验后显示清晰'
      diagnostics.record('viewport-state',{state:status.phase==='loading'?0:status.phase==='refining'?1:status.phase==='ready'?2:3,
        previewTiles:status.done,count:status.total,zoom:latest.current.view.zoom,dpr:density.current,
        width:latest.current.width,height:latest.current.height,sceneReady:initialized?1:0,finalComplete:status.phase==='ready'?1:0})
      if(status.phase==='ready'||status.phase==='error')diagnostics.flush()
      latest.current.onStatus?.(status)
    }
    const fail=(error:unknown)=>{failed=true;emit({phase:'error',done:0,total:0,error:error instanceof Error?error.message:String(error)})}
    const plan=()=>{
      const p=latest.current,ratio=density.current
      const raster=canvasRasterPlan(p.view,ratio,p.width,p.height,{rasterProfile:profile,exactPhase:!moving,
        samplingScale:moving?nativeTileMotionScale(p.view,ratio,p.width,p.height):undefined})
      const bounds={x:-p.view.x/p.view.zoom,y:-p.view.y/p.view.zoom,width:p.width/p.view.zoom,height:p.height/p.view.zoom}
      const dependent=tileComputationDependsOnCamera({rasterProfile:profile},source.colorManaged)
      const tiles=planTilesAligned(bounds,raster.scale,256,raster.phase).map(tile=>({...tile,key:tileComputationKey(tile,raster.camera,dependent)}))
      return {p,ratio,raster,tiles,keys:new Set(tiles.map(tile=>tile.key)),exact:canvasRasterPhaseMatches(p.view,ratio,raster.scale,raster.phase)}
    }
    const release=()=>{
      const ids:number[]=[]
      for(const[id,after]of retired)if(after<=acknowledged){ids.push(id);retired.delete(id)}
      client.releasePresented(ids)
    }
    const retire=(tile:Tile)=>{
      tile.bitmap?.close()
      if([...cache.values()].some(other=>other!==tile&&other.gpuTile===tile.gpuTile))return
      if(tile.gpuTile)retired.set(tile.gpuTile,Math.max(retired.get(tile.gpuTile)??0,tile.lastSubmission))
    }
    const paint=()=>{
      frameHandle=0
      if(!alive||!initialized||failed)return
      try{
        const {p,ratio,tiles,keys,exact}=plan(),done=tiles.filter(tile=>cache.has(tile.key)).length
        element.style.width=`${p.width}px`;element.style.height=`${p.height}px`
        const visible=[...cache.values()].filter(tile=>tileIntersectsView(tile,p.view,p)).sort((a,b)=>a.zoom-b.zoom||a.used-b.used)
        if(!visible.length){emit({phase:'refining',done,total:tiles.length});return}
        const sequence=++submission,id=`${prefix}:${sequence}`,complete=done===tiles.length&&exact
        for(const tile of visible){tile.lastSubmission=sequence;tile.used=++tick}
        const items:ResidentFrame['items']=visible.map(tile=>({active:true,layer:keys.has(tile.key)?4:1,
          tile:{key:tile.key,serial:tile.serial,gpuTile:tile.gpuTile!,x:tile.x,y:tile.y,width:tile.width,height:tile.height,zoom:tile.zoom,phaseX:tile.phaseX,phaseY:tile.phaseY}}))
        wanted={id,sequence,view:{...p.view},width:p.width,height:p.height,dpr:ratio,complete,ids:new Set(visible.map(tile=>tile.gpuTile!))}
        client.present({presentationId:id,view:p.view,width:p.width,height:p.height,dpr:ratio,items,allowEmpty:!complete})
        emit({phase:'refining',done,total:tiles.length})
        // This is an evictable history allowance, never a source-size refusal.
        const keep=Math.max(32,tiles.length*3)
        for(const tile of [...cache.values()].sort((a,b)=>a.used-b.used)){
          if(cache.size<=keep)break
          if(keys.has(tile.key))continue
          cache.delete(tile.key);retire(tile)
        }
        release()
      }catch(error){fail(error)}
    }
    const schedulePaint=()=>{if(alive&&!frameHandle)frameHandle=requestAnimationFrame(paint)}
    const receive=(tile:TileResult)=>{
      if(!alive){tile.bitmap?.close();if(tile.gpuTile)client.releasePresented([tile.gpuTile]);return}
      if(!tile.gpuTile){tile.bitmap?.close();throw Error('完整源画布尚未取得 GPU 显示纹理')}
      const old=cache.get(tile.key)
      if(old&&old.gpuTile!==tile.gpuTile)retire(old)
      retired.delete(tile.gpuTile)
      cache.set(tile.key,{...tile,serial:old?.gpuTile===tile.gpuTile?old.serial:++serial,used:++tick,lastSubmission:old?.gpuTile===tile.gpuTile?old.lastSubmission:0})
      schedulePaint()
    }
    const run=async()=>{
      if(!alive||!initialized||running||failed)return
      running=true
      try{
        while(alive&&!failed){
          const {p,ratio,raster,tiles}=plan(),missing=tiles.filter(tile=>!cache.has(tile.key))
          if(!missing.length){schedulePaint();break}
          const tile=missing[0]
          const work={tile,controller:new AbortController()};inflight=work
          try{
            await client.renderSource(source,{pageId:source.pageId,width:Math.ceil(p.width*ratio),height:Math.ceil(p.height*ratio),
              view:raster.camera,transparent:false,grid:false,rasterProfile:profile,
              tileViewport:[tile],tilePrepareViewport:tilePrepareViewport(tiles,raster.camera),renderIntent:'preview',
              tileOwner:{documentId:source.owner.documentId,sessionEpoch:source.owner.sessionEpoch}},receive,work.controller.signal)
          }catch(error){if(work.controller.signal.aborted||String(error).includes('PREVIEW_CANCELLED'))continue;throw error}
          finally{if(inflight===work)inflight=undefined}
          if(!cache.has(tile.key))throw Error('源画板瓦片未返回，已保留当前画面')
          // Yield host bookkeeping; native preparation and GPU work already
          // use their existing independent threads and bounded task queues.
          await new Promise<void>(resolve=>setTimeout(resolve,0))
        }
      }catch(error){if(alive)fail(error)}finally{running=false}
    }
    client.onPresentation=stats=>{
      if(!alive||failed)return
      if(stats.error){fail(stats.error);return}
      if(Array.isArray(stats.missingGpuTiles)){
        const missing=new Set(stats.missingGpuTiles)
        for(const[key,tile]of cache)if(missing.has(tile.gpuTile)){cache.delete(key);retire(tile)}
        release();void run()
      }
      const actual=stats.presented as ResidentAcknowledgement|undefined
      if(!actual?.presentationId?.startsWith(prefix+':'))return
      const sequence=Number(actual.presentationId.slice(prefix.length+1))
      if(!Number.isSafeInteger(sequence)||sequence<=0||sequence>submission||sequence<acknowledged)return
      acknowledged=sequence;release()
      const expected=wanted,p=latest.current
      if(!expected||actual.presentationId!==expected.id||actual.view.x!==expected.view.x||actual.view.y!==expected.view.y||actual.view.zoom!==expected.view.zoom||
        actual.width!==expected.width||actual.height!==expected.height||actual.dpr!==expected.dpr||
        actual.view.x!==p.view.x||actual.view.y!==p.view.y||actual.view.zoom!==p.view.zoom||actual.width!==p.width||actual.height!==p.height||actual.dpr!==density.current||
        [...expected.ids].some(id=>!actual.ids.includes(id)))return
      if(expected.complete){const count=plan().tiles.length;emit({phase:'ready',done:count,total:count})}
      latest.current.onPresented?.(actual,expected.complete)
    }
    wake.current=()=>{
      if(!alive||failed)return
      moving=true;clearTimeout(idleTimer)
      if(inflight){
        const next=plan(),relative=next.raster.scale/inflight.tile.zoom
        if(relative>2||relative<.5||!tileIntersectsView(inflight.tile,next.p.view,next.p))inflight.controller.abort()
      }
      idleTimer=setTimeout(()=>{moving=false;schedulePaint();void run()},120)
      schedulePaint();void run()
    }
    emit({phase:'loading',done:0,total:0})
    void (async()=>{
      try{
        const p=latest.current
        await client.renderSource(source,{pageId:source.pageId,width:Math.ceil(p.width*density.current),height:Math.ceil(p.height*density.current),
          view:{x:0,y:0,zoom:p.view.zoom*density.current},transparent:false,grid:false,rasterProfile:profile,tileViewport:[],renderIntent:'canvas'})
        if(!alive)return
        client.attachPresentation(element.transferControlToOffscreen());initialized=true;void run()
      }catch(error){if(alive)fail(error)}
    })()
    return()=>{alive=false;wake.current=()=>{};inflight?.controller.abort();clearTimeout(idleTimer);cancelAnimationFrame(frameHandle);client.onPresentation=undefined;client.dispose();diagnostics.flush();diagnostics.close();element.remove();badge.remove()}
  },[props.source.token,props.width>0&&props.height>0])
  useLayoutEffect(()=>wake.current(),[props.view.x,props.view.y,props.view.zoom,props.width,props.height,dpr])
  return <div ref={host} className="native-source-surface" style={{position:'absolute',inset:0,pointerEvents:'none'}}/>
}
