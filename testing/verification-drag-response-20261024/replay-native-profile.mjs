import {startNativeProfiles} from './native-profile.mjs'
import assert from 'node:assert/strict'
import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { foreground } from './foreground.mjs'
import { startProfiles,stopProfiles } from './profile-helpers.mjs'
const root=process.cwd(),out=path.join(root,'testing/verification-drag-response-20261024'),base=JSON.parse(await readFile(path.join(out,'baseline.json'),'utf8'))
const kind=process.argv[2]||'117',name=process.argv[3]||kind+'-baseline',host=process.env.DRAG_HOST||base.host,run=path.join(out,name),tmp=path.join(base.runtime,name)
await mkdir(run);await mkdir(tmp)
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const report={status:'running',probeVersion:2,host,kind,scope:'sampler-on native Rust and optional V8; independent foreground Electron; native mouse input, rAF DOM cameras and compositor acknowledgements; no physical scanout claim',phases:[],errors:[]}
let app,page;const writes=[];const persist=()=>writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
const settle=async()=>{await page.waitForTimeout(150);await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true'&&document.querySelector('.kernel-presentation')?.dataset.presentationReady==='true',null,{timeout:120000});assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[])}
async function replay(label,tool){
  await page.keyboard.press(tool);await page.getByTestId('canvas').focus();await settle();await foreground(app,page)
  const box=await page.getByTestId('canvas').boundingBox(),x=Math.round(box.x+box.width*.5),y=Math.round(box.y+box.height*.55)
  await page.evaluate(label=>{
    window.__dragProbe={label,origin:performance.timeOrigin,start:performance.now(),events:[],frames:[]};const p=window.__dragProbe
    const tick=t=>{const root=document.querySelector('.kernel-tiles'),shown=document.querySelector('.kernel-presentation'),c=document.querySelector('.kernel-compositor');p.frames.push({t,requested:root?{x:+root.dataset.requestedCameraX,y:+root.dataset.requestedCameraY,z:+root.dataset.requestedCameraZoom}:null,shown:shown?{x:+(shown.dataset.visualCameraX??shown.dataset.cameraX),y:+(shown.dataset.visualCameraY??shown.dataset.cameraY),z:+shown.dataset.cameraZoom}:null,settled:shown?{x:+shown.dataset.cameraX,y:+shown.dataset.cameraY,z:+shown.dataset.cameraZoom}:null,compositor:c?{...c.dataset}:null});p.raf=requestAnimationFrame(tick)};p.raf=requestAnimationFrame(tick)
    for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{if(window.__dragProbe===p)p.events.push({t:performance.now(),type,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted,coalesced:e.getCoalescedEvents?.().length})},{capture:true})
  },label)
  const native=await startNativeProfiles(app,host,run,label);const start=Date.now();if(process.env.DRAG_PROFILE==='1')await startProfiles(app)
  const dispatch=await app.evaluate(async({BrowserWindow},{x,y})=>{
    const w=BrowserWindow.getAllWindows()[0],rows=[]
    w.webContents.sendInputEvent({type:'mouseMove',x,y})
    w.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1})
    const started=performance.now()
    for(let i=1;i<=60;i++){
      const wait=i*16-(performance.now()-started);if(wait>0)await new Promise(r=>setTimeout(r,wait))
      const px=x+Math.round(180*i/60),py=y+Math.round(80*i/60)
      w.webContents.sendInputEvent({type:'mouseMove',x:px,y:py,modifiers:['leftButtonDown']});rows.push({at:Date.now(),x:px,y:py})
    }
    w.webContents.sendInputEvent({type:'mouseUp',x:x+180,y:y+80,button:'left',clickCount:1});return rows
  },{x,y})
  const stopped=Date.now();await settle();const ended=Date.now()
  if(process.env.DRAG_PROFILE==='1'){const p=path.join(run,label+'-profile');await mkdir(p);await stopProfiles(app,p,host)}
  const probe=await page.evaluate(()=>{const p=window.__dragProbe;cancelAnimationFrame(p.raf);window.__dragProbe=undefined;return p})
  await writeFile(path.join(run,label+'-frames.json'),JSON.stringify(probe,null,2));await page.screenshot({path:path.join(run,label+'.png')})
  report.phases.push({label,start,stopped,ended,nativeProfile:{owner:native.owner,candidates:native.candidates,results:await native.done()},dispatch,frames:probe.frames.length,events:probe.events.length,final:probe.frames.at(-1)});await persist()
  assert(probe.events.some(e=>e.type==='pointerdown'&&e.trusted));assert(probe.events.some(e=>e.type==='pointerup'&&e.trusted))
}
try{
  app=await _electron.launch({executablePath:path.join(root,'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],cwd:host,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CORE_GPU_WORKING_BUDGET_MIB'].includes(k))),TMPDIR:tmp,CORE_RENDER_DIAGNOSTICS:'detail'},timeout:60000})
  for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',d=>writes.push(appendFile(path.join(run,'host.log'),d)))
  page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(String(e)))
  report.instance=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.setTitle('独立平移与拖动验证');return {pid:process.pid,profile:app.getPath('userData')}})
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  const file=kind==='fig'?'/Users/Apple/Downloads/01有料素材 (Copy).fig':kind==='sketch'?'/Users/Apple/Downloads/拓扑素材.sketch':'/Users/Apple/Downloads/117.sketch'
  report.fixture=file;await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
  if(kind==='sketch'){
    await expect(page.locator('.app-shell')).toHaveAttribute('data-source-document','true',{timeout:120000});await expect(page.locator('.header-right').getByRole('button',{name:'保存',exact:true})).toBeEnabled({timeout:180000});await settle();await page.getByRole('button',{name:'页面 / 画板',exact:true}).click();await page.locator('[aria-label="搜索源对象"]').fill('控件');await page.getByRole('button',{name:'搜索',exact:true}).click()
    const row=page.locator('.source-workspace-rows > div').filter({hasText:'完整页面'});await expect(row).toHaveCount(1);await row.locator('button').first().click();await settle()
    await page.locator('[aria-label="搜索图层"]').fill('数据名称');await page.getByTestId('layer-4F1BF005-CF98-4296-8A6B-9194F5146DAD').click()
  }else{
    await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(kind==='fig'?'01有料素材 (Copy)':'117',{timeout:90000});await settle()
    await page.locator('[aria-label="搜索图层"]').fill(kind==='fig'?'01_Dashboard':'117');await page.locator('.layer-name').filter({hasText:kind==='fig'?/^01_Dashboard$/:/^117$/}).first().click()
  }
  await page.keyboard.press('Shift+2');await settle();await page.screenshot({path:path.join(run,'before.png')})
  await replay('pan','h');await page.keyboard.press('v');await page.keyboard.press('Shift+2');await settle();await replay('object','v')
  await page.keyboard.press('Meta+z');await settle();await page.keyboard.press('Meta+Shift+z');await settle()
  report.status='captured'
}catch(error){report.status='failed';report.error=String(error);report.stack=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});process.exitCode=1}
finally{
  if(app){const owned=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned close timeout')),15000))])}catch(e){report.closeError=String(e);if(owned.exitCode===null&&owned.signalCode===null)owned.kill('SIGTERM')}finally{clearTimeout(timer)}}
  await Promise.allSettled(writes);await persist();console.log(JSON.stringify({status:report.status,error:report.error,phases:report.phases.map(p=>({label:p.label,settleMs:p.ended-p.stopped,events:p.events}))}))
}
