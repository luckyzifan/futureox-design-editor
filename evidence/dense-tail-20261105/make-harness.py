"""Extend the repository's real Electron file-input harness, without changing any pixel/readiness check."""
from pathlib import Path
import sys
repo=Path.cwd();out=Path(sys.argv[1]);src=(repo/'testing/verification-overview-zoom-20261104/replay.mjs').read_text()
src=src.replace("new URL('../verification-dense-refinement-20261104/probe.mjs',import.meta.url).href",repr((repo/'testing/verification-dense-refinement-20261104/probe.mjs').as_uri()))
needle="  }else if(process.env.OVERVIEW_ORACLE_FROM){"
pos=src.index(needle)
src=src[:pos]+'''  }else if(process.env.TAIL_CAMERA){
    const cfg=JSON.parse(await fs.readFile(process.env.TAIL_CAMERA,'utf8'))
    assert.equal(cfg.fileHash,fileHash)
    assert.equal(report.viewport.width,cfg.width);assert.equal(report.viewport.height,cfg.height)
    const setView=async v=>page.evaluate(({v,indices})=>{
      if(indices)window.__tailScope=indices
      const c=document.querySelector('[data-testid="canvas"]');let f=c[Object.keys(c).find(k=>k.startsWith('__reactFiber$'))]
      while(f){const e=f.memoizedProps?.editor;if(e?.state){e.discardPendingView();e.set({view:{x:v[0],y:v[1],zoom:v[2]}});return}f=f.return}
      throw Error('Missing editor')
    },{v,indices:process.env.TAIL_PIN==='1'?cfg.indices:undefined})
    report.fixedConfig={...cfg,pinned:process.env.TAIL_PIN==='1'};report.freshReference='fixed-density-tail'
    await record('dense-cold-view',()=>setView(cfg.camera))
    assert.deepEqual(await cam(),cfg.camera);assert(report.segments.at(-1).ready)
    await screen('dense-settled',b)
    await record('dense-pan',()=>pan(64,32));await screen('dense-shifted',b)
    await record('dense-pan-back',()=>pan(-64,-32))
    await record('dense-more-detail',()=>pinch(1.4,8))
    await record('dense-zoom-back',()=>pinch(1/1.4,8))
    // Use one exact, physically ready origin for the reversal, including its AA phase.
    if(JSON.stringify(await cam())!==JSON.stringify(cfg.camera))await record('exact-origin',()=>setView(cfg.camera))
    assert.deepEqual(await cam(),cfg.camera)
    await record('dense-inflight-return',async()=>{
      await pinch(1.7,6);await pan(-280,95);await pinch(1.18,4);await pinch(1/1.18,4);await pan(280,-95);await pinch(1/1.7,6)
      await waitFrames();report.rawEnd=await cam()
      if(JSON.stringify(report.rawEnd)!==JSON.stringify(cfg.camera))await setView(cfg.camera)
    })
    assert.deepEqual(await cam(),cfg.camera);assert(report.segments.at(-1).ready)
    await screen('dense-return',b)
'''+src[pos:]
# Timestamp actual source snapshot load/receipt and save one matching immutable scope outside timing when requested.
marker="const opening=LargeDocumentHost.prototype.openingView"
at=src.index(marker)
src=src[:at]+"""const load=NativePreparation.prototype.loadSourceSnapshot
NativePreparation.prototype.loadSourceSnapshot=async function(d){
 const t=performance.timeOrigin+performance.now(),r=await load.call(this,d)
 appendFileSync(${JSON.stringify(path.join(out,'loads.ndjson'))},JSON.stringify({t,end:performance.timeOrigin+performance.now(),nodes:d.nodes,bytes:d.store.bytes,footerHash:d.store.footerHash,scope:d.store.generation?.split('-').at(-1)})+'\\\\n')
 if(process.env.TAIL_CAPTURE && d.nodes===15604){const fs=await import('node:fs'),p=await import('node:path'),dst=p.join(process.env.TAIL_CAPTURE,'snapshot.scene')
 if(!fs.existsSync(dst)){fs.copyFileSync(d.path,dst,fs.constants.COPYFILE_FICLONE);fs.writeFileSync(p.join(process.env.TAIL_CAPTURE,'store.json'),JSON.stringify({...d,path:dst}))}}
 return r
}
"""+src[at:]
src=src.replace("observeSourceCompiles(NativePreparation,", "if(process.env.TAIL_FULL_REQUESTS){const q=NativePreparation.prototype.request;NativePreparation.prototype.request=function(v){if(v.method==='compile_gpu_packet')appendFileSync("+ "${JSON.stringify(path.join(out,'options.ndjson'))}"+",JSON.stringify({t:performance.timeOrigin+performance.now(),options:JSON.parse(v.args[0])})+'\\\\n');return q.call(this,v)}}\nobserveSourceCompiles(NativePreparation,")
src=src.replace("  const raw=await page.evaluate", "  if(process.env.TAIL_TRACE)await fs.writeFile(path.join(out,'surface-trace.json'),JSON.stringify(await page.evaluate(()=>window.__tailTrace||[])))\n  const raw=await page.evaluate")
src=src.replace("  report.open=await epoch()", """  await page.evaluate(()=>{
    const log=window.__tailTiles=[],seen=new WeakSet()
    for(const proto of [Worker.prototype,MessagePort.prototype]){
      const send=proto.postMessage
      proto.postMessage=function(...args){
        if(!seen.has(this)){seen.add(this);this.addEventListener('message',e=>{const t=e.data?.tile
          if(!t||!t.key||!Number.isFinite(t.graphMs))return
          log.push({at:performance.timeOrigin+performance.now(),request:e.data.id,key:t.key,x:t.x,y:t.y,zoom:t.zoom,
            cached:t.cached,compile:t.compileMs,graph:t.graphMs,checkpoint:t.checkpointMs,finish:t.finishMs,draws:t.drawCalls,peak:t.peakTextureBytes,
            scopeStats:t.__tailWait,phaseX:t.phaseX,phaseY:t.phaseY})
        })}
        return send.apply(this,args)
      }
    }
  })
  report.open=await epoch()""")
