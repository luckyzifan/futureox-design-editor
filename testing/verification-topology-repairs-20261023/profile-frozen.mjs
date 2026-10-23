// Real Electron product page + native preparation. Diagnostic builds keep the
// production host/math policy and enable only existing pass/budget telemetry.
// node scripts/profile-canvas.mjs FIXTURE_FD NEW_OUTPUT_DIRECTORY
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile, symlink, appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const desktop=path.resolve('frontend/design-desktop'),client=path.resolve(desktop,'../design-client')
const require=createRequire(path.join(client,'package.json'))
const {_electron,expect}=require('@playwright/test')
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
const [fixture,rawOutput]=process.argv.slice(2)
assert(fixture&&rawOutput,'Usage: profile-canvas.mjs FIXTURE NEW_OUTPUT_DIRECTORY')
const output=path.resolve(rawOutput);await mkdir(output,{recursive:false})
const zooms=(process.env.DESIGN_PROFILE_ZOOMS||'50,100,47.3').split(',').map(Number)
assert(zooms.length&&zooms.every(n=>Number.isFinite(n)&&n>0&&n<=6400),'Invalid profile zooms')
const host="/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/topology-render-repairs-8aude7r6/baseline-electron-complete/host"
const fixtureText=await readFile(fixture,'utf8'),envelope=JSON.parse(fixtureText),document=envelope.document??envelope
await cp("/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/topology-render-repairs-8aude7r6/baseline-electron-complete/identity.json",path.join(output,'identity.json'))
let app,page,child;const events=[],rows=[];let phase='startup'
try{
 app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args:[host,'--desktop-gui-test'],chromiumSandbox:true,timeout:60000,
  env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k))),TMPDIR:output}})
 child=app.process()
 for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]])stream?.on('data',data=>void appendFile(path.join(output,`host-${name}.log`),data))
 child.on('exit',(code,signal)=>{events.push({phase,at:Date.now(),event:'host-exit',code,signal});void appendFile(path.join(output,'host-exit.jsonl'),JSON.stringify({at:Date.now(),code,signal})+'\n')})
 page=await app.firstWindow();page.on('crash',()=>events.push({phase,at:Date.now(),event:'renderer-crash'}));page.on('close',()=>events.push({phase,at:Date.now(),event:'page-close'}));await page.waitForURL(/^design-app:/)
 page.on('console',m=>{if(m.text().startsWith('DESIGN_')||['warning','error'].includes(m.type()))events.push({phase,at:Date.now(),type:m.type(),text:m.text()})})
 page.on('pageerror',e=>events.push({phase,error:String(e)}))
 await app.evaluate(async({BrowserWindow})=>{
  const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,960)
  w.webContents.setBackgroundThrottling(false)
  w.webContents.on('page-title-updated',event=>event.preventDefault())
  w.setTitle('画布性能诊断副本 · 自动测试')
  if(process.env.DESIGN_PROFILE_VISIBLE!=='1'){w.on('show',()=>w.hide());w.hide()}
  if(process.env.DESIGN_PROFILE_VISIBLE==='1'){w.show();w.focus()}
  if(process.env.DESIGN_PROFILE_NO_SAMPLER==='1')return
  const debug=w.webContents.debugger;debug.attach('1.3')
  const state={debug,sessions:new Map(),pending:[],errors:[]};globalThis.__canvasProfile=state
  debug.on('message',(_event,method,params,sessionId)=>{
   if(method==='Target.attachedToTarget'&&params.targetInfo.type==='worker'){
    state.sessions.set(params.sessionId,params.targetInfo)
    state.pending.push(debug.sendCommand('Profiler.enable',{},params.sessionId).then(()=>debug.sendCommand('Profiler.start',{},params.sessionId)).catch(e=>state.errors.push(String(e))))
   }
  })
  await debug.sendCommand('Profiler.enable');await debug.sendCommand('Profiler.start')
  await debug.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
 })
 const segment=async(stage)=>{
  if(process.env.DESIGN_PROFILE_SEGMENTS!=='1'||process.env.DESIGN_PROFILE_NO_SAMPLER==='1')return
  const profiles=await app.evaluate(async()=>{
   const s=globalThis.__canvasProfile;if(!s)return {profiles:[],errors:[]};await Promise.all(s.pending);const profiles=[]
   for(const [id,target] of [[undefined,'renderer'],...s.sessions])try{profiles.push({target,...await s.debug.sendCommand('Profiler.stop',{},id)});await s.debug.sendCommand('Profiler.start',{},id)}catch(e){s.errors.push(String(e))}
   return {profiles,errors:s.errors}
  });await writeFile(path.join(output,stage+'-profiles.json'),JSON.stringify(profiles))
 }
 const surface=page.locator('.kernel-presentation'),tiles=page.locator('.kernel-tiles')
 const settle=async()=>{
  await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||
   document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&
   document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:60000})
  const errors=await page.locator('.kernel-status.error').allTextContents();if(errors.length)throw Error(errors.join('; '))
 }
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 phase='import';const importStart=performance.now();await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
 await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(document.name,{timeout:60000})
 await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:60000})
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
 await page.waitForFunction(()=>{
  const s=document.querySelector('.kernel-presentation')
  return s?.getAttribute('data-displayed-document')===s?.getAttribute('data-requested-document')
 },null,{timeout:60000})
 await settle()
 rows.push({phase,ms:performance.now()-importStart});await segment('import')
 for(const percent of zooms){
  phase=`zoom-${percent}`;events.push({phase,event:'scenario-start',at:Date.now()});const start=performance.now()
  await page.getByLabel('缩放与视图设置',{exact:true}).click();await page.getByLabel('缩放比例',{exact:true}).fill(String(percent));await page.getByLabel('缩放比例',{exact:true}).press('Enter');await page.getByLabel('缩放与视图设置',{exact:true}).click()
  await expect(surface).toHaveAttribute('data-requested-camera-zoom',String(percent/100))
  try{await settle();rows.push({phase,ms:performance.now()-start,tiles:await tiles.evaluate(e=>({...e.dataset}))})}catch(e){rows.push({phase,error:String(e)})}
  if(!page.isClosed()) assert.equal(Number(await surface.getAttribute('data-requested-camera-zoom')),percent/100,'Camera changed during profiling; discard this run')
  await writeFile(path.join(output,'partial-results.json'),JSON.stringify({rows},null,2))
  console.log(JSON.stringify({phase,ms:rows.at(-1).ms,error:rows.at(-1).error}))
  if(!rows.at(-1).error&&process.env.DESIGN_PROFILE_DRAWINGS!=='0'){
   const drawing=await page.evaluate(()=>{
    const source=document.querySelector('.kernel-presentation canvas[data-frame-visible="true"]')
    if(!(source instanceof HTMLCanvasElement))throw Error('Missing drawing canvas')
    const copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height
    copy.getContext('2d').drawImage(source,0,0)
    return {width:copy.width,height:copy.height,quality:{...source.dataset},png:copy.toDataURL('image/png').split(',')[1]}
   })
   const pixels=Buffer.from(drawing.png,'base64');await writeFile(path.join(output,`${phase}.png`),pixels)
   rows.at(-1).drawing={width:drawing.width,height:drawing.height,quality:drawing.quality,sha256:createHash('sha256').update(pixels).digest('hex')}
  }
  await writeFile(path.join(output,'events.json'),JSON.stringify(events));await segment(phase)
 }
 if(process.env.DESIGN_PROFILE_FIT!=='0'){
 phase='fit-selection'
 const group=Object.values(document.nodes).find(n=>n.name==='组合 51');assert(group)
 await page.getByLabel('搜索图层',{exact:true}).fill(group.name);await page.getByTestId(`layer-${group.id}`).click();await page.getByLabel('搜索图层',{exact:true}).fill('')
 await page.getByTestId('canvas').focus();const fitStart=performance.now();await page.keyboard.press('Shift+2')
 try{await settle();rows.push({phase,ms:performance.now()-fitStart,tiles:await tiles.evaluate(e=>({...e.dataset}))})}catch(e){rows.push({phase,ms:performance.now()-fitStart,error:String(e),fallback:await surface.getAttribute('data-fallback-reason'),tiles:await tiles.evaluate(e=>({...e.dataset}))})}
 }
 if(process.env.DESIGN_PROFILE_EDIT==='1'){
  phase='property-width';events.push({phase,event:'scenario-start',at:Date.now()})
  const target=document.nodes['0D747267-A0CA-40C0-BEFD-846C10CD98F2'];assert(target?.instance)
  await page.getByLabel('搜索图层',{exact:true}).fill(document.nodes[target.instance.componentId]?.name||target.name)
  await page.getByTestId(`layer-${target.id}`).click()
  await page.getByLabel('搜索图层',{exact:true}).fill('')
  const field=page.getByRole('spinbutton',{name:'W',exact:true})
  const revision=Number(await tiles.getAttribute('data-requested-revision'))
  const started=performance.now();await field.fill('120');await field.press('Enter')
  await expect(field).toHaveAttribute('aria-valuenow','120')
  await page.waitForFunction(old=>Number(document.querySelector('.kernel-tiles')?.getAttribute('data-requested-revision'))>old,revision,{timeout:60000})
  await settle();rows.push({phase,ms:performance.now()-started});await segment(phase)
  phase='undo';const undoAt=performance.now();await page.getByTestId('canvas').focus();await page.keyboard.press('Meta+z');await expect(field).toHaveAttribute('aria-valuenow','100');await settle();rows.push({phase,ms:performance.now()-undoAt});await segment(phase)
  phase='redo';const redoAt=performance.now();await page.keyboard.press('Meta+Shift+z');await expect(field).toHaveAttribute('aria-valuenow','120');await settle();rows.push({phase,ms:performance.now()-redoAt});await segment(phase)
  phase='continuous-wheel';events.push({phase,event:'scenario-start',at:Date.now()});const box=await page.getByTestId('canvas').boundingBox();assert(box)
  await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5)
  const wheelAt=performance.now();for(let i=0;i<24;i++){await page.mouse.wheel(0,i<12?-60:60);await page.waitForTimeout(16)}
  await settle();rows.push({phase,ms:performance.now()-wheelAt,tiles:await tiles.evaluate(e=>({...e.dataset}))});await segment(phase)
 }
 const profiles=await app.evaluate(async()=>{
  const s=globalThis.__canvasProfile;if(!s)return {profiles:[],errors:[]};await Promise.all(s.pending)
  const out=[{target:'renderer',...(await s.debug.sendCommand('Profiler.stop'))}]
  for(const [id,info] of s.sessions)try{out.push({target:info,...await s.debug.sendCommand('Profiler.stop',{},id)})}catch(e){s.errors.push(String(e))}
  return {profiles:out,errors:s.errors}
 })
 await writeFile(path.join(output,'cpu-profiles.json'),JSON.stringify(profiles))
 await writeFile(path.join(output,'events.json'),JSON.stringify(events))
 await writeFile(path.join(output,'results.json'),JSON.stringify({rows,profilerErrors:profiles.errors},null,2))
 console.log(JSON.stringify({output,profiles:profiles.profiles.map(p=>p.target),rows:rows.map(({phase,ms,error,fallback,drawing})=>({phase,ms,error,fallback,sha256:drawing?.sha256}))}))
 await page.getByTestId('canvas').focus();await page.keyboard.press('Meta+s');await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
}catch(error){
 await writeFile(path.join(output,'events.json'),JSON.stringify(events));
 if(app)try{const profiles=await app.evaluate(async()=>{const s=globalThis.__canvasProfile;if(!s)return null;await Promise.all(s.pending);const profiles=[];for(const [id,target]of [[undefined,'renderer'],...s.sessions])try{profiles.push({target,...await s.debug.sendCommand('Profiler.stop',{},id)})}catch{}return {profiles,errors:s.errors}});if(profiles)await writeFile(path.join(output,'failed-cpu-profiles.json'),JSON.stringify(profiles))}catch{}
 if(page&&!page.isClosed())await writeFile(path.join(output,'failure-ui.json'),JSON.stringify({body:await page.locator('body').innerText().catch(()=>''),html:await page.locator('.kernel-presentation').evaluate(e=>e.outerHTML).catch(()=>''),rows:await page.locator('[data-testid^=layer-]').evaluateAll(es=>es.map(e=>({id:e.dataset.testid,text:e.textContent}))).catch(()=>[])}));
 if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
 throw error
}
finally{if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned profiler close timeout')),30000)})])}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}}
