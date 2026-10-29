import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {verifyArtifacts} from '../verification-render-refactor-baseline-20261028/provenance.mjs'
const [base,version,kind,out]=process.argv.slice(2),root=process.cwd()
if(!out||!path.isAbsolute(out)||!['117','fig'].includes(kind))throw Error('BASE vN 117|fig FRESH_ABSOLUTE_OUTPUT required')
await fs.mkdir(out);const profiles=path.join(out,'profiles');await fs.mkdir(profiles)
const bundle=path.join(base,version),manifest=JSON.parse(await fs.readFile(path.join(bundle,'manifest.json'),'utf8'))
const checked=await verifyArtifacts(base,bundle,manifest)
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const electron=createRequire(path.join(root,'frontend/design-desktop/package.json'))('electron')
const source=kind==='117'?'/Users/Apple/Downloads/117.sketch':'/Users/Apple/Downloads/01有料素材 (Copy).fig'
const sha=async()=>createHash('sha256').update(await fs.readFile(source)).digest('hex')
const report={status:'running',kind,source,sourceBefore:await sha(),sourceDigest:manifest.sourceDigest,flags:manifest.flags,scenario:process.argv[6]||'all',checked,cases:[]}
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
let app,page;const writes=[]
const settle=async()=>{
 await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true',null,{timeout:180000})
 assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[])
}
async function zoom(percent){
 await page.locator('.view-menu summary').click();const input=page.getByLabel('缩放比例',{exact:true})
 await input.fill(String(percent));await input.press('Enter');await input.press('Escape');await settle()
}
try{
 const env={...process.env,TMPDIR:profiles,CORE_RENDER_DIAGNOSTICS:'detail'};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS
 app=await _electron.launch({executablePath:electron,args:[manifest.host],cwd:root,env,timeout:60000})
 for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',data=>writes.push(fs.appendFile(path.join(out,'host.log'),data)))
 page=await app.firstWindow();page.setDefaultTimeout(30000)
 report.inputIsolation=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();w.webContents.focus();return {externalMouseIgnored:true,focusable:false,scope:'Test window only; direct webContents native events and CDP controls remain enabled'}})
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 report.stage='import';await persist();await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
 await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(path.basename(source).replace(/\.(sketch|fig)$/,''),{timeout:120000});await settle()
 await page.getByLabel('搜索图层',{exact:true}).fill(kind==='117'?'117':'01_Dashboard')
 await page.locator('.layer-name').filter({hasText:kind==='117'?/^117$/:/^01_Dashboard$/}).first().click()
 report.stage='initial-camera';await persist();await page.keyboard.press('Shift+2');await settle();await zoom(400)
 report.runtime=await page.evaluate(()=>window.__strictNavigation.runtime())
 report.initial=await page.locator('.kernel-tiles').evaluate(e=>({...e.dataset}))
 assert.equal(report.initial.nativeVisibleTiles,manifest.flags.VITE_DESIGN_NATIVE_VISIBLE_TILES==='1'?'true':'false')
 const box=await page.getByTestId('canvas').boundingBox();assert(box)
 await page.evaluate(()=>document.addEventListener('wheel',e=>{e.preventDefault();window.__wheelSign=e.deltaY},{capture:true,passive:false,once:true}))
 await app.evaluate(({BrowserWindow},{x,y})=>BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({type:'mouseWheel',x,y,deltaX:0,deltaY:1,modifiers:['control'],hasPreciseScrollingDeltas:true,canScroll:true}),{x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)})
 await page.waitForFunction(()=>window.__wheelSign!==undefined);const sign=await page.evaluate(()=>window.__wheelSign);assert.equal(Math.abs(sign),1)
 for(const id of (process.argv[6]==='fresh-only'?['zoom-fresh']:['zoom-return','zoom-fresh','pan-return'])){
  report.stage=id;await persist()
  await page.keyboard.press('Shift+2');await settle();await zoom(400)
  const peak=Math.log(8)/.01/16,deltas=[]
  for(let i=0;i<32;i++){
   if(id==='pan-return'){
    const f=(i+1)/32,p=i/32;deltas.push({dx:256*(Math.sin(2*Math.PI*f)-Math.sin(2*Math.PI*p)),dy:64*(Math.sin(4*Math.PI*f)-Math.sin(4*Math.PI*p)),ctrl:false})
   }else deltas.push({dx:0,dy:i<16?-peak:peak,ctrl:true})
  }
  if(id==='zoom-fresh')deltas.push({dx:0,dy:-Math.log(9.5/4)/.01,ctrl:true})
  await page.evaluate(()=>window.__strictNavigation.begin())
  const dispatch=await app.evaluate(async({BrowserWindow},{box,deltas,sign})=>{
   const w=BrowserWindow.getAllWindows()[0],start=performance.now(),times=[]
   for(let i=0;i<deltas.length;i++){
    const wait=i*16-(performance.now()-start);if(wait>0)await new Promise(r=>setTimeout(r,wait))
    const d=deltas[i];w.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2),deltaX:d.dx/sign,deltaY:d.dy/sign,modifiers:d.ctrl?['control']:[],hasPreciseScrollingDeltas:true,canScroll:true});times.push(performance.now()-start)
   }return times
  },{box,deltas,sign})
  const measured=await page.evaluate(n=>window.__strictNavigation.finish(n),deltas.length)
  assert.equal(measured.inputs.length,deltas.length);assert(measured.inputs.every(e=>e.trusted))
  await page.waitForTimeout(300);const quiet=await page.evaluate(()=>window.__strictNavigation.capture())
  const row={id,dispatch,...measured,quiet,pixelsStable:measured.pixels.sha256===quiet.sha256}
  report.cases.push(row);await page.screenshot({path:path.join(out,id+'.png')});await persist()
  console.log(JSON.stringify({id,stopToNativePixelsMs:row.stopToNativePixelsMs,upscale:row.maximumMotionUpscale,pixelsStable:row.pixelsStable}))
 }
 report.status=report.cases.every(c=>c.pixelsStable)?'complete':'failed-consistency'
 report.strictAcceptance={status:report.cases.some(c=>c.stopToNativePixelsMs>100||c.maximumMotionUpscale>1||c.pixels.transparentPixels)?'FAIL':'INCOMPLETE',
  reason:'33 ms latest visible pixel P95 remains unmeasured; ACKs and final screenshots cannot certify every motion frame.'}
}catch(e){report.status='failed';report.error=String(e);if(page){report.failureState=await page.locator('.kernel-tiles').evaluateAll(es=>es.map(e=>({...e.dataset}))).catch(()=>[]);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}process.exitCode=1}
finally{
 if(app){const child=app.process();let timer
  try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned close timeout')),15000)})])}
  catch(e){report.closeError=String(e);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}
  finally{clearTimeout(timer)}
 }
 await Promise.allSettled(writes);report.sourceAfter=await sha();assert.equal(report.sourceAfter,report.sourceBefore)
 report.checkedAfter=await verifyArtifacts(base,bundle,manifest);await persist();console.log(JSON.stringify({status:report.status,error:report.error}))
}