src=src.replace("  const raw=await page.evaluate", "  await fs.writeFile(path.join(out,'tiles.ndjson'),(await page.evaluate(()=>window.__tailTiles||[])).map(x=>JSON.stringify(x)).join('\\n')+'\\n')\n  const raw=await page.evaluate")
# Diagnostic intervention only. Replica of the historical 9.2s Vitest process.
src=src.replace("  const record=async(name,run,settle=true)=>{","  let challenge\n  const record=async(name,run,settle=true)=>{")
src=src.replace("const snapshots=process.env.OVERVIEW_GUI", """if(name==='dense-cold-view'&&process.env.TAIL_CONTEND==='1'){
      challenge=(async()=>{await new Promise(r=>setTimeout(r,3540));const start=Date.now()
        const {spawn}=await import('node:child_process'),{once}=await import('node:events')
        const logs=[],child=spawn('bun',['run','vitest','run','src/LargeDocumentWorkspace.test.tsx','src/source-material-scope.test.ts','src/source-opening-preview.test.ts'],{cwd:path.resolve('frontend/design-client'),stdio:['ignore','pipe','pipe']})
        for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>logs.push(b))
        const [code]=await once(child,'exit');await fs.writeFile(path.join(out,'challenge.log'),Buffer.concat(logs))
        report.contention={start,end:Date.now(),code,pid:child.pid};assert.equal(code,0)
      })()
    }
    const snapshots=process.env.OVERVIEW_GUI""")
src=src.replace("  const raw=await page.evaluate", "  if(challenge)await challenge\n  const raw=await page.evaluate")
# Observe all resource owners and native CPU around each compile, only on the diagnostic runs.
src=src.replace("const load=NativePreparation.prototype.loadSourceSnapshot", """if(process.env.TAIL_NATIVE_CPU){
 const {spawn,execFileSync}=await import('node:child_process'),{createInterface}=await import('node:readline')
 const native=()=>{try{return execFileSync('pgrep',['-P',String(process.pid),'design-prepare'],{encoding:'utf8'}).trim().split('\\\\n').map(Number).filter(n=>n>0)}catch{return []}}
 const meter=spawn(process.env.TAIL_NATIVE_CPU,[],{stdio:['pipe','pipe','ignore']}),waiters=[]
 createInterface({input:meter.stdout}).on('line',s=>waiters.shift()?.(JSON.parse(s)))
 const read=pid=>new Promise(done=>{waiters.push(done);meter.stdin.write(String(pid)+'\\\\n')})
 const call=NativePreparation.prototype.request,seen=new WeakMap()
 NativePreparation.prototype.request=async function(q){if(q.method!=='compile_gpu_packet')return call.call(this,q)
   const pids=seen.get(this)||native();seen.set(this,pids)
   const before=await Promise.all(pids.map(read)),start=Date.now(),result=await call.call(this,q),end=Date.now(),after=await Promise.all(pids.map(read))
   appendFileSync(${JSON.stringify(path.join(out,'native-cpu.ndjson'))},JSON.stringify({start,end,pids,before,after})+'\\\\n');return result}
}
const load=NativePreparation.prototype.loadSourceSnapshot""")
out.write_text(src)
