import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const root=process.cwd(),[source,out]=process.argv.slice(2)
if(!source||!out||!path.isAbsolute(source)||!path.isAbsolute(out))throw Error('Absolute source and fresh output required')
const clientRequire=createRequire(path.join(root,'frontend/design-client/package.json'))
const {_electron,expect}=clientRequire('@playwright/test')
const electron=createRequire(path.join(root,'frontend/design-desktop/package.json'))('electron')
const products=path.join(root,'frontend/design-desktop/dist'),hash=b=>createHash('sha256').update(b).digest('hex')
const sourceHash=hash(await fs.readFile(source)),build=JSON.parse(await fs.readFile(path.join(products,'build-manifest.json'),'utf8'))
const drift=[];for(const [file,sha] of Object.entries(build.sources))if(hash(await fs.readFile(path.join(root,file)))!==sha)drift.push(file)
if(drift.some(file=>!file.includes('.test.')))throw Error('Runtime source/build mismatch: '+drift.join(','))
await fs.mkdir(out);await fs.mkdir(path.join(out,'profiles'))
const host=path.join(out,'host');await fs.mkdir(host);await fs.cp(path.join(root,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
const main=path.join(host,'src/main.mjs');await fs.writeFile(main,(await fs.readFile(main,'utf8')).replace('backgroundThrottling: !renderCheck','backgroundThrottling: false').replace('ownedWindow.show()','ownedWindow.showInactive()'))
await fs.symlink(products,path.join(host,'dist'));await fs.symlink(path.join(root,'frontend/design-desktop/assets'),path.join(host,'assets'))
await fs.writeFile(path.join(host,'package.json'),JSON.stringify({type:'module',main:'src/investigation-launch.mjs'}))
await fs.writeFile(path.join(host,'src/investigation-launch.mjs'),`import {NativePreparation} from './preparation.mjs';
const original=NativePreparation.prototype.request;
NativePreparation.prototype.request=function(input){const at=Date.now(),start=performance.now();let options;
if(input.method==='compile_gpu_packet')try{const o=JSON.parse(input.args[0]);options={width:o.width,height:o.height,view:o.view,gpuViewport:o.gpuViewport,captureViewport:o.captureViewport,paintRoots:o.paintRoots}}catch{}
return original.call(this,input).then(reply=>{if(['compile_gpu_packet','load_document','load_source_snapshot','apply_interaction_transforms','apply_document_patch_with_damage','derive_document_v1'].includes(input.method))console.log('QA_PREPARATION '+JSON.stringify({at,method:input.method,lane:input.lane,options,argumentBytes:typeof input.args?.[0]==='string'?input.args[0].length:undefined,wallMs:performance.now()-start,error:reply.error,stats:reply.compileStats}));return reply})};await import('./main.mjs');`)
const env={...process.env,TMPDIR:path.join(out,'profiles'),CORE_RENDER_DIAGNOSTICS:'1'};delete env.ELECTRON_RUN_AS_NODE
const report={status:'running',source,sourceHash,builtAt:build.builtAt,profile:build.profile,scriptSha256:hash(await fs.readFile(new URL(import.meta.url))),nonRuntimeDrift:drift,cases:[],errors:[]}
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
let app,page
const mode=process.env.QA_MODE||'full'
report.mode=mode;report.navigationSelection=process.env.QA_NAV_SELECTION||'root'
async function stage(name,run){report.stage=name;await persist();const start=performance.now();try{const data=await run();report.cases.push({name,status:'complete',wallMs:performance.now()-start,...data})}catch(error){report.cases.push({name,status:'failed',wallMs:performance.now()-start,error:String(error)});throw error}finally{await persist();console.log(name)}}
async function settle(timeout=120000){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForFunction(()=>{const p=document.querySelector('.kernel-presentation'),v=window.__qaEditor?.effectiveView();return !!document.querySelector('.kernel-status.error')||p?.getAttribute('data-presentation-ready')==='true'&&(!v||['x','y','zoom'].every(k=>Math.abs(Number(p.getAttribute('data-camera-'+k))-v[k])<1e-8))},null,{timeout});const errors=await page.locator('.kernel-status.error').allTextContents();if(errors.length)throw Error(errors.join('; '))}
async function state(){return page.evaluate(()=>{
 const editor=window.__qaEditor,p=document.querySelector('.kernel-presentation'),stats=document.querySelector('[data-compile-ms]')
 return {at:performance.now(),timeOrigin:performance.timeOrigin,view:editor?.state.view,selection:editor?.state.selection,hover:editor?.state.hover,presentation:p?{...p.dataset}:null,stats:stats?{...stats.dataset}:null,
  previewTiming:editor?.lastPreviewTiming,canvasData:{...document.querySelector('[data-testid=canvas]')?.dataset},interactions:[...document.querySelectorAll('[data-interaction-mode],[data-interaction-active]')].map(n=>({...n.dataset})),status:[...document.querySelectorAll('.kernel-status')].map(n=>n.textContent)}
})}
async function beginRecord(){await page.evaluate(()=>{window.__qaSamples=[];window.__qaEvents=[];window.__qaLong=[];window.__qaWork=[];window.__qaRecording=true;let previous=performance.now();const tick=now=>{if(!window.__qaRecording)return;const p=document.querySelector('.kernel-presentation'),e=window.__qaEditor;window.__qaSamples.push({at:now,gap:now-previous,view:{...e.state.view},camera:p?{x:p.dataset.cameraX,y:p.dataset.cameraY,zoom:p.dataset.cameraZoom,vx:p.dataset.visualCameraX,vy:p.dataset.visualCameraY,ready:p.dataset.presentationReady}:null});previous=now;requestAnimationFrame(tick)};requestAnimationFrame(tick)})}
async function endRecord(name){const data=await page.evaluate(()=>{window.__qaRecording=false;return {frames:window.__qaSamples,events:window.__qaEvents,longTasks:window.__qaLong,worker:window.__qaWork}});await fs.writeFile(path.join(out,name+'.json'),JSON.stringify(data));const gaps=data.frames.map(f=>f.gap).sort((a,b)=>a-b);return {frames:gaps.length,gapP95:gaps[Math.floor(gaps.length*.95)],gapMax:gaps.at(-1),longTasks:data.longTasks.length,events:data.events.length,workerMessages:data.worker.length}}
try{
 await stage('launch',async()=>{
  app=await _electron.launch({executablePath:electron,args:[host,'--desktop-isolated-profile'],cwd:root,env,chromiumSandbox:true,timeout:60000})
  for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',b=>{void fs.appendFile(path.join(out,'host.log'),b)})
  page=await app.firstWindow();page.setDefaultTimeout(30000)
  page.on('pageerror',e=>report.errors.push(String(e)))
  page.on('console',m=>{if(['error','warning'].includes(m.type()))void fs.appendFile(path.join(out,'console.log'),m.text()+'\n')})
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.setTitle('FIG navigation investigation');w.showInactive();w.blur()})
  const observe=()=>{
   window.__qaRecording=false;window.__qaWork=[]
   const original=Worker.prototype.postMessage,seen=new WeakSet()
   const record=(kind,data)=>{if(!window.__qaRecording||window.__qaWork.length>=6000)return;const value={at:performance.now(),kind};for(const key of ['id','command','type','channel','backend','ms','compileMs','graphMs','finishMs','pipelineWallMs','preparationWaitMs','drawCalls','error','sequence','ok'])if(['string','number','boolean'].includes(typeof data?.[key]))value[key]=data[key];if(data?.options?.view)value.view=data.options.view;if(data?.presentation){const p=data.presentation;value.presentation={view:p.presented?.view,epoch:p.presented?.epoch,frames:p.compositorFrames,sequence:p.sequence,coverageDeferred:p.coverageDeferred,qualityReady:p.qualityReady,residentSample:p.residentSample?{sequence:p.residentSample.sequence,total:p.residentSample.total,needsRebase:p.residentSample.needsRebase}:undefined}}if(data?.frame?.view)value.displayView=data.frame.view;if(data?.transforms)value.poseIds=Object.keys(data.transforms);window.__qaWork.push(value)}
   Worker.prototype.postMessage=function(data,...rest){if(!seen.has(this)){seen.add(this);this.addEventListener('message',event=>record('reply',event.data))}record('send',data);return original.call(this,data,...rest)}
   for(const name of ['wheel','pointerdown','pointermove','pointerup'])document.addEventListener(name,event=>{if(window.__qaRecording&&event.target?.closest?.('[data-testid=canvas]'))window.__qaEvents.push({at:performance.now(),type:name,trusted:event.isTrusted,x:event.clientX,y:event.clientY,dx:event.deltaX,dy:event.deltaY,ctrl:event.ctrlKey,meta:event.metaKey,selection:window.__qaEditor?.state.selection?.slice()})},true)
   try{new PerformanceObserver(list=>{if(window.__qaRecording)for(const e of list.getEntries())window.__qaLong.push({at:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch{}
  }
  await page.waitForURL(/^design-app:/,{waitUntil:'domcontentloaded',timeout:60000});await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  await page.addInitScript(observe);await page.evaluate(observe)
  return {gpu:await app.evaluate(({app})=>app.getGPUFeatureStatus())}
 })
 await stage('import-and-targets',async()=>{
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
  await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(path.basename(source,'.fig'),{timeout:180000});await settle()
  const result=await page.evaluate(()=>{
   const el=document.querySelector('[data-testid=canvas]'),key=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));let f=el[key],editor
   while(f){if(f.memoizedProps?.editor?.state){editor=f.memoizedProps.editor;break}f=f.return}
   if(!editor)throw Error('Canvas Editor owner not found');window.__qaEditor=editor
   const d=editor.state.doc,entries=editor.entries(),page=d.pages.find(p=>p.id===editor.state.page),roots=page.children.map(id=>d.nodes[id])
   const board=roots.find(n=>n.name==='01_Dashboard')||roots.find(n=>n.kind==='frame')||roots[0]
   window.__qaBoard=board.id;window.__qaImportView={...editor.state.view}
   const found=[]
   for(const entry of entries){const n=d.nodes[entry.id];if(found.length===8)break
    if(!entry.ancestors.includes(board.id)||n.children.length||!['rectangle','ellipse','text'].includes(n.kind)||n.locked||n.width<12||n.height<12)continue
    const point={x:entry.bounds.x+entry.bounds.width/2,y:entry.bounds.y+entry.bounds.height/2}
    editor.select([]);const hover=editor.hoverHit(point,undefined,1),ordinary=editor.selectionHit(point,false,undefined,1),deep=editor.selectionHit(point,true,undefined,1)
    if(hover!==n.id||deep!==n.id)continue
    editor.select([n.id]);const selected=editor.selectionHit(point,false,undefined,1)
    found.push({id:n.id,name:n.name,kind:n.kind,point,hover,ordinary,deep,selected,ancestors:entry.ancestors.map(id=>({id,name:d.nodes[id].name,kind:d.nodes[id].kind,clip:d.nodes[id].clip,blend:d.nodes[id].blend,layout:d.nodes[id].layout,instance:!!d.nodes[id].instance,effects:d.nodes[id].effects.filter(e=>e.visible).map(e=>e.kind)}))})
   }
   if(!found.length)throw Error('No visible nested sample');window.__qaTarget=found[0];editor.select([])
   return {nodes:Object.keys(d.nodes).length,metadataBytes:JSON.stringify(d.designSystem||{}).length,componentNodes:Object.values(d.nodes).filter(n=>n.component||n.instance||n.instanceOrigin).length,filteredNodes:Object.values(d.nodes).filter(n=>n.effects.some(e=>e.visible)).length,page:page.id,roots:roots.length,board:{id:board.id,name:board.name},importView:window.__qaImportView,colorManagement:d.colorManagement,profile:d.rasterProfile,targets:found}
  });await page.screenshot({path:path.join(out,'import.png')});return result
 })
 for(const variant of mode==='nav'?[]:mode==='profile'?['inside','outside','preserve']:['direct','outside']){const selected=variant!=='direct';await stage('drag-'+variant,async()=>{
  await page.evaluate(selected=>{const e=window.__qaEditor,p=window.__qaTarget.point,c=document.querySelector('[data-testid=canvas]');e.select(selected?[window.__qaTarget.id]:[]);e.set({view:{x:c.clientWidth/2-p.x,y:c.clientHeight/2-p.y,zoom:1}})},selected);await settle()
  const before=await page.evaluate(()=>{const e=window.__qaEditor;window.__qaBefore=e.state.doc;return {selection:e.state.selection,target:window.__qaTarget.id}})
  const box=await page.getByTestId('canvas').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2
  await page.mouse.move(x,y);await beginRecord();let profiler;if(mode==='profile'&&variant==='outside'){profiler=await page.context().newCDPSession(page);await profiler.send('Profiler.enable');await profiler.send('Profiler.start')}await page.mouse.down();if(variant==='preserve')await page.keyboard.down('Space')
  const picked=await page.evaluate(()=>window.__qaEditor.state.selection.slice())
  const parentChecks=[];for(let i=1;i<=16;i++){await page.mouse.move(x+(variant==='inside'?8:80)*i/16,y+(variant==='inside'?0:40)*i/16);await page.waitForTimeout(16);parentChecks.push(await page.evaluate(()=>({at:performance.now(),timing:window.__qaEditor.lastPreviewTiming,canvas:{...document.querySelector('[data-testid=canvas]').dataset}})))}
  if(variant==='preserve')await page.keyboard.up('Space');await page.mouse.up();if(profiler){const {profile}=await profiler.send('Profiler.stop');await fs.writeFile(path.join(out,'child-drag.cpuprofile'),JSON.stringify(profile));await profiler.detach()}const stopped=performance.now();await settle();const readyMs=performance.now()-stopped
  const changes=await page.evaluate(()=>{const a=window.__qaBefore,b=window.__qaEditor.state.doc;return Object.keys(a.nodes).filter(id=>b.nodes[id]&&(a.nodes[id].transform.some((v,i)=>v!==b.nodes[id].transform[i])||a.nodes[id].width!==b.nodes[id].width||a.nodes[id].height!==b.nodes[id].height)).map(id=>({id,name:a.nodes[id].name,before:a.nodes[id].transform,after:b.nodes[id].transform}))})
  const trace=await endRecord('drag-'+variant+'-trace');await page.screenshot({path:path.join(out,selected?'selected-drag.png':'direct-drag.png')})
  await page.getByTestId('canvas').focus();await page.keyboard.press('Meta+z');await settle()
  return {before,picked,changes,readyMs,trace,parentChecks,state:await state()}
 })}

 if(mode==='nav')for(const worker of page.workers())await worker.evaluate(()=>{
  if(typeof GPUQueue==='undefined')return
  globalThis.__qaGpu={waits:[],ticks:[],submissions:0,started:performance.now(),timeOrigin:performance.timeOrigin};let lastProbe=-Infinity,lastTick=performance.now()
  const original=GPUQueue.prototype.submit
  GPUQueue.prototype.submit=function(...args){const result=original.apply(this,args),now=performance.now();globalThis.__qaGpu.submissions++
   if(now-lastProbe>=250){lastProbe=now;const serial=globalThis.__qaGpu.submissions;this.onSubmittedWorkDone().then(()=>{if(globalThis.__qaGpu.waits.length<500)globalThis.__qaGpu.waits.push({at:now,ms:performance.now()-now,serial})},()=>{})}
   return result}
  const tick=()=>{const now=performance.now();if(globalThis.__qaGpu.ticks.length<2000)globalThis.__qaGpu.ticks.push({at:now,gap:now-lastTick});lastTick=now;setTimeout(tick,50)};tick()
 }).catch(()=>{})
 await page.evaluate(selected=>{window.__qaNavigationSelected=selected},mode==='nav'?(process.env.QA_NAV_SELECTION||'root'):'none')
 for(const zoom of mode==='profile'?[]:mode==='nav'?[.0625]:[1,.25,.0625])await stage('pan-'+zoom,async()=>{
  await page.evaluate(zoom=>{const e=window.__qaEditor,p=window.__qaTarget.point,c=document.querySelector('[data-testid=canvas]');e.select(window.__qaNavigationSelected==='root'?[window.__qaBoard]:window.__qaNavigationSelected==='leaf'?[window.__qaTarget.id]:[]);e.set({view:{x:c.clientWidth/2-p.x*zoom,y:c.clientHeight/2-p.y*zoom,zoom}})},zoom);await settle()
  const b=await page.getByTestId('canvas').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  await beginRecord();const start=performance.now()
  for(const sign of [1,-1])for(let i=0;i<16;i++){await page.mouse.wheel(sign*20,0);await page.waitForTimeout(16)}
  const inputMs=performance.now()-start,stop=performance.now();await settle();const readyMs=performance.now()-stop
  await page.waitForTimeout(500);const trace=await endRecord('pan-'+zoom+'-trace');return {inputMs,readyMs,trace,state:await state()}
 })
 if(mode!=='profile')await stage('quiet-and-resumed-zoom',async()=>{
  await beginRecord();await page.waitForTimeout(10000);const quiet=await state(),b=await page.getByTestId('canvas').boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  const start=performance.now();await page.keyboard.down('Control')
  for(const sign of [-1,1])for(let i=0;i<(mode==='nav'?(sign===-1?48:24):16);i++){await page.mouse.wheel(0,sign*35);await page.waitForTimeout(16)}
  await page.keyboard.up('Control');const inputMs=performance.now()-start,stop=performance.now();await settle();const readyMs=performance.now()-stop
  const trace=await endRecord('quiet-resume-trace');await page.screenshot({path:path.join(out,'after-zoom.png')});return {quiet,inputMs,readyMs,trace,state:await state()}
 })
 if(mode==='nav'){const probes=[];for(const worker of page.workers()){const data=await worker.evaluate(()=>globalThis.__qaGpu||null).catch(()=>null);if(data)probes.push({url:worker.url(),...data})}await fs.writeFile(path.join(out,'gpu-queue-probes.json'),JSON.stringify(probes))}
 report.status='completed-analysis-replay'
}catch(error){report.status='failed';report.error=String(error);if(page&&!page.isClosed()){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await state().catch(()=>null),null,2));if(await page.evaluate(()=>!!window.__qaSamples).catch(()=>false))await endRecord('failure-trace').catch(()=>{})}}
finally{report.sourceUnchanged=hash(await fs.readFile(source))===sourceHash;await persist();if(app){const child=app.process();await Promise.race([app.close(),new Promise(r=>setTimeout(r,10000))]);if(child.exitCode===null)child.kill('SIGTERM')}}
console.log(JSON.stringify({status:report.status,error:report.error,out}));if(report.status==='failed')process.exitCode=1
