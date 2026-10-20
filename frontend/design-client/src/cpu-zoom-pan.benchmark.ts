// Real CPU/WASM pixels + production RenderMailbox/camera/presentation contracts.
// No DOM, browser compositing, hardware inputs, worker IPC or input-to-photon claim.
import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import init, { VectorEngine } from './generated/design-kernel/design_kernel'
import { demo, blank, defaultTextStyle } from './model'
import { zoomAt, wheelCamera } from './canvas-camera'
import { renderCpuFrame } from './kernel/cpu-frame'
import { RenderMailbox } from './kernel/render-mailbox'
import { presentationMatches } from './kernel/presentation'
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const stats = (samplesMs: number[]) => ({ samplesMs, p95Ms: [...samplesMs].sort((a,b)=>a-b)[Math.ceil(samplesMs.length*.95)-1], maxMs: Math.max(...samplesMs) })
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`
function fixture() {
  const source = demo(), d = blank('Repeated production demo: CPU camera stress')
  d.id=uuid(1);d.pages[0].id=uuid(2);d.schemaVersion = source.schemaVersion; d.rasterProfile = 'analytic'
  const sourceNodes = Object.values(source.nodes), copies = Math.ceil(3000/sourceNodes.length)
  for (let c=0; c<copies; c++) {
    const ids = new Map(sourceNodes.map((n,i)=>[n.id, uuid(100+c*sourceNodes.length+i)]))
    sourceNodes.forEach((n,i)=> {
      const copy = structuredClone(n); copy.id = ids.get(n.id)!; copy.children = n.children.map(id=>ids.get(id)!)
      if (source.pages[0].children.includes(n.id)) { copy.transform[4] += (c%14)*1250; copy.transform[5] += Math.floor(c/14)*800; d.pages[0].children.push(copy.id) }
      if (copy.kind === 'text' && !/[^\x00-\x7f]/.test(copy.text || '')) copy.textStyle = {...defaultTextStyle(),fontId:(i+c)%2 ? 'sans' : 'serif'}
      if(process.env.CPU_ZOOM_PAN_EFFECTS === '0')copy.effects=[]
      d.nodes[copy.id] = copy
    })
  }
  return d
}
test.skipIf(process.env.CPU_ZOOM_PAN_BENCH !== '1')('real 3000+ node CPU zoom/pan pixels and latest mailbox', async () => {
  const out = process.env.CPU_ZOOM_PAN_REPORT || '../../evidence/phase/cpu-zoom-pan/results.json'
  const wasmStart = performance.now(), wasmBytes = readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm'), wasm = await init({module_or_path: wasmBytes})
  const wasmInitMs = performance.now()-wasmStart
  const fonts = ['public/fonts/NotoSansSC.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'].map(path=>({path,bytes:readFileSync(path)}))
  const resources = JSON.stringify({sans:{family:'DejaVu Sans',data:fonts[1].bytes.toString('base64')},serif:{family:'DejaVu Serif',data:fonts[2].bytes.toString('base64')}})
  const d = fixture(); d.fonts = JSON.parse(resources); const json = JSON.stringify(d), engine = new VectorEngine()
  const memory = () => ({ ...process.memoryUsage(), wasmBytes: wasm.memory.buffer.byteLength })
  const memorySamples: unknown[] = [{phase:'before-load',...memory()}], fontLoads: unknown[] = []
  try {
    const fontStart=performance.now(); engine.load_font(fonts[0].bytes); engine.load_document_fonts(resources); fontLoads.push({paths:fonts.map(f=>({path:f.path,sha256:hash(f.bytes),bytes:f.bytes.length})),coldBatchLoadMs:performance.now()-fontStart})
    const t = performance.now(); engine.load_document(json); const documentLoadMs = performance.now()-t
    const options = (view: {x:number;y:number;zoom:number}) => JSON.stringify({pageId:d.pages[0].id,width:640,height:480,transparent:false,view,rasterProfile:'analytic'})
    let view = {x:305,y:226,zoom:.1}
    const views = [view]
    for (const zoom of [.2,.4,.8,1.6,3.2,6.4,12.8,25.6,32]) { view=zoomAt(view,zoom,{x:320,y:240}); views.push(view) }
    for(let i=0;i<24;i++){ view=wheelCamera(view,{deltaX:i%2?17:-13,deltaY:i%3?9:-11,deltaMode:0},{width:640,height:480},{x:320,y:240}); views.push(view) }
    const samples: {view:typeof view;renderMs:number;sha256:string;nonUniform:boolean}[]=[]
    let latestPixels: Uint8Array = new Uint8Array(), retainedBytesMax=0
    for(const [i,v] of views.entries()) {
      console.log('CPU_FRAME_START',i,JSON.stringify(v)); const begin=performance.now(); let pixels:Uint8Array; try {pixels=renderCpuFrame(engine,options(v),undefined)} catch(error){mkdirSync(out.slice(0,out.lastIndexOf('/')),{recursive:true});writeFileSync(out,JSON.stringify({buildProfile:process.env.CPU_ZOOM_PAN_PROFILE || 'scalar-dev-correctness-only',status:'render-failure',failedFrame:i,failedView:v,failedRenderMs:performance.now()-begin,error:String(error),completedRenderStats:stats(samples.map(s=>s.renderMs)),timingMode:process.env.CPU_ZOOM_PAN_TIMING_MODE || 'contention-uncontrolled correctness run',nodeCount:Object.keys(d.nodes).length,samples,fontLoads,memorySamples,compositingLedger:JSON.parse(engine.compositing_ledger()),wasmSha256:hash(wasmBytes)},null,2));throw error} const renderMs=performance.now()-begin
      let nonUniform=false; for(let p=4;p<pixels.length;p+=4) if(pixels[p]!==pixels[0]||pixels[p+1]!==pixels[1]||pixels[p+2]!==pixels[2]){nonUniform=true;break}
      expect(pixels.length).toBe(640*480*4); expect(nonUniform).toBe(true)
      latestPixels=pixels; retainedBytesMax=Math.max(retainedBytesMax,pixels.byteLength)
      samples.push({view:v,renderMs,sha256:hash(pixels),nonUniform}); memorySamples.push({phase:`frame-${i}`,...memory()})
    }
    // Burst submissions use the actual production mailbox. A controlled async
    // completion boundary represents a worker return, not browser input timing.
    const mailbox=new RenderMailbox(), settlements:number[]=[], burstRows:unknown[]=[]
    let epoch=0, rendered=0,cancelled=0,rejectedStale=0,accepted=0,maxQueuedJobs=0
    const presentation=(v:typeof view)=>({document:d,pageId:d.pages[0].id,epoch:1,width:640,height:480,pixelRatio:1,view:v,rasterProfile:'analytic' as const})
    for(let burst=0;burst<6;burst++) {
      let release!:()=>void, started!:()=>void
      const gate=new Promise<void>(r=>release=r), began=new Promise<void>(r=>started=r)
      const oldView=views[burst], oldEpoch=++epoch
      const old=mailbox.run(()=>epoch===oldEpoch,async()=>{rendered++; const pixels=renderCpuFrame(engine,options(oldView),undefined); started(); await gate; return {pixels,view:oldView}})
      await began
      let requested=oldView; const pending:Promise<unknown>[]=[]; let lastSubmitted=performance.now()
      for(let i=0;i<40;i++) {
        const n=++epoch; requested=views[10+((i+burst*3)%24)]; const v=requested; lastSubmitted=performance.now()
        pending.push(mailbox.run(()=>epoch===n,async()=>{rendered++;return {pixels:renderCpuFrame(engine,options(v),undefined),view:v}}).then(result=>{
          if(presentationMatches(presentation(result.view),presentation(requested))) {accepted++; latestPixels=result.pixels;settlements.push(performance.now()-lastSubmitted)} else rejectedStale++
        }).catch(e=>{expect(String(e)).toContain('PREVIEW_CANCELLED');cancelled++}))
        maxQueuedJobs=Math.max(maxQueuedJobs,(mailbox as unknown as {queued:unknown[]}).queued.length);expect(maxQueuedJobs).toBeLessThanOrEqual(1)
      }
      release(); const stale=await old
      expect(presentationMatches(presentation(stale.view),presentation(requested))).toBe(false); rejectedStale++
      await Promise.all(pending)
      const fresh=new VectorEngine(); try { fresh.load_font(fonts[0].bytes);fresh.load_document_fonts(resources);fresh.load_document(json); const reference=fresh.render_rgba(options(requested));expect(Buffer.compare(Buffer.from(latestPixels),Buffer.from(reference))).toBe(0);burstRows.push({burst,latestView:requested,sha256:hash(reference),exactFreshEngineMatch:true}) }finally{fresh.free()}
      memorySamples.push({phase:`burst-${burst}`,...memory()})
    }
    const warmFontStart=performance.now();engine.load_font(fonts[0].bytes);engine.load_document_fonts(resources);const warmFontLoads={warmBatchReloadMs:performance.now()-warmFontStart}
    expect(rendered).toBe(12);expect(cancelled).toBe(234);expect(accepted).toBe(6);expect(rejectedStale).toBe(6)
    const report={buildProfile:process.env.CPU_ZOOM_PAN_PROFILE || 'scalar-dev-correctness-only',collectedAt:new Date().toISOString(),timingMode:process.env.CPU_ZOOM_PAN_TIMING_MODE || 'contention-uncontrolled correctness run',scope:'Real WASM CPU pixels and production RenderMailbox/camera/presentation contracts. No browser, physical-input, actual worker IPC, compositor, human interactivity or input-to-photon validation. Running work is not interrupted; only queued obsolete work cancels. Cold means fresh VectorEngine font/document load; process/module may already be initialized by Vitest setup.',fixture:process.env.CPU_ZOOM_PAN_EFFECTS === '0' ? 'Production model.demo() repeated with effects explicitly removed as a separate control; retains gradients/text/shapes/hierarchy' : 'Production model.demo() repeated without stripping shadows/glass/noise/gradients/text',nodeCount:Object.keys(d.nodes).length,viewport:{width:640,height:480},wasmSha256:hash(wasmBytes),wasmInitMs,documentSha256:hash(json),documentLoadMs,fontLoads,warmFontLoads,render:stats(samples.map(s=>s.renderMs)),firstFrameMs:samples[0].renderMs,zoom:stats(samples.slice(0,10).map(s=>s.renderMs)),pan3200:stats(samples.slice(10).map(s=>s.renderMs)),samples,latestQueueSettlement:stats(settlements),queueTimingNote:'From latest CPU mailbox submission to exact returned pixels, with prior render already complete behind a release gate. Does not include residual time of running CPU work or actual browser input/IPC.',rendered,cancelled,rejectedStale,accepted,maxQueuedJobs,burstRows,retainedLatestPixelBytesMax:retainedBytesMax,memorySamples,memoryNote:'RSS/heap/WASM samples include test and reference engines. WASM allocator may retain high-water pages after free. Queue bounds asserted through exact work/cancellation counts; no claim of global bounded memory or browser blanking. Every sampled frame is nonuniform and correct length; latest outputs equal fresh CPU render.'}
    mkdirSync(out.slice(0,out.lastIndexOf('/')),{recursive:true});writeFileSync(out.replace(/\.json$/,'.rgba'),latestPixels);writeFileSync(out,JSON.stringify(report,null,2));console.log('CPU_ZOOM_PAN_REPORT',out,JSON.stringify({nodeCount:report.nodeCount,render:report.render,latestQueueSettlement:report.latestQueueSettlement}))
  } finally {engine.free()}
}, 600_000)
