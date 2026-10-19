// Real Electron product page + native preparation. Diagnostic builds keep the
// production host/math policy and enable only existing pass/budget telemetry.
// node scripts/profile-canvas.mjs FIXTURE_FD NEW_OUTPUT_DIRECTORY
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile, symlink, appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),client=path.resolve(desktop,'../design-client')
const require=createRequire(path.join(client,'package.json'))
const {_electron,expect}=require('@playwright/test')
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
const [fixture,rawOutput]=process.argv.slice(2)
assert(fixture&&rawOutput,'Usage: profile-canvas.mjs FIXTURE NEW_OUTPUT_DIRECTORY')
const output=path.resolve(rawOutput);await mkdir(output,{recursive:false})
const zooms=(process.env.DESIGN_PROFILE_ZOOMS||'50,100,47.3').split(',').map(Number)
assert(zooms.length&&zooms.every(n=>Number.isFinite(n)&&n>0&&n<=6400),'Invalid profile zooms')
const host=path.join(output,'host');await mkdir(path.join(host,'dist'),{recursive:true})
await cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
await writeFile(path.join(host,'package.json'),JSON.stringify({name:'forma-owned-profiler',version:'0.0.0',type:'module',main:'src/main.mjs'}))
for(const name of ['bin','sidecar','fonts'])await symlink(path.join(desktop,'dist',name),path.join(host,'dist',name),'dir')
process.env.VITE_DESIGN_GPU_TIMINGS='1';process.env.VITE_DESIGN_TRACE_PASSES='tile'
await build({root:client,configFile:path.join(client,'vite.config.ts'),base:'./',define:{'import.meta.env.DEV':'true'},
 build:{outDir:path.join(host,'dist/renderer'),emptyOutDir:true,sourcemap:true}})
const fixtureText=await readFile(fixture,'utf8'),envelope=JSON.parse(fixtureText),document=envelope.document??envelope
await writeFile(path.join(output,'identity.json'),JSON.stringify({fixtureSha256:createHash('sha256').update(fixtureText).digest('hex'),
 instrumented:true,hidden:process.env.DESIGN_PROFILE_VISIBLE!=='1',mathPolicy:'unmodified Electron desktopFullMath',sources:await Promise.all([
  'src/kernel/gpu/renderer.ts','src/kernel/gpu/webgpu.ts','src/kernel/gpu/types.ts',
  'src/kernel/gpu/scalar-coverage.ts','src/kernel/gpu/exact-filter.ts','src/kernel/gpu/working-set-budget.ts',
  'src/kernel/gpu/texture-prefix.ts','src/kernel/gpu/texture-prefix.wgsl','src/kernel/gpu/prefix-module.ts',
  'src/kernel/gpu/prefix-int128.wgsl','src/kernel/gpu/area-shader.ts','src/kernel/gpu/scene-index.ts','src/kernel/gpu/sampling.glsl',
  'src/kernel/client.ts','src/kernel/render-worker.ts','src/kernel/render-policy.ts',
  'src/kernel/ProgressiveSurface.tsx','src/kernel/canvas-raster-plan.ts','src/kernel/tile-scheduler.ts',
  '../../design-studio/crates/design-kernel/shaders/sampling.wgsl',
  '../../design-studio/crates/design-kernel/shaders/vector.wgsl',
  '../../design-studio/crates/design-kernel/shaders/certified-rational.wgsl',
 ].map(async name=>({name,sha256:createHash('sha256').update(await readFile(path.join(client,name))).digest('hex')})))},null,2))
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
 const surface=page.locator('.kernel-presentation'),tiles=page.locator('.kernel-tiles')
 const settle=async()=>{
  await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||
   document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&
   document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:180000})
  const errors=await page.locator('.kernel-status.error').allTextContents();if(errors.length)throw Error(errors.join('; '))
 }
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000});await settle()
 phase='import';const importStart=performance.now();await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
 await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(document.name,{timeout:120000})
 await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:120000})
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})
 await page.waitForFunction(()=>{
  const s=document.querySelector('.kernel-presentation')
  return s?.getAttribute('data-displayed-document')===s?.getAttribute('data-requested-document')
 },null,{timeout:120000})
 await settle()
 rows.push({phase,ms:performance.now()-importStart})
 for(const percent of zooms){
  phase=`zoom-${percent}`;const start=performance.now()
  await page.getByLabel('缩放与视图设置',{exact:true}).click();await page.getByLabel('缩放比例',{exact:true}).fill(String(percent));await page.getByLabel('缩放比例',{exact:true}).press('Enter');await page.getByLabel('缩放与视图设置',{exact:true}).click()
  await expect(surface).toHaveAttribute('data-requested-camera-zoom',String(percent/100))
  try{await settle();rows.push({phase,ms:performance.now()-start,tiles:await tiles.evaluate(e=>({...e.dataset}))})}catch(e){rows.push({phase,error:String(e)})}
  if(!page.isClosed()) assert.equal(Number(await surface.getAttribute('data-requested-camera-zoom')),percent/100,'Camera changed during profiling; discard this run')
  await writeFile(path.join(output,'partial-results.json'),JSON.stringify({rows},null,2))
  console.log(JSON.stringify({phase,ms:rows.at(-1).ms,error:rows.at(-1).error}))
  if(!rows.at(-1).error){
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
  await writeFile(path.join(output,'events.json'),JSON.stringify(events))
 }
 if(process.env.DESIGN_PROFILE_FIT!=='0'){
 phase='fit-selection'
 const group=Object.values(document.nodes).find(n=>n.name==='组合 51');assert(group)
 await page.getByLabel('搜索图层',{exact:true}).fill(group.name);await page.getByTestId(`layer-${group.id}`).click();await page.getByLabel('搜索图层',{exact:true}).fill('')
 await page.getByTestId('canvas').focus();const fitStart=performance.now();await page.keyboard.press('Shift+2')
 try{await settle();rows.push({phase,ms:performance.now()-fitStart,tiles:await tiles.evaluate(e=>({...e.dataset}))})}catch(e){rows.push({phase,ms:performance.now()-fitStart,error:String(e),fallback:await surface.getAttribute('data-fallback-reason'),tiles:await tiles.evaluate(e=>({...e.dataset}))})}
 }
 const profiles=await app.evaluate(async()=>{
  const s=globalThis.__canvasProfile;await Promise.all(s.pending)
  const out=[{target:'renderer',...(await s.debug.sendCommand('Profiler.stop'))}]
  for(const [id,info] of s.sessions)try{out.push({target:info,...await s.debug.sendCommand('Profiler.stop',{},id)})}catch(e){s.errors.push(String(e))}
  return {profiles:out,errors:s.errors}
 })
 await writeFile(path.join(output,'cpu-profiles.json'),JSON.stringify(profiles))
 await writeFile(path.join(output,'events.json'),JSON.stringify(events))
 await writeFile(path.join(output,'results.json'),JSON.stringify({rows,profilerErrors:profiles.errors},null,2))
 console.log(JSON.stringify({output,profiles:profiles.profiles.map(p=>p.target),rows:rows.map(({phase,ms,error,fallback,drawing})=>({phase,ms,error,fallback,sha256:drawing?.sha256}))}))
 await page.getByTestId('canvas').focus();await page.keyboard.press('Meta+s');await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})
}catch(error){await writeFile(path.join(output,'events.json'),JSON.stringify(events));throw error}
finally{if(app){let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned profiler close timeout')),30000)})])}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}}
