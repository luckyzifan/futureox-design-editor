import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { KernelSurface } from './Surface'
import { initializePicking } from './picking'
import { scene, unionBounds } from '../geometry'
import type { DesignDocument } from '../model'
import { effect } from '../model'
import type { GpuMoveControl } from './interaction-layers'
import { captureContentPlane } from './content-plane'
import { RenderProfilePanel } from '../RenderProfilePanel'
import { renderRuntimeEvidence, renderDeviceEvidence } from './runtime-evidence'
if (new URLSearchParams(location.search).has('profile')) {
  const panel=document.createElement('div'); document.body.appendChild(panel)
  createRoot(panel).render(<RenderProfilePanel />)
}
const output = document.querySelector('#results')!,
  host = document.querySelector<HTMLElement>('#canvas')!
const report: { status: string; stages: unknown[]; error?: string; runtime?: unknown } = {
  status: 'running',
  stages: [],
}
const publish = () => {
  // Per-pass timestamp rows can exceed the local report's 4 MiB cap when
  // repeated in every stage. Keep per-pose scalar timings and the twelve
  // largest pass groups; the live profiler still exposes the complete trace.
  const snapshot = JSON.parse(JSON.stringify(report, (key, value) => key === 'interactionTrace' && typeof value === 'string'
    ? JSON.stringify(JSON.parse(value).map((row: {passTimings?: unknown[]}) => ({...row,
      ...(row.passTimings ? {passTimings: row.passTimings.slice(0,12)} : {})}))) : value))
  output.textContent = JSON.stringify(snapshot, null, 2)
  void fetch(new URLSearchParams(location.search).has('continuous') ? '/__render_report_interaction' : '/__render_report',
    { method: 'POST', body: JSON.stringify(snapshot) })
}
const frame = () => new Promise<number>(requestAnimationFrame)
try {
  report.runtime = await renderRuntimeEvidence()
  await initializePicking()
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document required')
  const input = await response.json(),
    loaded: DesignDocument = input.document || input
  let doc = loaded
  const prefixCase = new URLSearchParams(location.search).has('prefix')
  const rootIndex=prefixCase?2:Number(new URLSearchParams(location.search).get('root'))||1
  // Preserve the imported artwork while exercising dependencies absent from
  // this UI kit: overlap two real boards and add an external backdrop blur.
  if (new URLSearchParams(location.search).has('dependent')) {
    const roots = loaded.pages[0].children, moving = loaded.nodes[roots[rootIndex]], behind = loaded.nodes[roots[0]]
    const blur = effect(new URLSearchParams(location.search).has('glass') ? 'glass' : 'background-blur'); blur.radius = 8
    const middle = loaded.nodes[roots[1]]
    doc = { ...loaded, schemaVersion: blur.kind==='glass' && loaded.schemaVersion<5 ? 5 : loaded.schemaVersion, nodes: { ...loaded.nodes,
      ...(prefixCase ? { [middle.id]: {...middle, transform:[...middle.transform.slice(0,4),behind.transform[4]+60,behind.transform[5]+40] as typeof middle.transform} } : {}),
      [moving.id]: { ...moving, blend: 'multiply',
      ...(new URLSearchParams(location.search).has('translucent') ? {fills:moving.fills.map(p=>({...p,opacity:p.opacity*.2}))} : {}),
      transform: [...moving.transform.slice(0, 4), behind.transform[4] + 120, behind.transform[5] + 80] as typeof moving.transform,
      effects: [...moving.effects, blur] } } }
  }
  // Explicit diagnostic profile; the imported fixture itself is never rewritten.
  if(new URLSearchParams(location.search).has('hq'))doc={...doc,rasterProfile:'figma'}
  const
    page = doc.pages[0],
    entries = scene(doc, page.id),
    rootId = page.children[rootIndex] || page.children[0],
    nested = new URLSearchParams(location.search).has('nested'),
    nestedTarget = entries.filter(entry => entry.ancestors.includes(rootId) && doc.nodes[entry.id].kind === 'text')
      .sort((a, b) => doc.nodes[b.id].fontSize - doc.nodes[a.id].fontSize)[0],
    id = nested ? nestedTarget?.id : rootId
  if(!id)throw Error('Real document has no nested text target')
  const selection = new URLSearchParams(location.search).has('all') ? [...page.children] : [id]
  const bounds = unionBounds(
      entries
        .filter((e) => e.depth === 0)
        .map((e) => e.bounds),
    ),
    width = Number(new URLSearchParams(location.search).get("w")) || 1000,
    height = Number(new URLSearchParams(location.search).get("h")) || 640
  const zoom =
    Number(new URLSearchParams(location.search).get('zoom')) ||
    Math.min((width * 0.85) / bounds.width, (height * 0.85) / bounds.height)
  const selected = doc.nodes[id], cameraNode=doc.nodes[rootId],
    center = {
      x: nested ? nestedTarget.bounds.x + nestedTarget.bounds.width / 2 : cameraNode.transform[4] + cameraNode.width / 2,
      y: nested ? nestedTarget.bounds.y + nestedTarget.bounds.height / 2 : cameraNode.transform[5] + cameraNode.height / 2,
    }
  const query = new URLSearchParams(location.search)
  if(query.has('cx'))center.x=Number(query.get('cx'))
  if(query.has('cy'))center.y=Number(query.get('cy'))
  const view = { x: width / 2 - center.x * zoom, y: height / 2 - center.y * zoom, zoom }
  Object.assign(host.style, {
    position: 'relative',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
  })
  const root = createRoot(host),
    control: { current: GpuMoveControl | null } = { current: null }
  let active = false,
    settled = doc
  const chrome = (document:DesignDocument) => {
    if(!new URLSearchParams(location.search).has('overlay'))return undefined
    const selectedEntries=scene(document,page.id).filter(e=>selection.includes(e.id)), box=unionBounds(selectedEntries.map(e=>e.bounds))
    return {document,pageId:page.id,epoch:1,commands:{pixelGrid:false,
      transforms:Object.fromEntries(selection.map(id=>[id,document.nodes[id].transform])),
      selection:{corners:[{x:box.x,y:box.y},{x:box.x+box.width,y:box.y},{x:box.x+box.width,y:box.y+box.height},{x:box.x,y:box.y+box.height}],handles:false,owners:selection},
      labels:selectedEntries.map(e=>({anchor:{x:e.matrix[4],y:e.matrix[5]},offset:{x:0,y:-12},text:document.nodes[e.id].name,size:11,color:'#73778b',owners:[e.id]}))}}
  }
  const render = () =>
    flushSync(() =>
      root.render(
        <KernelSurface
          overlay={chrome(settled)}
          document={settled}
          pageId={page.id}
          width={width}
          height={height}
          view={view}
          grid={false}
          overview={bounds}
          presentationEpoch={1}
          interactionPreview={active}
          interaction={{ document: settled, selection, active, epoch: 1, control, onReady() {} }}
        />,
      ),
    )
  const state = () => ({
    display: { ...host.querySelector<HTMLElement>('.kernel-compositor')?.dataset },
    tiles: { ...host.querySelector<HTMLElement>('.kernel-tiles')?.dataset },
  })
  const wait = async (predicate: () => boolean) => {
    const start = performance.now()
    while (!predicate()) {
      const s = state()
      if (s.display.interactionError) throw Error(s.display.interactionError)
      if (performance.now() - start > 120000)
        throw Error(`Interaction timed out: ${host.querySelector('.kernel-status')?.textContent}`)
      await frame()
    }
    return performance.now() - start
  }
  render()
  const readyMs = await wait(
    () => state().tiles.detailReady === 'true' && state().display.interactionReady === 'true',
  )
  report.stages.push({
    name: 'warm',
    opticalFillOpacity:doc.nodes[rootId].fills.map(p=>p.opacity),
    nodes: Object.keys(doc.nodes).length,
    zoom,
    readyMs,
    ...state(),
  })
  publish()
  active = true
  render()
  const started = performance.now(),
    trace: unknown[] = [],
    transform = selected.transform
  let finalTransform = transform
  const pixels = new URLSearchParams(location.search).has('pixels'),
    probe = document.createElement('canvas')
  probe.width = 20
  probe.height = 12
  const context = probe.getContext('2d', { willReadFrequently: true })!
  let blank = 0,
    checks = 0
  const samplePixels=()=>{
    const canvas=host.querySelector<HTMLCanvasElement>('.kernel-compositor')!
    context.clearRect(0,0,20,12);context.drawImage(canvas,0,0,20,12)
    const data=context.getImageData(0,0,20,12).data
    let content=0
    for(let j=0;j<data.length;j+=4)if(data[j+3]>0&&Math.min(data[j],data[j+1],data[j+2])<220)content++
    if(content<3)blank++
    checks++
  }
  const endDistance=Number(new URLSearchParams(location.search).get("distance"))||180
  // Pause at selected *active* poses, leaving the live interaction lease in
  // place. A separate exact surface is the oracle, not the eventual commit.
  const middleChecks: unknown[] = []
  const midOracle = new URLSearchParams(location.search).has('midOracle')
  const readContent = async (container: HTMLElement) => {
    const canvas=container.querySelector<HTMLCanvasElement>('.kernel-compositor')!
    const captured=await captureContentPlane(canvas), probe=document.createElement('canvas')
    probe.width=captured.bitmap.width;probe.height=captured.bitmap.height
    const ctx=probe.getContext('2d',{willReadFrequently:true})!
    ctx.drawImage(captured.bitmap,0,0);captured.bitmap.close()
    return {data:ctx.getImageData(0,0,probe.width,probe.height).data,probe}
  }
  const comparePose = async (step:number,dx:number,dy:number) => {
    const sequence=Number(state().display.interactionMoves)
    await wait(()=>Number(state().display.contentSequence)>=sequence)
    const moving=await readContent(host), container=document.createElement('div')
    Object.assign(container.style,{position:'fixed',left:'-20000px',top:'0px',width:`${width}px`,height:`${height}px`})
    document.body.append(container);const oracle=createRoot(container)
    const posed={...doc,nodes:{...doc.nodes,...Object.fromEntries(selection.map(id=>{
      const n=doc.nodes[id];return[id,{...n,transform:[...n.transform.slice(0,4),n.transform[4]+dx,n.transform[5]+dy] as typeof n.transform}]
    }))}}
    try {
      flushSync(()=>oracle.render(<KernelSurface document={posed} pageId={page.id} width={width} height={height}
        view={view} grid={false} overview={bounds} presentationEpoch={step+10}/>))
      await wait(()=>container.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady==='true')
      const fresh=await readContent(container)
      if(fresh.data.length!==moving.data.length)throw Error('Intermediate oracle dimensions changed')
      let max=0,sum=0,changed=0
      for(let i=0;i<fresh.data.length;i++){const d=Math.abs(fresh.data[i]-moving.data[i]);max=Math.max(max,d);sum+=d*d;if(d)changed++}
      const difference={max,rms:Math.sqrt(sum/fresh.data.length),changedFraction:changed/fresh.data.length}
      middleChecks.push({step,dx,dy,sequence,difference})
      for(const [name,probe] of [['live',moving.probe],['fresh',fresh.probe]] as const){
        const blob=await new Promise<Blob|null>(resolve=>probe.toBlob(resolve,'image/png'))
        if(blob)await fetch(`/__precision_image?name=pose-${step}-${name}`,{method:'POST',body:blob})
      }
      report.stages.push({name:'active pose oracle',step,dx,dy,sequence,difference});publish()
    } finally {flushSync(()=>oracle.unmount());container.remove()}
  }
  const steps=nested && !new URLSearchParams(location.search).has('continuous') ? 1 : 180
  const fixedPoses=new URLSearchParams(location.search).has('fixedPoses'),poseTimings:unknown[]=[]
  for (let i = 1; i <= steps; i++) {
    if(fixedPoses&&i!==1&&i%5!==0)continue
    await frame()
    finalTransform = [
      ...transform.slice(0, 4),
      transform[4] + (endDistance * i) / steps,
      transform[5] + 40 * Math.sin((i / steps) * Math.PI),
    ] as typeof transform
    const dx = finalTransform[4] - transform[4],
      dy = finalTransform[5] - transform[5]
    const patches = Object.fromEntries(
      selection.map((selectedId) => {
        const t = doc.nodes[selectedId].transform
        return [selectedId, { transform: [...t.slice(0, 4), t[4] + dx, t[5] + dy] as typeof t }]
      }),
    )
    if (!control.current?.apply(doc, patches)) throw Error('Interaction declined root translation')
    if(fixedPoses){
      const sequence=Number(state().display.interactionMoves)
      await wait(()=>Number(state().display.contentSequence)>=sequence)
      const rows=JSON.parse(state().display.interactionTrace||'[]')
      const {passTimings:_passTimings,...timing}=rows.at(-1)||{}
      poseTimings.push({step:i,sequence,dx,dy,...timing})
    }
    const s = state()
    trace.push({
      at: performance.now() - started,
      samples: Number(s.display.interactionSamples),
      moves: Number(s.display.interactionMoves),
      sharp: Number(s.display.sharpCoverage),
      upscale: Number(s.display.maxUpscale),
      frames: Number(s.display.compositorFrames),
      contentSequence: Number(s.display.contentSequence || 0),
    })
    if(pixels&&i%6===0)samplePixels()
    if(midOracle&&[1,60,120,180].includes(i))await comparePose(i,dx,dy)
  }
  await wait(
    () => !state().display.interactionWarming || state().display.interactionWarming === 'false',
  )
  report.stages.push({
    name: 'active motion',
    duration: performance.now() - started,
    pixels,
    blank,
    checks,
    trace,
    poseTimings,
    ...state(),
  })
  publish()
  if(midOracle)report.stages.push({name:'intermediate pose summary',checks:middleChecks})
  report.stages.push({name:'active device and transport',devices:await renderDeviceEvidence()})
  const dx = finalTransform[4] - transform[4],
    dy = finalTransform[5] - transform[5]
  settled = {
    ...doc,
    nodes: {
      ...doc.nodes,
      ...Object.fromEntries(
        selection.map((selectedId) => {
          const n = doc.nodes[selectedId]
          return [
            selectedId,
            {
              ...n,
              transform: [
                ...n.transform.slice(0, 4),
                n.transform[4] + dx,
                n.transform[5] + dy,
              ] as typeof n.transform,
            },
          ]
        }),
      ),
    },
  }
  control.current!.end(settled)
  active = false
  render()
  const commitMs = await wait(() => state().tiles.detailReady === 'true')
  report.stages.push({ name: 'commit', commitMs, damage:window.__damageLog, ...state() })
  if (blank) throw Error('Blank canvas during root motion')
  if(new URLSearchParams(location.search).has('repeat')){
    const source=settled, distance=new URLSearchParams(location.search).has('escape')?600:-75
    active=true;render()
    for(let step=1;step<=60;step++){
      await frame()
      const patches=Object.fromEntries(selection.map(id=>{const t=source.nodes[id].transform;return[id,{transform:[...t.slice(0,4),t[4]+distance*step/60,t[5]] as typeof t}]}))
      if(!control.current?.apply(source,patches))throw Error('Second gesture rejected the committed document')
      if(pixels&&step%6===0)samplePixels()
    }
    settled={...source,nodes:{...source.nodes,...Object.fromEntries(selection.map(id=>{const n=source.nodes[id];return[id,{...n,transform:[...n.transform.slice(0,4),n.transform[4]+distance,n.transform[5]] as typeof n.transform}]}))}}
    control.current!.end(settled);active=false;render()
    const commitMs=await wait(()=>state().tiles.detailReady==='true')
    report.stages.push({name:'second gesture commit',distance,commitMs,blank,checks,...state()});publish()
    if(blank)throw Error('Blank canvas during second gesture')
  }
  if(new URLSearchParams(location.search).has('oracle')){
    const read=()=>{
      const canvas=host.querySelector<HTMLCanvasElement>('.kernel-compositor')!
      const probe=document.createElement('canvas');probe.width=canvas.width;probe.height=canvas.height
      const ctx=probe.getContext('2d',{willReadFrequently:true})!
      ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,probe.width,probe.height).data
    }
    await frame();await frame()
    const incremental=read()
    flushSync(()=>root.render(<KernelSurface key="fresh-oracle" document={settled} pageId={page.id}
      overlay={chrome(settled)?{...chrome(settled)!,epoch:2}:undefined}
      width={width} height={height} view={view} grid={false} overview={bounds} presentationEpoch={2}/>))
    await wait(()=>state().tiles.detailReady==='true')
    await frame();await frame()
    const fresh=read();let max=0,sum=0,changed=0
    if(fresh.length!==incremental.length)throw Error('Oracle dimensions changed')
    for(let i=0;i<fresh.length;i++){const d=Math.abs(fresh[i]-incremental[i]);max=Math.max(max,d);sum+=d*d;if(d>0)changed++}
    const difference={max,rms:Math.sqrt(sum/fresh.length),changedFraction:changed/fresh.length}
    report.stages.push({name:'incremental damage vs fresh full viewport',difference})
    if(max>0)throw Error(`Incremental viewport differs from fresh rendering: ${JSON.stringify(difference)}`)
  }
  if(new URLSearchParams(location.search).has('idle')){
    await new Promise(resolve=>setTimeout(resolve,5000))
    const before=Number(state().display.compositorFrames)
    await new Promise(resolve=>setTimeout(resolve,2000))
    const delta=Number(state().display.compositorFrames)-before
    report.stages.push({name:'settled idle display',milliseconds:2000,submittedFrames:delta})
    if(delta!==0)throw Error('Settled canvas still submits idle display frames')
  }
  if(midOracle && middleChecks.some(row => (row as {difference:{max:number}}).difference.max > 0))
    throw Error('Intermediate pose differs from the exact current-camera render')
  report.status = 'passed'
  publish()
  if(new URLSearchParams(location.search).has('handoff')){
    const button=document.createElement('button');button.textContent='验证当前后端画面';output.before(button)
    button.onclick=async()=>{
      try{
        await wait(()=>host.querySelector<HTMLElement>('.kernel-presentation')?.dataset.presentationReady==='true')
        await frame();await frame()
        const canvas=host.querySelector<HTMLCanvasElement>('.kernel-compositor')!
        context.clearRect(0,0,20,12);context.drawImage(canvas,0,0,20,12)
        const bytes=context.getImageData(0,0,20,12).data;let content=0
        for(let i=0;i<bytes.length;i+=4)if(bytes[i+3]>0&&Math.min(bytes[i],bytes[i+1],bytes[i+2])<220)content++
        report.stages.push({name:'manual backend handoff pixels',backend:document.querySelector<HTMLSelectElement>('select[aria-label="渲染后端"]')?.value,
          contentSamples:content,surfaces:host.querySelectorAll('.kernel-tiles').length})
        if(content<3)throw Error('Backend handoff presented an empty canvas')
      }catch(error){report.status='failed';report.error=String(error)}
      publish()
    }
  }
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  publish()
}
