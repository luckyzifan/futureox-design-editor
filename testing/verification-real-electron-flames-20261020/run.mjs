// Real visible Electron, unmodified release renderer/math, CDP sampled stacks.
import {mkdir, readFile, writeFile, appendFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const root=process.cwd(), desktop=path.join(root,'frontend/design-desktop');
const require=createRequire(path.join(root,'frontend/design-client/package.json'));
const {_electron,expect}=require('@playwright/test');
const [fixture,out]=process.argv.slice(2); if(!fixture||!out)throw Error('fixture output required');
await mkdir(out,{recursive:false}); await mkdir(path.join(out,'profiles'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const report={fixture:path.basename(fixture),fixtureSha256:hash(await readFile(fixture)),startedAt:new Date().toISOString(),stages:[],errors:[],scope:'Visible release Electron, sandbox retained, isolated user profile; real pointer/keyboard input through Playwright; sampled diagnostics, not physical input-to-photon or FPS acceptance.'};
await writeFile(path.join(out,'build-manifest.json'),await readFile(path.join(desktop,'dist/build-manifest.json')));
const artifacts={};for(const f of await readdir(path.join(desktop,'dist/renderer/assets'))){const relative='frontend/design-desktop/dist/renderer/assets/'+f;artifacts[relative]=hash(await readFile(path.join(root,relative)))};await writeFile(path.join(out,'runtime-artifacts.json'),JSON.stringify({captured:'before launch',artifacts},null,2));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k)));
const sampling=process.env.DESIGN_CPU_PROFILE!=='0';report.sampling=sampling;
let app,page,phase='startup';
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
try {
 app=await _electron.launch({executablePath:require(path.join(desktop,'node_modules/electron')),args:[desktop,'--desktop-gui-test'],env:{...env,TMPDIR:path.join(out,'profiles'),CORE_RENDER_DIAGNOSTICS:sampling?'detail':'0'},chromiumSandbox:true,timeout:60000});
 for(const [name,stream] of [['stdout',app.process().stdout],['stderr',app.process().stderr]])stream?.on('data',d=>void appendFile(path.join(out,`host-${name}.log`),d));
 page=await app.firstWindow();page.setDefaultTimeout(20000);
 page.on('pageerror',e=>report.errors.push({phase,error:String(e)}));
 page.on('console',m=>{if(m.type()==='error')report.errors.push({phase,error:m.text()})});
 await page.waitForURL(/^design-app:/);
 report.host=await app.evaluate(async({app,BrowserWindow,screen})=>{
  const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,960);w.show();w.focus();
  w.setTitle('Futureox · 真实 CPU 火焰图采样');
  const debug=w.webContents.debugger;debug.attach('1.3');
  const s={debug,sessions:new Map(),pending:[],errors:[],active:false};globalThis.__profileRun=s;
  debug.on('message',(_e,method,p)=>{if(method==='Target.detachedFromTarget'){const info=s.sessions.get(p.sessionId);s.sessions.delete(p.sessionId);if(info)s.errors.push('Worker exited before profile retrieval: '+info.url);}if(method==='Target.attachedToTarget'&&p.targetInfo.type==='worker'){
    s.sessions.set(p.sessionId,p.targetInfo);
    s.pending.push((async()=>{await debug.sendCommand('Profiler.enable',{},p.sessionId);await debug.sendCommand('Profiler.setSamplingInterval',{interval:1000},p.sessionId);if(s.active)await debug.sendCommand('Profiler.start',{},p.sessionId)})().catch(e=>s.errors.push(String(e))));
  }});
  await debug.sendCommand('Profiler.enable');await debug.sendCommand('Profiler.setSamplingInterval',{interval:1000});
  await debug.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  return {versions:process.versions,prefs:w.webContents.getLastWebPreferences(),display:screen.getDisplayMatching(w.getBounds()),gpu:await app.getGPUInfo('basic'),profile:app.getPath('userData')};
 });
 await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready','true',{timeout:120000});
 const snapshot=()=>page.evaluate(()=>({at:performance.now(),presentation:{...document.querySelector('.kernel-presentation')?.dataset},tiles:{...document.querySelector('.kernel-tiles')?.dataset},errors:[...document.querySelectorAll('.kernel-status.error')].map(e=>e.textContent)}));
 const settle=async(timeout=45000)=>{
  try{await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.dataset.fallbackPhase==='pending'||(document.querySelector('.kernel-presentation')?.dataset.presentationReady==='true'&&document.querySelector('.kernel-tiles')?.dataset.detailReady==='true'),null,{timeout});}catch(e){return {ok:false,error:String(e),...await snapshot()}}
  const s=await snapshot();return {ok:!s.errors.length&&s.presentation.presentationReady==='true'&&s.presentation.previewActive==='false'&&s.presentation.fallbackPhase==='none'&&s.tiles.detailReady==='true',...s};
 };
 await settle();
 const stage=async(name,action)=>{
  phase=name;const wallStart=Date.now();console.log('START '+name);
  const nativeSamples=[];
  if(sampling&&name==='zoom-3200'){
   const processes=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n');
   for(const row of processes){const match=row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);if(match&&Number(match[2])===app.process().pid&&match[3].endsWith('/design-prepare')){
    const sample=spawn('/usr/bin/sample',[match[1],'5','2','-file',path.join(out,`native-${name}-${match[1]}.sample.txt`)],{stdio:'ignore'});
    nativeSamples.push(new Promise(resolve=>sample.on('exit',resolve)));report.nativeSample={pid:Number(match[1]),phase:name,durationSeconds:5,intervalMs:2};
   }}
  }
  if(sampling)await app.evaluate(async()=>{const s=globalThis.__profileRun;await Promise.all(s.pending);s.active=true;await s.debug.sendCommand('Profiler.start');await Promise.all([...s.sessions.keys()].map(id=>s.debug.sendCommand('Profiler.start',{},id).catch(e=>s.errors.push(String(e)))))});
  await page.evaluate(()=>{
   const s={start:performance.now(),frames:[],longtasks:[],run:true};window.__phaseTrace=s;
   s.observer=new PerformanceObserver(l=>{for(const e of l.getEntries())s.longtasks.push({start:e.startTime,duration:e.duration})});s.observer.observe({type:'longtask',buffered:false});
   const tick=t=>{if(!s.run)return;const p=document.querySelector('.kernel-presentation')?.dataset;const d=document.querySelector('.kernel-tiles')?.dataset;s.frames.push([t,p?.presentationReady,p?.previewActive,d?.detailReady,p?.requestedCameraZoom,d?.viewportTilesRendered]);if(s.frames.length<20000)requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const start=performance.now();let actionError;try{await action()}catch(e){actionError=String(e)}
  const actionMs=performance.now()-start;
  const settled=await settle();
  const totalMs=performance.now()-start;
  const trace=await page.evaluate(()=>{const s=window.__phaseTrace;s.run=false;s.observer.disconnect();return {start:s.start,frames:s.frames,longtasks:s.longtasks}});
  const profiles=sampling?await app.evaluate(async()=>{const s=globalThis.__profileRun;s.active=false;await Promise.all(s.pending);const profiles=[];profiles.push({target:'renderer',...await s.debug.sendCommand('Profiler.stop')});for(const [id,info] of s.sessions)try{profiles.push({target:info,...await s.debug.sendCommand('Profiler.stop',{},id)})}catch(e){s.errors.push(String(e))};return {profiles,errors:s.errors}}):{profiles:[],errors:[]};
  for(let i=0;i<profiles.profiles.length;i++)await writeFile(path.join(out,`${name}-${i}.cpuprofile`),JSON.stringify(profiles.profiles[i].profile));
  await writeFile(path.join(out,`${name}-targets.json`),JSON.stringify(profiles.profiles.map(({target})=>target),null,2));
  await writeFile(path.join(out,`${name}-frames.json`),JSON.stringify(trace));
  const gaps=trace.frames.slice(1).map((f,i)=>f[0]-trace.frames[i][0]).sort((a,b)=>a-b);
  const row={name,wallStart,wallEnd:Date.now(),actionMs,totalMs,actionError,settled,raf:{count:trace.frames.length,p50:gaps[Math.floor(gaps.length*.5)],p95:gaps[Math.floor(gaps.length*.95)],max:gaps.at(-1),over50:gaps.filter(n=>n>50).length},longtasks:trace.longtasks,profilerErrors:profiles.errors};
  report.stages.push(row);await Promise.all(nativeSamples);await page.screenshot({path:path.join(out,`${name}.png`)});await save();console.log(JSON.stringify({name,actionMs,totalMs,ok:settled.ok,raf:row.raf,actionError}));return row;
 };
 await stage('import',async()=>{await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture);await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(path.basename(fixture).replace(/\.(sketch|fig)$/i,''),{timeout:120000});await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:120000});await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})});
 const documentName=await page.getByLabel('文档名称',{exact:true}).inputValue();report.documentName=documentName;
 const stored=()=>page.evaluate(async(name)=>{const bridge=window.coreDesktop.workspace;const list=await bridge.list();const item=list.documents.find(x=>x.name===name&&!x.deleted);if(!item)throw Error('Stored document not found '+name);const result=await bridge.open({id:item.id});if(result.status!=='ok')throw Error(result.status);return JSON.parse(result.documentJson)},documentName);
 report.adapter=await page.evaluate(async()=>{const info=(await navigator.gpu?.requestAdapter())?.info;return info&&{vendor:info.vendor,architecture:info.architecture,description:info.description}});
 const doc=await stored();report.document={nodes:Object.keys(doc.nodes).length,pages:doc.pages.length,sha256:hash(JSON.stringify(doc)),dpr:await page.evaluate(()=>devicePixelRatio)};
 const notice=page.getByRole('complementary',{name:'导入兼容提示'});if(await notice.count())await notice.getByRole('button',{name:'关闭导入提示'}).click();
 const setZoom=async n=>{await page.getByLabel('缩放与视图设置',{exact:true}).click();const input=page.getByLabel('缩放比例',{exact:true});await input.fill(String(n));await input.press('Enter');if(await input.isVisible())await page.getByLabel('缩放与视图设置',{exact:true}).click();await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-requested-camera-zoom',String(n/100))};
 // Anchor on a real visible shape so 3200% is not just an empty-world benchmark.
 const currentPage=doc.pages[0];const pageNodes=[];const walkPage=id=>{const n=doc.nodes[id];if(!n||n.visible===false)return;pageNodes.push(n);for(const child of n.children)walkPage(child)};for(const id of currentPage.children)walkPage(id);
 const group=(process.env.DESIGN_ANCHOR_TEXT?pageNodes.find(n=>n.kind==='text'&&n.text===process.env.DESIGN_ANCHOR_TEXT):undefined)||pageNodes.find(n=>n.name==='组合 51')||currentPage.children.map(id=>doc.nodes[id]).find(n=>n&&n.visible!==false);
 if(group){report.anchor={id:group.id,name:group.name,kind:group.kind};await page.getByLabel('搜索图层',{exact:true}).fill(group.name);const layer=page.getByTestId(`layer-${group.id}`);if(await layer.count()){await layer.click();await page.getByLabel('搜索图层',{exact:true}).fill('');await page.getByTestId('canvas').focus();await page.keyboard.press('Shift+2');await settle()}}
 await stage('zoom-100',()=>setZoom(100));
 const pan=async()=>{const canvas=page.getByTestId('canvas'),b=await canvas.boundingBox();await canvas.focus();await page.keyboard.down('Space');try{for(let i=0;i<4;i++){const x=b.x+b.width*.5,y=b.y+b.height*.5;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(i%2?220:-220),y+(i%2?90:-90),{steps:20});await page.mouse.up()}}finally{await page.keyboard.up('Space')}};
 await stage('pan-100',pan);
 await stage('zoom-3200',()=>setZoom(3200));
 await stage('pan-3200',pan);
 await stage('zoom-return-100',()=>setZoom(100));
 await stage('zoom-repeat-3200',()=>setZoom(3200));
 report.navigationPreservedDocument=hash(JSON.stringify(await stored()))===report.document.sha256;
 report.status='completed';await save();
}catch(e){report.status='failed';report.errors.push({phase,error:String(e)});await save();if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e}
finally{if(app){const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('close timeout')),15000)})])}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}}
