import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {buildInputs} from '../../../frontend/design-desktop/scripts/build-inputs.mjs'

const root=process.cwd(),[products,out,kind='topology']=process.argv.slice(2)
const files={topology:'/Users/Apple/Downloads/拓扑素材.sketch','117':'/Users/Apple/Downloads/117.sketch',fig:'/Users/Apple/Downloads/01有料素材 (Copy).fig'}
if(!products||!out||!files[kind])throw Error('Usage: node launch-verify.mjs PRODUCTS FRESH_OUTPUT topology|117|fig')
const require=createRequire(path.join(root,'frontend/design-client/package.json'))
const {_electron,expect}=require('@playwright/test')
const electron=createRequire(path.join(root,'frontend/design-desktop/package.json'))('electron')
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex')
const manifest=JSON.parse(await fs.readFile(path.join(products,'build-manifest.json'),'utf8'))
assert.deepEqual(await buildInputs(root),manifest.sources,'Current code differs from built product')
await fs.mkdir(out);await fs.mkdir(path.join(out,'profiles'))
const host=path.join(out,'host');await fs.mkdir(host)
await fs.cp(path.join(root,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(products,path.join(host,'dist'))
await fs.symlink(path.join(root,'frontend/design-desktop/assets'),path.join(host,'assets'))
// Observe actual native replies without replacing data, requests or the renderer.
await fs.writeFile(path.join(host,'src/verification-launch.mjs'),`import {NativePreparation} from './preparation.mjs';import {LargeDocumentHost} from './large-document.mjs';
for(const method of ['open','canvasSnapshot','canvasLayout']){const call=LargeDocumentHost.prototype[method];LargeDocumentHost.prototype[method]=async function(...args){const at=Date.now(),start=performance.now();try{const result=await call.apply(this,args);console.log('SCENE_IMPORT_STAGE '+JSON.stringify({method,at,wallMs:performance.now()-start,nodes:result.nodes,roots:result.roots,bytes:result.bytes,indexedObjects:result.indexedObjects}));return result}catch(error){console.log('SCENE_IMPORT_STAGE '+JSON.stringify({method,at,wallMs:performance.now()-start,error:String(error)}));throw error}}}
const request=NativePreparation.prototype.request;
NativePreparation.prototype.request=function(input){const at=Date.now(),start=performance.now();return request.call(this,input).then(reply=>{if(input.method==='compile_gpu_packet'||input.method==='load_source_snapshot')console.log('SCENE_RUNTIME_REPLY '+JSON.stringify({method:input.method,at,wallMs:performance.now()-start,error:reply.error,stats:reply.compileStats}));return reply})};
await import('./main.mjs');`)
await fs.writeFile(path.join(host,'package.json'),JSON.stringify({name:'scene-runtime-real-electron-verification',type:'module',main:'src/verification-launch.mjs'}))
const source=files[kind],report={status:'running',kind,source,sourceHash:await hash(source),buildManifestHash:await hash(path.join(products,'build-manifest.json')),profile:manifest.profile,thresholds:{visibleP95Ms:33,stopToNativeMs:100},scope:'Visible production Electron; ready timing is a UI/compositor receipt proxy, not physical presentation latency.',cases:[],pageErrors:[],warnings:[],startedAt:new Date().toISOString()}
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
const env={...process.env,TMPDIR:path.join(out,'profiles'),CORE_RENDER_DIAGNOSTICS:'detail'}
delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.CORE_GPU_WORKING_BUDGET_MIB
let app,page
async function state(){return page.evaluate(()=>({status:[...document.querySelectorAll('.kernel-status')].map(n=>({text:n.textContent,title:n.getAttribute('title')})),source:document.querySelector('.source-canvas-status')?.textContent,errors:[...document.querySelectorAll('.kernel-status.error,.source-status-card [role=alert]')].map(n=>n.textContent),dpr:devicePixelRatio,canvases:[...document.querySelectorAll('canvas')].map(n=>({class:n.className,width:n.width,height:n.height,cssWidth:n.clientWidth,cssHeight:n.clientHeight})),presentation:document.querySelector('.kernel-presentation')?.outerHTML.slice(0,1500)}))}
async function stage(id,fn){report.stage=id;await persist();const start=performance.now();try{const data=await fn();report.cases.push({id,status:'PASS',wallMs:performance.now()-start,...data})}catch(e){report.cases.push({id,status:'FAIL',wallMs:performance.now()-start,error:String(e)});throw e}finally{await persist();console.log(id)}}
async function settle(native=kind==='topology',timeout=180000){
 await page.waitForFunction(native=>native?[...document.querySelectorAll('.native-source-surface .kernel-status')].some(n=>n.textContent==='WebGPU · 清晰'||n.textContent==='画板绘制未完成'):!!document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',native,{timeout})
 const s=await state();assert.equal(s.errors.length,0);assert(!s.status.some(n=>n.text==='画板绘制未完成'),JSON.stringify(s.status));return s
}
async function capture(id){await page.screenshot({path:path.join(out,id+'.png')});await fs.writeFile(path.join(out,id+'.json'),JSON.stringify(await state(),null,2))}
async function focus(name){await page.getByLabel('搜索素材',{exact:true}).fill(name);const row=page.locator('.source-page-entry').filter({has:page.locator('.source-row-name',{hasText:new RegExp('^'+name+'$')})});await expect(row).toHaveCount(1);await row.click();return row}
async function zoom(value){await page.locator('.view-menu summary').click();const field=page.getByLabel('缩放比例',{exact:true});await field.fill(String(value));await field.press('Enter');await field.press('Escape')}
try{
 await stage('launch-current-build',async()=>{
  app=await _electron.launch({executablePath:electron,args:[host,'--desktop-isolated-profile'],cwd:root,env,chromiumSandbox:true,timeout:60000})
  for(const s of [app.process().stdout,app.process().stderr])s?.on('data',data=>{void fs.appendFile(path.join(out,'host.log'),data)})
  page=await app.firstWindow();page.setDefaultTimeout(30000)
  page.on('pageerror',e=>{report.pageErrors.push(String(e));void persist()})
  page.on('console',m=>{if(['warning','error'].includes(m.type()))report.warnings.push(m.text());void fs.appendFile(path.join(out,'renderer.log'),m.text()+'\n')})
  report.runtime=await app.evaluate(({app,BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.setTitle('第三模块 · 完整素材真实回归');w.show();w.focus();const p=w.webContents.getLastWebPreferences();return {pid:process.pid,profile:app.getPath('userData'),versions:process.versions,gpu:app.getGPUFeatureStatus(),display:screen.getDisplayMatching(w.getBounds()),sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration}})
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 })
 if(process.env.VERIFY_LAUNCH_ONLY==='1'){
  report.status='ready-for-native-computer-test';await persist();console.log('READY_FOR_NATIVE_COMPUTER_TEST');
  await new Promise(resolve=>{app.on('close',resolve);const timer=setInterval(async()=>{if(await fs.stat(path.join(out,'close-owned-instance')).catch(()=>false)){clearInterval(timer);void app.close()}},1000);app.on('close',()=>clearInterval(timer))});process.exit(0)
 }
 await stage('import-original',async()=>{
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
  if(kind==='topology'){
   await expect(page.locator('.app-shell')).toHaveAttribute('data-source-document','true',{timeout:240000})
   await expect(page.locator('.source-pages-heading')).toContainText('306 个素材',{timeout:240000})
   await expect(page.locator('.native-source-surface')).toHaveCount(1)
   // Keep full-source canvas; double-click would enter a different editable workset.
   await focus('模板二')
  }else await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(path.basename(source).replace(/\.(sketch|fig)$/,''),{timeout:180000})
  const s=await settle();await capture('01-loaded');return {state:s}
 })
 await stage('native-reverse-zoom-and-pan',async()=>{
  const b=await page.getByTestId('canvas').boundingBox();assert(b)
  await page.getByTestId('canvas').focus();await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  await page.keyboard.down('Control');for(const dy of [-100,-160,160,100]){await page.mouse.wheel(0,dy);await page.waitForTimeout(16)}await page.keyboard.up('Control')
  const start=performance.now();await settle();const reverseReadyProxyMs=performance.now()-start
  await page.keyboard.down('Space');await page.mouse.down();await page.mouse.move(b.x+b.width/2+72,b.y+b.height/2+40,{steps:10});await page.mouse.up();await page.keyboard.up('Space')
  const panStart=performance.now();await settle();const panReadyProxyMs=performance.now()-panStart
  await capture('02-motion');return {reverseReadyProxyMs,panReadyProxyMs}
 })
 await stage('3200-reverse-to-125',async()=>{await zoom(3200);await page.waitForTimeout(80);await zoom(125);const start=performance.now();await settle();const readyProxyMs=performance.now()-start;await capture('03-zoom-return');return {readyProxyMs}})
 if(kind==='topology'){
  await stage('full-source-switch-material',async()=>{await focus('主框架03');await settle();await capture('04-second-material');await focus('模板二');await settle();return {state:await state()}})
  await stage('enter-editable-material',async()=>{const row=await focus('模板二');await row.dblclick();await expect(page.getByTestId('layer-70806B41-C915-4EB2-954C-449E746E4426')).toBeVisible({timeout:180000});await settle(false);await capture('05-editable')})
 }
 report.status='passed-functional-scope';report.visibleLatencyAcceptance='NOT_MEASURED';report.sourceUnchanged=report.sourceHash===await hash(source)
}catch(e){report.status='failed';report.error=String(e);if(page&&!page.isClosed())await capture('failure').catch(()=>{})}
report.sourceUnchanged=report.sourceHash===await hash(source)
report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,error:report.error,out,pid:report.runtime?.pid}))
// Leave this owned instance open for the user's inspection, including failed states.
if(app)await new Promise(resolve=>{app.on('close',()=>{clearInterval(timer);resolve()});const timer=setInterval(async()=>{if(await fs.stat(path.join(out,'close-owned-instance')).catch(()=>false)){clearInterval(timer);void app.close()}},1000)})
