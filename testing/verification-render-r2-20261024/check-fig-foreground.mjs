import { foreground } from './foreground.mjs'
import assert from 'node:assert/strict'
import {readFile,writeFile,appendFile,mkdir,stat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import path from 'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-render-r2-20261024')
const baseline=JSON.parse(await readFile(path.join(out,'baseline.json'),'utf8'))
Object.assign(baseline,{"fixture": "/Users/Apple/Downloads/01有料素材 (Copy).fig", "fixtureSha256": "701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46", "bytes": 649304, "title": "01有料素材 (Copy)"})
const host=process.env.FIG_HOST||path.join(baseline.runtime,'host'),name=process.argv[2]||'fig-gui-1'
const run=path.join(out,name),tmp=path.join(baseline.runtime,name);await mkdir(run);await mkdir(tmp)
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const report={status:'running',scope:'visible independent Electron; real native input, WebGPU, Editor/WASM, SQLite and external FD; only save-dialog path preset; no physical scanout/FPS claim',checks:[],stages:[]}
let app,page,target,original,saved,fd=path.join(tmp,'verified-fig.fd')
const persist=()=>writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
async function step(name,fn){console.log(name);report.stage=name;await persist();const start=performance.now();const result=await fn();report.stages.push({name,ms:performance.now()-start});await persist();return result}
async function close(){if(!app)return;const owned=app,child=owned.process();app=null;let timer;try{await Promise.race([owned.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned Electron close timeout')),15000)})])}catch(error){report.closeErrors??=[];report.closeErrors.push(String(error));if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}finally{clearTimeout(timer)}}
async function launch(file){
 app=await _electron.launch({executablePath:path.join(root,'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],cwd:host,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(k))),TMPDIR:tmp,CORE_RENDER_DIAGNOSTICS:'detail'},timeout:60000})
 for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',d=>{void appendFile(path.join(run,'host.log'),d)})
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>{report.pageErrors??=[];report.pageErrors.push(String(e))})
 const identity=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setTitle('FIG 独立回归验证');w.show();return {pid:process.pid,profile:app.getPath('userData'),visible:w.isVisible(),versions:process.versions,preferences:w.webContents.getLastWebPreferences()}})
 report.fixture=baseline.fixture;report.host=host;report.instances??=[];report.instances.push(identity);await persist()
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
 await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue("01有料素材 (Copy)",{timeout:60000})
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000});await settle()
}
async function settle(){await page.waitForTimeout(100);await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true'&&document.querySelector('.kernel-presentation')?.dataset.presentationReady==='true',null,{timeout:90000});assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[]);assert.equal(await page.locator('.kernel-tiles').getAttribute('data-renderer'),'webgpu')}
async function stored(){return page.evaluate(async()=>{const l=await window.coreDesktop.workspace.list();if(l.status!=='ok')throw Error(l.message);const e=l.documents.find(d=>d.name==="01有料素材 (Copy)");if(!e)throw Error('saved document absent');const r=await window.coreDesktop.workspace.open({id:e.id});if(r.status!=='ok')throw Error(r.message);return JSON.parse(r.documentJson)})}
async function probeStart(){report.foreground??=[];report.foreground.push(await foreground(app,page));await page.evaluate(()=>{const m=window.__figMetrics={last:performance.now(),max:0,stalls:[],events:[],frames:[]};const tick=t=>{const dt=t-m.last;m.last=t;m.max=Math.max(m.max,dt);if(dt>250)m.stalls.push({at:t,ms:dt});if(m.frames.length<6000){const d=document.querySelector('.kernel-tiles')?.dataset;m.frames.push({at:t,camera:d?.cameraZoom,requested:d?.requestedCameraZoom,revision:d?.revision,detail:d?.detailReady})}m.raf=requestAnimationFrame(tick)};m.raf=requestAnimationFrame(tick);for(const type of ['wheel','keydown','pointerdown'])document.addEventListener(type,e=>{if(window.__figMetrics===m)m.events.push({at:performance.now(),type,key:e.key,dy:e.deltaY,trusted:e.isTrusted})},true)})}
async function probeEnd(name){const m=await page.evaluate(()=>{cancelAnimationFrame(window.__figMetrics.raf);return {...window.__figMetrics,foregroundEvents:window.__ownedForegroundEvents}});await writeFile(path.join(run,name+'-frames.json'),JSON.stringify(m));report.checks.push({name,uiIntervalMaxMs:m.max,uiStalls:m.stalls.length});return m}
async function zoom(v){await page.locator('.view-menu summary').click();const input=page.getByLabel('缩放比例',{exact:true});await input.fill(String(v));await input.press('Enter');await input.press('Escape')}
async function property(value){const input=page.getByLabel('透明度 %',{exact:true});await input.fill(String(value));await input.press('Enter');await input.press('Tab');await expect(input).toHaveValue(String(value));await settle()}
try{
 await step('import-original',()=>launch(baseline.fixture));await page.screenshot({path:path.join(run,'01-import.png')})
 original=await step('read-imported-sqlite',stored);await writeFile(path.join(tmp,'original.json'),JSON.stringify(original))
 target=original.pages[0].children.map(id=>original.nodes[id]).find(n=>n.name==="01_Dashboard");assert(target)
 await page.getByTestId('layer-'+target.id).click();await page.keyboard.press('Shift+2');await settle()
 await step('quick-zoom',async()=>{
  report.motionStart=Date.now();await probeStart();await zoom(100);await settle();await page.screenshot({path:path.join(run,'02-zoom-before.png')})
  await zoom(3200);await page.waitForTimeout(80);await zoom(100);await settle()
  const box=await page.getByTestId('canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.keyboard.down('Control');for(const dy of [-180,-180,-180,180,180,180,-240,-240,240,240]){await page.mouse.wheel(0,dy);await page.waitForTimeout(16)}await page.keyboard.up('Control');await settle()
  await zoom(100);await settle();await page.screenshot({path:path.join(run,'03-zoom-return.png')});await probeEnd('quick-zoom');report.motionEnd=Date.now()
 })
 await step('property-undo-redo',async()=>{
  report.propertyStart=Date.now();let cdp;if(process.env.FIG_PROFILE==='1'){cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});await cdp.send('Profiler.start')}await probeStart();await property(87.5);await page.keyboard.press('Meta+z');await expect(page.getByLabel('透明度 %',{exact:true})).toHaveValue('100');await settle();await page.keyboard.press('Meta+Shift+z');await expect(page.getByLabel('透明度 %',{exact:true})).toHaveValue('87.5');await settle();await property(90);await probeEnd('property-undo-redo');if(cdp){const {profile}=await cdp.send('Profiler.stop');await writeFile(path.join(run,'properties.cpuprofile'),JSON.stringify(profile));await cdp.detach()}report.propertyEnd=Date.now();await page.screenshot({path:path.join(run,'04-edited.png')})
 })
 await step('save-sqlite',async()=>{await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000});saved=await stored();assert.equal(saved.nodes[target.id].opacity,.9);const expected=structuredClone(original);expected.nodes[target.id].opacity=.9;assert.deepEqual(saved,expected);await writeFile(path.join(tmp,'saved.json'),JSON.stringify(saved))})
 await step('save-external-fd',async()=>{await app.evaluate(({dialog},fd)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:fd})},fd);await page.getByLabel('文件菜单',{exact:true}).click();await page.getByRole('button',{name:'另存为设计文件…',exact:true}).click();await expect.poll(async()=>stat(fd).then(s=>s.size).catch(()=>0),{timeout:60000}).toBeGreaterThan(0);await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000});report.fd={path:fd,bytes:(await stat(fd)).size,sha256:createHash('sha256').update(await readFile(fd)).digest('hex')}})
 await step('normal-close',close)
 await step('reopen-external-fd',async()=>{await launch(fd);const reopened=await stored();report.importCopyIds={saved:saved.id,reopened:reopened.id};assert.deepEqual({...reopened,id:saved.id},saved);await page.getByTestId('layer-'+target.id).click();await expect(page.getByLabel('透明度 %',{exact:true})).toHaveValue('90');await page.screenshot({path:path.join(run,'05-reopened.png')});report.reopenExactExceptImportCopyId=true})
 assert.equal(createHash('sha256').update(await readFile(baseline.fixture)).digest('hex'),baseline.fixtureSha256)
 report.status=report.checks.some(c=>c.uiStalls)?'interaction-failed':'passed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error.stack;if(page&&!page.isClosed()){report.ui=await page.locator('body').innerText().catch(()=>undefined);await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{})}console.error(error);process.exitCode=1}
finally{await close();await persist();console.log(JSON.stringify({status:report.status,stage:report.stage,checks:report.checks,error:report.error}))}
