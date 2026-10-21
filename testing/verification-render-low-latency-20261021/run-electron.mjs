// Real visible Electron, unmodified release renderer/math, CDP sampled stacks.
import {mkdir, readFile, writeFile, appendFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const root=process.cwd(), desktop=process.env.DESIGN_DESKTOP_ROOT||path.join(root,'frontend/design-desktop');
const require=createRequire(path.join(root,'frontend/design-client/package.json'));
const {_electron,expect}=require('@playwright/test');
const [fixture,out]=process.argv.slice(2); if(!fixture||!out)throw Error('fixture output required');
await mkdir(out,{recursive:false}); await mkdir(path.join(out,'profiles'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const report={fixture:path.basename(fixture),fixtureSha256:hash(await readFile(fixture)),startedAt:new Date().toISOString(),stages:[],errors:[],scope:`${process.env.DESIGN_TEST_PASSIVE==='1'?'Passive visible window, opacity 0.01':process.env.DESIGN_TEST_HIDDEN==='1'?'Hidden':'Visible'} release Electron, sandbox retained, isolated user profile; real pointer/keyboard input through Playwright; sampled diagnostics, not physical input-to-photon or FPS acceptance.`};
await writeFile(path.join(out,'build-manifest.json'),await readFile(path.join(desktop,'dist/build-manifest.json')));
const artifacts={};for(const f of await readdir(path.join(desktop,'dist/renderer/assets'))){const relative=path.relative(root,path.join(desktop,'dist/renderer/assets',f));artifacts[relative]=hash(await readFile(path.join(root,relative)))};await writeFile(path.join(out,'runtime-artifacts.json'),JSON.stringify({captured:'before launch',artifacts},null,2));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k)));
const sampling=process.env.DESIGN_CPU_PROFILE!=='0';report.sampling=sampling;
const profileStages=(process.env.DESIGN_PROFILE_STAGES||'').split(',').filter(Boolean);report.profileStages=profileStages;
const diagnostics=process.env.DESIGN_RENDER_DIAGNOSTICS||(sampling?'detail':'0');report.diagnostics=diagnostics;
const extended=process.env.DESIGN_EXTENDED==='1';report.extendedEnabled=extended;
let app,page,phase='startup';
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
const compositorPng=async()=>Buffer.from((await page.locator('.kernel-compositor').evaluate(c=>c.toDataURL('image/png'))).split(',')[1],'base64');
try {
 const launchArgs=[desktop,'--desktop-gui-test',`--desktop-gui-test-owner=${hash(out).slice(0,16)}`,...(process.env.DESIGN_TEST_PASSIVE==='1'?['--disable-features=MacWebContentsOcclusion','--disable-backgrounding-occluded-windows','--disable-background-timer-throttling','--disable-renderer-backgrounding']:[])];
 app=await _electron.launch({executablePath:require(path.join(desktop,'node_modules/electron')),args:launchArgs,env:{...env,TMPDIR:path.join(out,'profiles'),CORE_RENDER_DIAGNOSTICS:diagnostics},chromiumSandbox:true,timeout:60000});
 await writeFile(path.join(out,'owned-test-process.json'),JSON.stringify({pid:app.process().pid,desktop,args:launchArgs,profile:path.join(out,'profiles')},null,2));
 for(const [name,stream] of [['stdout',app.process().stdout],['stderr',app.process().stderr]])stream?.on('data',d=>void appendFile(path.join(out,`host-${name}.log`),d));
 page=await app.firstWindow();page.setDefaultTimeout(20000);
 page.on('pageerror',e=>report.errors.push({phase,error:String(e)}));
 page.on('console',m=>{if(m.type()==='error')report.errors.push({phase,error:m.text()});if(m.text().startsWith('DESIGN_GPU_PROFILE'))void appendFile(path.join(out,'gpu-timestamps.jsonl'),JSON.stringify({phase,at:Date.now(),message:m.text()})+'\n')});
 await page.waitForURL(/^design-app:/);
 report.host=await app.evaluate(async({app,BrowserWindow,screen})=>{
  const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,960);
  if(process.env.DESIGN_TEST_PASSIVE==='1'){if(process.platform==='darwin')app.setActivationPolicy('accessory');w.webContents.setBackgroundThrottling(false);w.setFocusable(false);w.setIgnoreMouseEvents(true);w.setOpacity(.01);w.showInactive();w.blur()}
  else if(process.env.DESIGN_TEST_HIDDEN==='1'){w.webContents.setBackgroundThrottling(false);w.setFocusable(false);w.setIgnoreMouseEvents(true);w.hide()}
  else if(process.env.DESIGN_TEST_BACKGROUND==='1'){w.setFocusable(false);w.setIgnoreMouseEvents(true);w.showInactive()}
  else{w.show();w.focus()}
  w.setTitle('Futureox · 真实 CPU 火焰图采样');
  const debug=w.webContents.debugger;debug.attach('1.3');
  const s={debug,sessions:new Map(),pending:[],errors:[],active:false};globalThis.__profileRun=s;
  debug.on('message',(_e,method,p)=>{if(method==='Target.detachedFromTarget'){const info=s.sessions.get(p.sessionId);s.sessions.delete(p.sessionId);if(info)s.errors.push('Worker exited before profile retrieval: '+info.url);}if(method==='Target.attachedToTarget'&&p.targetInfo.type==='worker'){
    s.sessions.set(p.sessionId,p.targetInfo);
    s.pending.push((async()=>{await debug.sendCommand('Profiler.enable',{},p.sessionId);await debug.sendCommand('Profiler.setSamplingInterval',{interval:1000},p.sessionId);if(s.active)await debug.sendCommand('Profiler.start',{},p.sessionId)})().catch(e=>s.errors.push(String(e))));
  }});
  await debug.sendCommand('Profiler.enable');await debug.sendCommand('Profiler.setSamplingInterval',{interval:1000});
  await debug.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  return {versions:process.versions,prefs:w.webContents.getLastWebPreferences(),backgroundThrottling:w.webContents.getBackgroundThrottling(),passiveTest:process.env.DESIGN_TEST_PASSIVE==='1',opacity:w.getOpacity(),visible:w.isVisible(),hiddenTest:process.env.DESIGN_TEST_HIDDEN==='1',backgroundTest:process.env.DESIGN_TEST_BACKGROUND==='1',display:screen.getDisplayMatching(w.getBounds()),gpu:await app.getGPUInfo('basic'),profile:app.getPath('userData')};
 });
 await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready','true',{timeout:120000});
 if(process.env.DESIGN_TEST_HIDDEN==='1')await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.hide()});
 if(process.env.DESIGN_TEST_PASSIVE==='1')await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.showInactive();w.blur()});
 report.viewportEnvironment=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState,focus:document.hasFocus()}));
 const resume=page.getByRole('button',{name:/^继续编辑 · /});
 if(await resume.isVisible())await resume.click();
 await expect(page.locator('.local-home')).toHaveCount(0);
 const snapshot=()=>page.evaluate(()=>({at:performance.now(),presentation:{...document.querySelector('.kernel-presentation')?.dataset},tiles:{...document.querySelector('.kernel-tiles')?.dataset},compositor:{...document.querySelector('.kernel-compositor')?.dataset},errors:[...document.querySelectorAll('.kernel-status.error')].map(e=>e.textContent)}));
 const settle=async(timeout=45000)=>{
  try{await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.dataset.fallbackPhase==='pending'||(document.querySelector('.kernel-presentation')?.dataset.presentationReady==='true'&&document.querySelector('.kernel-presentation')?.dataset.previewActive==='false'&&document.querySelector('.kernel-tiles')?.dataset.detailReady==='true'),null,{timeout});}catch(e){return {ok:false,error:String(e),...await snapshot()}}
  const s=await snapshot();return {ok:!s.errors.length&&s.presentation.presentationReady==='true'&&s.presentation.previewActive==='false'&&s.presentation.fallbackPhase==='none'&&s.tiles.detailReady==='true',...s};
 };
 await settle();
 const stage=async(name,action)=>{
  phase=name;const wallStart=Date.now();console.log('START '+name);
  // Keep the original seven benchmark stages controlled by DESIGN_CPU_PROFILE.
  // Extended interaction regressions always retain their own CPU profiles.
  const profileStage=sampling||profileStages.includes(name)||(extended&&name.startsWith('extended-'));
  const nativeSamples=[];
  if(sampling&&name==='zoom-3200'){
   const processes=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n');
   for(const row of processes){const match=row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);if(match&&Number(match[2])===app.process().pid&&match[3].endsWith('/design-prepare')){
    const sample=spawn('/usr/bin/sample',[match[1],'5','2','-file',path.join(out,`native-${name}-${match[1]}.sample.txt`)],{stdio:'ignore'});
    nativeSamples.push(new Promise(resolve=>sample.on('exit',resolve)));report.nativeSample={pid:Number(match[1]),phase:name,durationSeconds:5,intervalMs:2};
   }}
  }
  if(profileStage)await app.evaluate(async()=>{const s=globalThis.__profileRun;await Promise.all(s.pending);s.active=true;await s.debug.sendCommand('Profiler.start');await Promise.all([...s.sessions.keys()].map(id=>s.debug.sendCommand('Profiler.start',{},id).catch(e=>s.errors.push(String(e)))))});
  await page.evaluate(()=>{
   const s={start:performance.now(),frames:[],longtasks:[],wheels:[],captures:[],run:true};window.__phaseTrace=s;
   s.wheel=e=>s.wheels.push({x:e.deltaX,y:e.deltaY,mode:e.deltaMode});window.addEventListener('wheel',s.wheel,{capture:true,passive:true});
   s.capture=e=>s.captures.push({at:performance.now(),type:e.type,pointerId:e.pointerId,buttons:e.buttons,target:e.target?.getAttribute?.('data-testid')});window.addEventListener('lostpointercapture',s.capture,true);
   s.observer=new PerformanceObserver(l=>{for(const e of l.getEntries())s.longtasks.push({start:e.startTime,duration:e.duration})});s.observer.observe({type:'longtask',buffered:false});
   const tick=t=>{if(!s.run)return;const p=document.querySelector('.kernel-presentation')?.dataset;const d=document.querySelector('.kernel-tiles')?.dataset;const c=document.querySelector('.kernel-compositor')?.dataset;s.frames.push([t,p?.presentationReady,p?.previewActive,d?.detailReady,p?.requestedCameraZoom,d?.viewportTilesRendered,c?.interactionSamples,c?.interactionMoves,c?.interactionError,c?.interactionActive,c?.interactionMode]);if(s.frames.length<20000)requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const start=performance.now();let actionError;try{await action()}catch(e){actionError=String(e)}
  const actionMs=performance.now()-start;
  const settled=await settle();
  const totalMs=performance.now()-start;
  const trace=await page.evaluate(()=>{const s=window.__phaseTrace;s.run=false;s.observer.disconnect();window.removeEventListener('wheel',s.wheel,true);window.removeEventListener('lostpointercapture',s.capture,true);return {start:s.start,frames:s.frames,longtasks:s.longtasks,wheels:s.wheels,captures:s.captures}});
  const profiles=profileStage?await app.evaluate(async()=>{const s=globalThis.__profileRun;s.active=false;await Promise.all(s.pending);const profiles=[];profiles.push({target:'renderer',...await s.debug.sendCommand('Profiler.stop')});for(const [id,info] of s.sessions)try{profiles.push({target:info,...await s.debug.sendCommand('Profiler.stop',{},id)})}catch(e){s.errors.push(String(e))};return {profiles,errors:s.errors}}):{profiles:[],errors:[]};
  for(let i=0;i<profiles.profiles.length;i++)await writeFile(path.join(out,`${name}-${i}.cpuprofile`),JSON.stringify(profiles.profiles[i].profile));
  await writeFile(path.join(out,`${name}-targets.json`),JSON.stringify(profiles.profiles.map(({target})=>target),null,2));
  await writeFile(path.join(out,`${name}-frames.json`),JSON.stringify(trace));
  const gaps=trace.frames.slice(1).map((f,i)=>f[0]-trace.frames[i][0]).sort((a,b)=>a-b);
  const row={name,wallStart,wallEnd:Date.now(),actionMs,totalMs,actionError,settled,raf:{count:trace.frames.length,p50:gaps[Math.floor(gaps.length*.5)],p95:gaps[Math.floor(gaps.length*.95)],max:gaps.at(-1),over50:gaps.filter(n=>n>50).length},longtasks:trace.longtasks,profilerErrors:profiles.errors};
  report.stages.push(row);await Promise.all(nativeSamples);await page.mouse.move(8,8);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(process.env.DESIGN_TEST_HIDDEN==='1'||process.env.DESIGN_TEST_PASSIVE==='1'){
   report.captureMode='actual-compositor-buffer';await writeFile(path.join(out,`${name}-canvas.png`),await compositorPng());
  }else{await page.screenshot({path:path.join(out,`${name}.png`)});await page.getByTestId('canvas').screenshot({path:path.join(out,`${name}-canvas.png`)})}
  await save();console.log(JSON.stringify({name,actionMs,totalMs,ok:settled.ok,raf:row.raf,actionError}));
  if(!name.includes('continuous-wheel')&&trace.wheels.length)throw Error(`Unexpected wheel input during ${name}: ${trace.wheels.length} events; run is contaminated`);
  if(gaps.length>4&&row.raf.p50>50)throw Error(`Native animation frames are throttled (${row.raf.p50} ms median); invalid latency workload`);
  return row;
 };
 await stage('import',async()=>{await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture);await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(path.basename(fixture).replace(/\.(sketch|fig)$/i,''),{timeout:120000});await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:120000});await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})});
 const documentName=await page.getByLabel('文档名称',{exact:true}).inputValue();report.documentName=documentName;
 const stored=()=>page.evaluate(async(name)=>{const bridge=window.coreDesktop.workspace;const list=await bridge.list();const item=list.documents.find(x=>x.name===name&&!x.deleted);if(!item)throw Error('Stored document not found '+name);const result=await bridge.open({id:item.id});if(result.status!=='ok')throw Error(result.status);return JSON.parse(result.documentJson)},documentName);
 report.adapter=await page.evaluate(async()=>{const info=(await navigator.gpu?.requestAdapter())?.info;return info&&{vendor:info.vendor,architecture:info.architecture,description:info.description}});
 const doc=await stored();report.document={nodes:Object.keys(doc.nodes).length,pages:doc.pages.length,sha256:hash(JSON.stringify(doc)),dpr:await page.evaluate(()=>devicePixelRatio)};
 if(process.env.DESIGN_SAVE_FIXTURE==='1')await writeFile(path.join(out,'fixture-document.json'),JSON.stringify(doc));
 const notice=page.getByRole('complementary',{name:'导入兼容提示'});if(await notice.count())await notice.getByRole('button',{name:'关闭导入提示'}).click();
 const setZoom=async n=>{await page.getByLabel('缩放与视图设置',{exact:true}).click();const input=page.getByLabel('缩放比例',{exact:true});await input.fill(String(n));await input.press('Enter');if(await input.isVisible())await page.getByLabel('缩放与视图设置',{exact:true}).click();await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-requested-camera-zoom',String(n/100))};
 // Anchor on a real visible shape so 3200% is not just an empty-world benchmark.
 const currentPage=doc.pages[0];const pageNodes=[];const walkPage=id=>{const n=doc.nodes[id];if(!n||n.visible===false)return;pageNodes.push(n);for(const child of n.children)walkPage(child)};for(const id of currentPage.children)walkPage(id);
 const requestedAnchor=process.env.DESIGN_ANCHOR_ID?pageNodes.find(n=>n.id===process.env.DESIGN_ANCHOR_ID):
  process.env.DESIGN_ANCHOR_NAME?pageNodes.find(n=>n.name===process.env.DESIGN_ANCHOR_NAME):undefined;
 if((process.env.DESIGN_ANCHOR_ID||process.env.DESIGN_ANCHOR_NAME)&&!requestedAnchor)throw Error('Requested original document anchor is absent');
 const group=requestedAnchor||(process.env.DESIGN_ANCHOR_TEXT?pageNodes.find(n=>n.kind==='text'&&n.text===process.env.DESIGN_ANCHOR_TEXT):undefined)||pageNodes.find(n=>n.name==='组合 51')||currentPage.children.map(id=>doc.nodes[id]).find(n=>n&&n.visible!==false);
 if(group){report.anchor={id:group.id,name:group.name,kind:group.kind};await page.getByLabel('搜索图层',{exact:true}).fill(group.name);const layer=page.getByTestId(`layer-${group.id}`);if(await layer.count()){await layer.click();await page.getByLabel('搜索图层',{exact:true}).fill('');await page.getByTestId('canvas').focus();await page.keyboard.press('Shift+2');report.anchorSettled=await settle();if(!report.anchorSettled.ok)throw Error('Anchor fit did not reach exact presentation')}}
 await stage('zoom-100',()=>setZoom(100));
 const pan=async()=>{const canvas=page.getByTestId('canvas'),b=await canvas.boundingBox();await canvas.focus();await page.keyboard.down('Space');try{for(let i=0;i<4;i++){const x=b.x+b.width*.5,y=b.y+b.height*.5;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(i%2?220:-220),y+(i%2?90:-90),{steps:20});await page.mouse.up()}}finally{await page.keyboard.up('Space')}};
 await stage('pan-100',pan);
 await stage('zoom-3200',()=>setZoom(3200));
 await stage('pan-3200',pan);
 await stage('zoom-return-100',()=>setZoom(100));
 await stage('zoom-repeat-3200',()=>setZoom(3200));
 report.navigationPreservedDocument=hash(JSON.stringify(await stored()))===report.document.sha256;
 if(extended){
  report.extended={status:'running',cpuProfiling:true,persistenceReadsOutsideProfiles:true,
   scope:'Actual Control+wheel and authored UI edit/undo in this isolated temporary workspace. rAF intervals and sampled CPU stacks are not physical FPS or input-to-photon measurements.',
   stages:[]};
  const extra=async(name,action)=>{
   const row=await stage(`extended-${name}`,action);report.extended.stages.push(row.name);await save();
   if(row.actionError||!row.settled.ok)throw Error(`${row.name} failed: ${row.actionError||JSON.stringify(row.settled)}`);
   return row;
  };
  const canvas=page.getByTestId('canvas');
  await extra('zoom-reset-100',()=>setZoom(100));
  const wheelBefore=await snapshot(),wheelDeltas=Array.from({length:3},()=>[-12,-12,-12,-12,-12,-12,12,12,12,12,12,12]).flat();
  await extra('continuous-wheel',async()=>{
   const box=await canvas.boundingBox();if(!box)throw Error('Canvas has no visible bounds for actual wheel input');
   await canvas.focus();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
   await page.keyboard.down('Control');
   try{for(const delta of wheelDeltas)await page.mouse.wheel(0,delta)}
   finally{await page.keyboard.up('Control')}
  });
  // Inspect persisted bytes only after CPU/rAF collection stops, so large FIG
  // bridge reads do not contaminate the gesture profile.
  const wheelAfter=await snapshot(),wheelTrace=JSON.parse(await readFile(path.join(out,'extended-continuous-wheel-frames.json'),'utf8'));
  if(wheelTrace.wheels.length!==wheelDeltas.length||wheelTrace.wheels.some((event,i)=>event.x!==0||event.y!==wheelDeltas[i]||event.mode!==0))
    throw Error('Wheel input differs from the scripted sequence; run is contaminated');
  const observedZooms=[...new Set(wheelTrace.frames.map(frame=>Number(frame[4])).filter(Number.isFinite))];
  const wheelHash=hash(JSON.stringify(await stored()));
  report.extended.wheel={deltas:wheelDeltas,before:wheelBefore.presentation,after:wheelAfter.presentation,
   observedZooms,documentSha256:wheelHash,documentPreserved:wheelHash===report.document.sha256};
  await save();
  if(observedZooms.length<2)throw Error('Control+wheel produced no observed zoom change; continuous zoom is not verified');
  if(Math.abs(Number(wheelAfter.presentation.requestedCameraZoom)-1)>1e-6)throw Error('Equal outward/return wheel input did not return to the starting 100% zoom');
  if(wheelHash!==report.document.sha256)throw Error('Continuous wheel navigation changed the persisted document');
  if(!group)throw Error('No original visible anchor is available for the authored interaction regression');
  const isFig=/\.fig$/i.test(fixture);
  if(!isFig&&group.kind!=='group')throw Error('The original Sketch anchor is not a group; refusing to claim a group drag');
  await extra('select-edit-target',async()=>{
   await page.getByLabel('搜索图层',{exact:true}).fill(group.name);
   await page.getByTestId(`layer-${group.id}`).click();
   await expect(page.locator('.inspector')).toHaveAttribute('data-node-id',group.id);
   await page.getByLabel('搜索图层',{exact:true}).fill('');
   await canvas.focus();await page.keyboard.press('v');await page.keyboard.press('Shift+2');
   const fitted=await settle();if(!fitted.ok)throw Error('The selected edit target did not reach exact presentation');
   await setZoom(100);
  });
  const beforeEdit=await stored(),beforeEditHash=hash(JSON.stringify(beforeEdit)),beforeTransform=beforeEdit.nodes[group.id]?.transform;
  if(!Array.isArray(beforeTransform)||beforeTransform.length!==6)throw Error('The original edit target has no persisted transform');
  if(beforeEditHash!==report.document.sha256)throw Error('Selecting the edit target changed the document before the edit');
  report.extended.edit={mode:isFig?'property-x':'pointer-drag',target:{id:group.id,name:group.name,kind:group.kind},
   beforeSha256:beforeEditHash,beforeTransform:[...beforeTransform],zoom:100};
  if(isFig){
   const input=page.locator('.inspector').getByLabel('X',{exact:true}),initialX=Number(await input.inputValue());
   if(!Number.isFinite(initialX))throw Error('The actual X property is not a finite editable value');
   report.extended.edit.property={name:'X',before:initialX,requested:initialX+24};
   await extra('property-x',async()=>{
    await input.fill(String(initialX+24));await input.press('Enter');await canvas.focus();
    await expect(page.locator('.inspector')).toHaveAttribute('data-node-id',group.id);
   });
  }else{
   // Use the real selection polygon's screen matrix and a visible interior point.
   // No application hit-test/model hook is called to force an edit to succeed.
   const geometry=await page.getByTestId('canvas-selection-outline').evaluate(element=>{
    const matrix=element.getScreenCTM(),host=document.querySelector('[data-testid="canvas"]');
    if(!matrix||!host)throw Error('Selection polygon has no screen transform or canvas');
    const points=[...element.points].map(point=>new DOMPoint(point.x,point.y).matrixTransform(matrix)).map(({x,y})=>({x,y}));
    const box=host.getBoundingClientRect(),rect=element.getBoundingClientRect();
    const left=Math.max(box.left+24,rect.left+12),right=Math.min(box.right-80,rect.right-12);
    const top=Math.max(box.top+24,rect.top+12),bottom=Math.min(box.bottom-64,rect.bottom-12);
    const inside=(x,y)=>{let odd=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)odd=!odd}return odd};
    const candidates=[[.6,.4],[.5,.5],[.4,.6],[.3,.3],[.7,.7]].map(([fx,fy])=>({x:left+(right-left)*fx,y:top+(bottom-top)*fy}));
    const point=right>left&&bottom>top?candidates.find(({x,y})=>inside(x,y)&&host.contains(document.elementFromPoint(x,y))):undefined;
    return {points,canvas:{x:box.x,y:box.y,width:box.width,height:box.height},
     selection:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},point};
   });
   report.extended.edit.geometry=geometry;await save();
   if(!geometry.point)throw Error('The actual group selection has no reliably visible interior drag point');
   const {x,y}=geometry.point;report.extended.edit.pointer={from:{x,y},to:{x:x+44,y:y+26},steps:24};
   const dragStart=await snapshot();
   report.extended.edit.previewBefore=dragStart.compositor;
   await extra('pointer-drag',async()=>{
    await canvas.focus();await page.mouse.move(x,y);await page.mouse.down();
    try{
     await expect(canvas).toHaveAttribute('data-transform-gesture','move');
     await page.mouse.move(x+44,y+26,{steps:24});
     if(process.env.DESIGN_VERIFY_HELD_DRAG==='1'){
      const holdStarted=performance.now();
      await page.waitForFunction(()=>{
       const c=document.querySelector('.kernel-compositor')?.dataset;
       return c&&!c.interactionError&&Number(c.interactionMoves)>0&&
        Number(c.interactionSamples)>0&&Number(c.contentSequence)>=Number(c.interactionMoves);
      },null,{timeout:20000});
      report.extended.edit.heldPreview={waitMs:performance.now()-holdStarted,...await snapshot()};
      if(report.extended.edit.heldPreview.compositor.interactionActive!=='true')throw Error('Held gesture ended before a verified content update; inspect capture trace');
      if(process.env.DESIGN_TEST_HIDDEN!=='1'&&process.env.DESIGN_TEST_PASSIVE!=='1')await page.locator('.kernel-compositor').screenshot({path:path.join(out,'held-drag-compositor.png')});
      const heldPng=await page.locator('.kernel-compositor').evaluate(c=>c.toDataURL('image/png'));
      await writeFile(path.join(out,'held-drag-canvas-buffer.png'),Buffer.from(heldPng.split(',')[1],'base64'));
     }
    }finally{await page.mouse.up()}
    await expect(page.locator('.inspector')).toHaveAttribute('data-node-id',group.id);
   });
   const dragEnd=await snapshot();report.extended.edit.previewAfter=dragEnd.compositor;
   if(dragEnd.compositor.interactionError||Number(dragEnd.compositor.interactionMoves)<=Number(dragStart.compositor.interactionMoves||0))
    throw Error('Drag preview did not accept real movement: '+JSON.stringify(dragEnd.compositor));
   if(process.env.DESIGN_TEST_HIDDEN!=='1'&&process.env.DESIGN_TEST_PASSIVE!=='1')await page.locator('.kernel-compositor').screenshot({path:path.join(out,'settled-drag-compositor.png')});
   if(process.env.DESIGN_VERIFY_HELD_DRAG==='1'){
    const settledPng=await page.locator('.kernel-compositor').evaluate(c=>c.toDataURL('image/png'));
    await writeFile(path.join(out,'settled-drag-canvas-buffer.png'),Buffer.from(settledPng.split(',')[1],'base64'));
   }
  }
  await expect.poll(async()=>JSON.stringify((await stored()).nodes[group.id]?.transform),
   {timeout:60000,intervals:[500,1000,2000],message:'Actual UI edit must change the persisted target transform'}).not.toBe(JSON.stringify(beforeTransform));
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000});
  const edited=await stored(),editedHash=hash(JSON.stringify(edited)),editedTransform=edited.nodes[group.id]?.transform;
  report.extended.edit.afterSha256=editedHash;report.extended.edit.afterTransform=editedTransform;
  report.extended.edit.changed=editedHash!==beforeEditHash&&JSON.stringify(editedTransform)!==JSON.stringify(beforeTransform);
  report.extended.edit.nodeCountPreserved=Object.keys(edited.nodes).length===Object.keys(beforeEdit.nodes).length;
  await save();
  if(!report.extended.edit.changed||!report.extended.edit.nodeCountPreserved)throw Error('The persisted UI edit did not produce the expected transform change while preserving node count');
  report.extended.edit.undoInput=isFig?'toolbar-button':'canvas-keyboard';
  await extra('undo-edit',async()=>{
   if(isFig)await page.getByRole('button',{name:'撤销',exact:true}).click();
   else{await canvas.focus();await page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z')}
  });
  try{
   await expect.poll(async()=>hash(JSON.stringify(await stored())),
    {timeout:60000,intervals:[500,1000,2000],message:'Undo must restore the entire persisted document JSON'}).toBe(beforeEditHash);
  }catch(error){
   await writeFile(path.join(out,'undo-expected-document.json'),JSON.stringify(beforeEdit));
   await writeFile(path.join(out,'undo-actual-document.json'),JSON.stringify(await stored()));
   throw error;
  }
  const restored=await stored();report.extended.edit.undoSha256=hash(JSON.stringify(restored));
  report.extended.edit.undoTransform=restored.nodes[group.id]?.transform;
  report.extended.edit.undoRestoredCompleteDocument=report.extended.edit.undoSha256===beforeEditHash;
  report.extended.sourceFilePreserved=hash(await readFile(fixture))===report.fixtureSha256;
  if(!report.extended.sourceFilePreserved)throw Error('Original fixture bytes changed during the isolated regression');
  report.extended.status='completed';await save();
 }
 report.presentationPassed=report.stages.every(stage=>stage.settled.ok&&!stage.actionError);
 if(!report.presentationPassed)throw Error('At least one operation failed to reach exact presentation');
 report.status='completed';await save();
}catch(e){report.status='failed';if(report.extended?.status==='running')report.extended.status='failed';report.errors.push({phase,error:String(e)});await save();if(page&&!page.isClosed()){if(process.env.DESIGN_TEST_HIDDEN==='1'||process.env.DESIGN_TEST_PASSIVE==='1')await compositorPng().then(png=>writeFile(path.join(out,'failure.png'),png)).catch(()=>{});else await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}throw e}
finally{if(app){const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('close timeout')),15000)})])}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}}
