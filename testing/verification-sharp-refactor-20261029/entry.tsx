import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {NativeSourceSurface, type NativeSourceStatus} from '../../frontend/design-client/src/kernel/NativeSourceSurface'
import {desktopBridge, type SourceCanvasSnapshot} from '../../frontend/design-client/src/desktop'
import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {KernelClient, activeKernelClients} from '../../frontend/design-client/src/kernel/client'
import {renderRuntimeEvidence, renderDeviceEvidence} from '../../frontend/design-client/src/kernel/runtime-evidence'
import {evaluateReport, countRenderStalls, sameCamera, imageName} from './report-contract.mjs'
import {evaluateStrict,canReusePresented} from './strict-report.mjs'

type Camera = {x:number;y:number;zoom:number}
type Row = {id:string;start:number;target:Camera;active:number;requests:any[];presentations:any[];tiles:any[];errors:string[];stalls:any[];inputs:any[];[key:string]:any}
const delay = (ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const original = KernelClient.prototype.renderSource
const owners = new WeakMap<KernelClient, Row>(), wrapped = new WeakSet<KernelClient>()
let current:Row|undefined
const numeric = (v:any) => Object.fromEntries(Object.entries(v).filter(([,x]) => ['number','boolean','string'].includes(typeof x)))
const record = (row:Row, list:any[], value:any) => {
  if (list.length < 20000) list.push(value)
  else if (!row.evidenceCapped) { row.evidenceCapped = true; row.errors.push('Evidence capacity exceeded') }
}

// Test-only instrumentation delegates every request and callback to production.
KernelClient.prototype.renderSource = function(source, options, receive, signal) {
  const row = current, at = performance.now(), tiles = options.tileViewport?.length ?? 0
  if (row) owners.set(this, row)
  if (!wrapped.has(this)) {
    wrapped.add(this)
    const next = this.onPresentation
    this.onPresentation = stats => {
      const owner = owners.get(this)
      if (owner) {
        record(owner, owner.presentations, {at:performance.now(), ...numeric(stats), presented:stats.presented})
        if (stats.error) owner.errors.push(String(stats.error))
      }
      next?.(stats)
    }
  }
  if (row && tiles) {row.active++; row.maxActive = Math.max(row.maxActive, row.active)}
  return original.call(this, source, options, tile => {
    if (row) {row.firstTileAt ??= performance.now(); record(row, row.tiles, {at:performance.now(), ...numeric(tile)})}
    receive?.(tile)
  }, signal).then(result => {
    if (row) {
      if (!tiles) row.sourceReadyAt = performance.now()
      record(row, row.requests, {at, endedAt:performance.now(), tiles, wallMs:performance.now()-at, ...numeric(result)})
    }
    return result
  }, error => {
    if (row) record(row, row.requests, {at, endedAt:performance.now(), tiles, wallMs:performance.now()-at, error:String(error)})
    throw error
  }).finally(() => {
    if (row && tiles) {row.active--; if (!row.active) row.lastIdleAt = performance.now()}
  })
}

async function capture(row:Row, name:string) {
  const candidates = activeKernelClients().filter(c => owners.get(c) === row)
  if (candidates.length !== 1) throw Error('Ambiguous live production source client')
  const requestedAt = performance.now()
  const {bitmap, frame} = await candidates[0].captureContentBitmap()
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', {willReadFrequently:true})!
  ctx.drawImage(bitmap,0,0); bitmap.close()
  const pixels = ctx.getImageData(0,0,canvas.width,canvas.height).data
  const pixelsAvailableAt=performance.now()
  let changedPixels = 0, transparentPixels = 0
  for (let i=0;i<pixels.length;i+=4) {
    if (pixels[i+3] !== 255) transparentPixels++
    if (pixels[i]!==pixels[0] || pixels[i+1]!==pixels[1] || pixels[i+2]!==pixels[2] || pixels[i+3]!==pixels[3]) changedPixels++
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))
  const sha256 = Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')
  const response = await fetch(`/__precision_image?name=${name}`, {method:'POST',body:await canvas.convertToBlob({type:'image/png'})})
  if (!response.ok) throw Error('Pixel evidence write failed')
  return {requestedAt,pixelsAvailableAt, completedAt:performance.now(), width:canvas.width, height:canvas.height, sha256, changedPixels, transparentPixels, frame}
}

