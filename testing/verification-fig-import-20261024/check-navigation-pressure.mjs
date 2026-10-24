// Actual Sketch source adapter -> shared Editor/Canvas -> source save/export.
// The save dialog destination alone is controlled; renderer and native I/O are real.
import assert from'node:assert/strict'
import{readFile,writeFile,mkdir,rm,realpath}from'node:fs/promises'
import{createRequire}from'node:module'
import{createHash}from'node:crypto'
import path from'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-fig-import-20261024'),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client')
const manifest=JSON.parse(await readFile(path.join(out,'baseline.json'),'utf8')),name=process.argv[2]||'sketch-gui-1'
const own=path.join(out,name),temporary=path.join(manifest.runtime,name);await mkdir(own);await mkdir(temporary)
const host=process.env.FIG_HOST||path.join(manifest.runtime,'host'),exportFile=path.join(temporary,'topology-verified.sketch')
const cases=JSON.parse(await readFile(path.join(out,'sketch-cases.json'),'utf8'))
const require=createRequire(path.join(client,'package.json')),{_electron,expect}=require('@playwright/test')
const record={status:'running',scope:'owned isolated Electron; real source import/Canvas/edit/save/export; preset save-dialog destination; visibility recorded explicitly; not physical scanout/FPS',cases:[],exportFile};let app,page,profile
const persist=async()=>writeFile(path.join(out,name+'.json'),JSON.stringify(record,null,2)+'\n')
async function launch(file){
 app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],timeout:60000,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),TMPDIR:temporary,CORE_RENDER_DIAGNOSTICS:'detail'}})
 app.process().stdout?.on('data',data=>{void import('node:fs/promises').then(fs=>fs.appendFile(path.join(own,'host-stdout.log'),data))});app.process().stderr?.on('data',data=>{void import('node:fs/promises').then(fs=>fs.appendFile(path.join(own,'host-stderr.log'),data))})
 page=await app.firstWindow();profile=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setTitle('拓扑素材独立回归 · 自动检查');w.show();return app.getPath('userData')})
 record.visibility=await page.evaluate(()=>document.visibilityState);record.nativeVisible=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible());await persist()
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},exportFile)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.getByRole('button',{name:'新建设计',exact:true}).click()
 await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
 await expect(page.locator('.source-workspace-header strong')).toContainText(path.basename(file),{timeout:120000})
 await expect(page.locator('[aria-label="搜索源对象"]')).toBeEnabled({timeout:120000})
}
async function select(item){
 await page.getByRole('button',{name:'源文件 / 页面',exact:true}).click()
 await page.locator('[aria-label="搜索源对象"]').fill(item.id);await page.getByRole('button',{name:'搜索',exact:true}).click()
 await expect(page.locator(`[data-source-key="${item.key}"]`)).toBeVisible({timeout:30000})
 await page.locator(`[data-source-key="${item.key}"] > button`).first().click()
 await page.waitForFunction(()=>!!document.querySelector('.source-workspace-status [role=alert]')||document.querySelector('.source-workspace-status')?.textContent?.includes('已载入'),null,{timeout:180000})
 const error=await page.locator('.source-workspace-status [role=alert]').allTextContents();assert.equal(error.length,0,error.join('\n'))
 await expect(page.getByTestId('layer-'+item.id)).toBeVisible({timeout:30000})
 await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:180000})
 const canvasErrors=await page.locator('.kernel-status.error').allTextContents();assert.equal(canvasErrors.length,0,canvasErrors.join('\n'))
 assert.equal(await page.locator('.kernel-tiles').getAttribute('data-renderer'),'webgpu')
 const layout=await page.evaluate(()=>{const list=document.querySelector('.source-workspace-navigation .layer-list'),nav=document.querySelector('.source-workspace-navigation');return {mountedRows:list.querySelectorAll('[role=treeitem]').length,listHeight:list.clientHeight,scrollHeight:list.scrollHeight,navigationHeight:nav.clientHeight}})
 record.layouts??=[];record.layouts.push({key:item.key,...layout});await persist();assert(layout.listHeight<=layout.navigationHeight);assert(layout.mountedRows<=Math.ceil(layout.listHeight/32)+14)

 return page.getByTestId('layer-'+item.id)
}
async function closeOwned(){
 if(!app)return;const ownedApp=app,child=ownedApp.process();let timer
 try{await Promise.race([ownedApp.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned source GUI close timeout')),15000)})])}
 catch(error){record.closeNotes??=[];record.closeNotes.push(String(error));if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve))}await persist()}
 finally{clearTimeout(timer);app=undefined}
}
async function closeAndClear(){if(!app)return;const ownedProfile=profile;await closeOwned();assert((await realpath(ownedProfile)).startsWith((await realpath(temporary))+path.sep));await rm(ownedProfile,{recursive:true,force:true})}
try{
 await launch('/Users/Apple/Downloads/拓扑素材.sketch');await page.locator('[aria-label="搜索源对象"]').fill('控件');await page.getByRole('button',{name:'搜索',exact:true}).click()
 const candidates=page.locator('.source-workspace-rows > div').filter({hasText:'完整页面'});await expect(candidates).toHaveCount(1,{timeout:30000});record.sourceKey=await candidates.getAttribute('data-source-key');await candidates.locator('button').first().click()
 await expect(page.locator('.source-workspace-status')).toContainText('已载入',{timeout:120000})
 const settle=async()=>{await page.waitForTimeout(100);await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true',null,{timeout:90000});assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[])}
 await settle();record.nativeVisibleTiles=await page.locator('.kernel-tiles').getAttribute('data-native-visible-tiles');await page.screenshot({path:path.join(own,'before.png')})
 const zoom=async value=>{await page.locator('.source-workspace-canvas .view-menu summary').click();const input=page.locator('[aria-label="缩放比例"]');await input.fill(String(value));await input.press('Enter');await input.press('Escape')}
 if(process.env.FOCUS_CONTROL==='1'){record.focusNodeId='4F1BF005-CF98-4296-8A6B-9194F5146DAD';await page.locator('[aria-label="搜索图层"]').fill('数据名称');await page.getByTestId('layer-'+record.focusNodeId).click();await page.keyboard.press('Shift+2');await settle()}
 await zoom(12.6);await settle();record.motionStart=Date.now();record.actions=[]
 await page.evaluate(()=>{const m=window.__pressureMetrics={last:performance.now(),max:0,stalls:[],inputs:[]};const tick=t=>{const dt=t-m.last;m.last=t;m.max=Math.max(m.max,dt);if(dt>250)m.stalls.push({at:t,ms:dt});m.raf=requestAnimationFrame(tick)};m.raf=requestAnimationFrame(tick);document.addEventListener('keydown',e=>m.inputs.push({at:performance.now(),key:e.key,trusted:e.isTrusted}),true)})
 for(let round=0;round<3;round++)for(const value of [50,200,800,3200,800,200,50,12.6]){const at=Date.now();await zoom(value);record.actions.push({round,value,at});await page.waitForTimeout(80);if(process.env.FOCUS_CONTROL==='1'&&value===3200){const canvas=page.getByTestId('canvas'),box=await canvas.boundingBox();await canvas.focus();await page.keyboard.down('Space');await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+11.25,box.y+box.height/2-7.5,{steps:2});await page.mouse.up();await page.keyboard.up('Space');record.actions.push({round,kind:'pan',dx:11.25,dy:-7.5,at:Date.now()})}}
 await settle();record.motionEnd=Date.now();record.metrics=await page.evaluate(()=>{cancelAnimationFrame(window.__pressureMetrics.raf);return window.__pressureMetrics});await page.screenshot({path:path.join(own,'after.png')});record.status=record.metrics.stalls.length?'interaction-failed':'functional-passed-quality-pending';await persist();console.log(JSON.stringify({status:record.status,sourceKey:record.sourceKey,nativeVisibleTiles:record.nativeVisibleTiles,max:record.metrics.max,stalls:record.metrics.stalls.length}))
 await page.locator('.source-workspace-header').getByRole('button',{name:'返回设计',exact:true}).click();await expect(page.locator('.source-workspace-header')).toHaveCount(0,{timeout:60000})
}catch(error){record.status='failed';record.error=String(error);if(page&&!page.isClosed()){record.ui=await page.locator('body').innerText().catch(()=>undefined);await page.screenshot({path:path.join(own,'failure.png')}).catch(()=>{})}await persist();throw error}finally{await closeOwned()}