function Check() {
  const [surface,setSurface] = useState<React.ReactNode>()
  const [label,setLabel] = useState('准备 33ms / 100ms 严格回归…')
  const [summary,setSummary] = useState('')
  useEffect(() => {
    let alive=true, stopped=false, raf=0, last=performance.now()
    const tick = (now:number) => {
      if (current && now-last > 250) record(current,current.stalls,{at:now,gapMs:now-last,visible:document.visibilityState==='visible',stage:current.measurementStage})
      last=now; if(alive)raf=requestAnimationFrame(tick)
    }
    raf=requestAnimationFrame(tick)
    async function run() {
      const config = await (await fetch('/__render_fixture')).json()
      const {width,height} = config.viewport
      const report:any = {format:2,status:'running',startedAt:new Date().toISOString(),config,runtime:await renderRuntimeEvidence(),samples:[],scope:'Production native-source consistency baseline. Controlled camera props, not OS input. Readback is requested at ready but may wait for GPU.'}
      const publish = async () => {
        setSummary(JSON.stringify({status:report.status,samples:report.samples.map((r:Row)=>({id:r.id,status:r.status,stopToReadyMs:r.stopToReadyMs,error:r.error})),assessment:report.assessment,strictAcceptance:report.strictAcceptance},null,2))
        const reply = await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})
        if(!reply.ok)throw Error('Report write failed')
      }
      let opened:any
      try {
        await publish(); await initializeKernelModule()
        const bridge=desktopBridge()!.largeDocument!, at=performance.now()
        setLabel('只读导入拓扑原件，生成完整源快照…')
        opened=await bridge.open()
        if(opened.status!=='ok')throw Error(opened.message||'Import cancelled')
        const importedAt=performance.now()
        const source=await bridge.canvasSnapshot({owner:opened.owner,expectedRevision:opened.revision})
        if(source.status!=='ok')throw Error(source.message||'Snapshot failed')
        report.source={nodes:source.nodes,roots:source.roots,bounds:source.bounds,importMs:importedAt-at,snapshotMs:performance.now()-importedAt}
        if(source.roots!==config.sourceRoots || source.nodes!==config.sourceNodes)throw Error('Complete source coverage differs from frozen fixture')
        await publish()
        const camera=(zoom:number):Camera=>({zoom,x:width/2-config.worldCenter.x*zoom,y:height/2-config.worldCenter.y*zoom})
        for(let index=0; index<config.cases.length && !stopped; index++) {
          const spec=config.cases[index], bounds=source.bounds
          const fit=Math.min((width-64)/bounds.width,(height-64)/bounds.height)
          const finalTarget:Camera=spec.fit?{zoom:fit,x:(width-bounds.width*fit)/2-bounds.x*fit,y:(height-bounds.height*fit)/2-bounds.y*fit}:camera(spec.zoom)
          if(spec.offset){finalTarget.x+=spec.offset[0];finalTarget.y+=spec.offset[1]}
          const row:Row={id:spec.id,start:0,target:finalTarget,active:0,maxActive:0,requests:[],presentations:[],tiles:[],errors:[],stalls:[],inputs:[],status:'running',measurementStage:'report'}
          report.samples.push(row); await publish(); current=row; row.start=performance.now()
          let requested=spec.motion?camera(spec.initialZoom):finalTarget
          row.initialTarget={...requested}
          let lastPresented:any,lastCameraChangeAt=row.start
          let waiter:{target:Camera;resolve:(value:any)=>void;reject:(e:Error)=>void}|undefined
          const render=()=>flushSync(()=>setSurface(<NativeSourceSurface key={spec.id} source={source as SourceCanvasSnapshot} view={requested} width={width} height={height}
            onStatus={(status:NativeSourceStatus)=>{
              row.lastStatus=status
              if(status.phase==='error'){row.errors.push(status.error||'Render failure');waiter?.reject(Error(status.error||'Render failure'))}
            }}
            onPresented={(frame,complete)=>{
              row.firstVisibleAt??=performance.now()
              lastPresented={at:performance.now(),frame,complete,quality:row.presentations.findLast((p:any)=>p.presented?.presentationId===frame.presentationId)}
              if(complete&&waiter&&sameCamera(frame.view,waiter.target)&&frame.width===width&&frame.height===height&&frame.dpr===devicePixelRatio){
                const first={at:performance.now(),frame,quality:row.presentations.findLast((p:any)=>p.presented?.presentationId===frame.presentationId)}
                const w=waiter;waiter=undefined;w.resolve(first)
              }
            }}/>))
          const awaitTarget=(target:Camera)=>new Promise<any>((resolve,reject)=>{
            const sameIntent=sameCamera(requested,target)
            if(!sameIntent)lastCameraChangeAt=performance.now()
            row.effectiveFinalInputAt=lastCameraChangeAt
            if(sameIntent&&canReusePresented(lastPresented,target,lastCameraChangeAt,row.presentations.findLast((p:any)=>p.presented)?.presented,width,height,devicePixelRatio)){
              resolve({...lastPresented,observedReadyAt:lastPresented.at,at:performance.now(),alreadyPresented:true});return
            }
            const timer=setTimeout(()=>{waiter=undefined;reject(Error('Fixed observation timeout'))},config.timeoutMs)
            waiter={target:{...target},resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);waiter=undefined;reject(error)}}
            requested={...target};render()
          })
          try {
            row.measurementStage='render';setLabel(`${index+1}/${config.cases.length} · ${spec.id}`)
            let ready:any
            if(spec.motion) {
              const warm=await awaitTarget(requested)
              row.warmReadyMs=warm.at-row.start;row.motionStartedAt=performance.now();row.measurementStage='motion'
              for(let step=1;step<=config.motion.steps;step++) {
                const f=step/config.motion.steps, triangle=f<=.5?2*f:2*(1-f)
                const previous=requested
                requested=spec.motion==='pan'?{...camera(spec.initialZoom),x:camera(spec.initialZoom).x+Math.sin(f*Math.PI*2)*config.motion.panPixels,y:camera(spec.initialZoom).y+Math.sin(f*Math.PI*4)*64}:camera(spec.initialZoom*(config.motion.zoomPeak/spec.initialZoom)**triangle)
                const inputAt=performance.now(),changed=!sameCamera(previous,requested)
                if(changed)lastCameraChangeAt=inputAt
                row.inputs.push({at:inputAt,view:{...requested},changed});render();await delay(config.motion.intervalMs)
              }
              // A fresh target deliberately differs from the warmed return view.
              row.finalTargetAt=performance.now();row.inputs.push({at:row.finalTargetAt,view:{...finalTarget},final:true,changed:!sameCamera(requested,finalTarget)})
              ready=await awaitTarget(finalTarget)
            } else {
              row.finalTargetAt=performance.now();ready=await awaitTarget(finalTarget)
            }
            row.readyAt=ready.at;row.observedReadyAt=ready.observedReadyAt??ready.at;row.alreadyPresented=ready.alreadyPresented===true;row.readyFrame=ready.frame;row.qualityAtReady=ready.quality
            row.stopToReadyMs=row.readyAt-row.finalTargetAt
            row.sourceLoadMs=row.sourceReadyAt-row.start
            row.renderReadyMs=row.readyAt-(row.sourceReadyAt??row.start)
            row.firstVisibleMs=row.firstVisibleAt-(row.sourceReadyAt??row.start)
            row.activeAtReady=row.active
            row.measurementStage='readback';row.readyPixels=await capture(row,imageName(index,'ready'))
            row.measurementStage='drain';const drainStart=performance.now()
            while(row.active&&performance.now()-drainStart<config.drainTimeoutMs)await delay(10)
            if(row.active)throw Error('Background work did not drain within observation window')
            row.drained=true;row.tailMs=Math.max(0,(row.lastIdleAt??row.readyAt)-row.readyAt)
            row.measurementStage='quiet';await delay(config.quietMs)
            row.activeAfterQuiet=row.active
            row.measurementStage='readback';row.quietPixels=await capture(row,imageName(index,'quiet'))
            row.devices=await renderDeviceEvidence()
            row.visibleUiStalls=countRenderStalls(row.stalls)
            const quality=row.presentations.filter((p:any)=>Number.isFinite(p.maxUpscale))
            const motion=quality.filter((p:any)=>p.at>=row.motionStartedAt&&p.at<=row.readyAt)
            row.motionQuality={samples:motion.length,maxUpscale:motion.length?Math.max(...motion.map((p:any)=>p.maxUpscale)):null}
            row.status='complete'
            console.log('GPU TOPOLOGY CASE '+JSON.stringify({id:spec.id,status:row.status,renderReadyMs:row.renderReadyMs,stopToReadyMs:row.stopToReadyMs,tailMs:row.tailMs,motionMaxUpscale:row.motionQuality.maxUpscale}))
            row.measurementStage='report';await delay(350)
          } catch(error) {
            row.status='failed';row.error=String(error);row.observedMs=performance.now()-row.start
            row.visibleUiStalls=countRenderStalls(row.stalls)
            console.log('GPU TOPOLOGY CASE '+JSON.stringify({id:spec.id,status:row.status,error:row.error}))
          } finally {
            current=undefined;flushSync(()=>setSurface(undefined));await delay(500);await publish()
          }
        }
        report.assessment=evaluateReport(report,config)
        report.strictAcceptance=evaluateStrict(report,config)
        report.assessment.latency=report.strictAcceptance
        report.status=report.assessment.status!=='PASS'?'baseline-failed':report.strictAcceptance.status==='PASS'?'strict-complete':report.strictAcceptance.status==='FAIL'?'strict-failed':'strict-incomplete'
      } catch(error) {report.status='failed';report.error=String(error)}
      finally {
        current=undefined;flushSync(()=>setSurface(undefined))
        if(opened?.status==='ok')try{await desktopBridge()!.largeDocument!.close({owner:opened.owner,expectedRevision:opened.revision})}catch(error){report.closeError=String(error)}
        report.finishedAt=new Date().toISOString();setLabel(`基线测试结束：${report.status}`);await publish()
        console.log('GPU TOPOLOGY_TEST_DONE '+JSON.stringify({status:report.status}))
      }
    }
    void run().catch(error=>{setLabel(String(error));console.log('GPU TOPOLOGY_TEST_DONE '+JSON.stringify({status:'harness-error',error:String(error)}))})
    return()=>{alive=false;stopped=true;cancelAnimationFrame(raf)}
  },[])
  return <main style={{fontFamily:'system-ui',padding:16,background:'#f4f5f7',minHeight:'100vh'}}>
    <h2>拓扑真实文件 · 严格目标回归</h2><p role="status">{label}</p>
    <div style={{position:'relative',width:800,height:600,overflow:'hidden',background:'#ddd'}}>{surface}</div>
    <pre style={{fontSize:11,maxHeight:180,overflow:'auto'}}>{summary}</pre>
  </main>
}
createRoot(document.getElementById('root')!).render(<Check/>)
