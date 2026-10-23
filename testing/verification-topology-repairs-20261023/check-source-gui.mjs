// Actual Sketch source adapter -> shared Editor/Canvas -> source save/export.
// The save dialog destination alone is controlled; renderer and native I/O are real.
import assert from'node:assert/strict'
import{readFile,writeFile,mkdir,rm,realpath}from'node:fs/promises'
import{createRequire}from'node:module'
import{createHash}from'node:crypto'
import path from'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-topology-repairs-20261023'),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client')
const manifest=JSON.parse(await readFile(path.join(out,'baseline-manifest.json'),'utf8')),name=process.argv[2]||'source-gui'
const own=path.join(manifest.privateRuntimeRoot,name),temporary=path.join(own,'tmp');await mkdir(temporary,{recursive:true})
const host=process.argv[3]||path.join(manifest.privateRuntimeRoot,'candidate-edit-runtime/host'),exportFile=path.join(own,'topology-repaired-verification.sketch')
const fixtures=JSON.parse(await readFile(path.join(out,'source-fixtures.json'),'utf8')).records
const cases=[];for(const item of fixtures){const doc=JSON.parse(await readFile(item.file,'utf8')),id=doc.pages.find(p=>p.children.length).children[0],node=doc.nodes[id];cases.push({key:item.key,id,originalName:node.name,locked:node.locked,expectedName:node.name.slice(0,150)+' · render-check-'+cases.length})}
const require=createRequire(path.join(client,'package.json')),{_electron,expect}=require('@playwright/test')
const record={status:'running',scope:'owned isolated Electron; real source import/Canvas/edit/save/export; preset save-dialog destination; visibility recorded explicitly; not physical scanout/FPS',cases:[],exportFile};let app,page,profile
const persist=async()=>writeFile(path.join(out,name+'.json'),JSON.stringify(record,null,2)+'\n')
async function launch(file){
 app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],timeout:60000,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),TMPDIR:temporary,CORE_RENDER_DIAGNOSTICS:'detail',CORE_DOCUMENT_MEMORY_BYTES:'1219977216',CORE_DOCUMENT_MEMORY_INHERITED:'1'}})
 app.process().stdout?.on('data',data=>{void import('node:fs/promises').then(fs=>fs.appendFile(path.join(own,'host-stdout.log'),data))});app.process().stderr?.on('data',data=>{void import('node:fs/promises').then(fs=>fs.appendFile(path.join(own,'host-stderr.log'),data))})
 page=await app.firstWindow();profile=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setTitle('拓扑素材独立回归 · 自动检查');if(process.env.SOURCE_GUI_VISIBLE==='1')w.showInactive();else w.hide();return app.getPath('userData')})
 record.visibility=await page.evaluate(()=>document.visibilityState);record.nativeVisible=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible());await persist()
 await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},exportFile)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
 await expect(page.locator('.source-workspace-header strong')).toContainText(path.basename(file),{timeout:120000})
 await expect(page.getByLabel('搜索源对象',{exact:true})).toBeEnabled({timeout:120000})
}
async function select(item){
 await page.getByRole('button',{name:'源文件 / 页面',exact:true}).click()
 await page.getByLabel('搜索源对象',{exact:true}).fill(item.id);await page.getByRole('button',{name:'搜索',exact:true}).click()
 await expect(page.locator(`[data-source-key="${item.key}"]`)).toBeVisible({timeout:30000})
 await page.locator(`[data-source-key="${item.key}"] > button`).first().click()
 await page.waitForFunction(()=>!!document.querySelector('.source-workspace-status [role=alert]')||document.querySelector('.source-workspace-status')?.textContent?.includes('已载入'),null,{timeout:180000})
 const error=await page.locator('.source-workspace-status [role=alert]').allTextContents();assert.equal(error.length,0,error.join('\n'))
 await expect(page.getByTestId('layer-'+item.id)).toBeVisible({timeout:30000})
 await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:180000})
 const canvasErrors=await page.locator('.kernel-status.error').allTextContents();assert.equal(canvasErrors.length,0,canvasErrors.join('\n'))
 assert.equal(await page.locator('.kernel-tiles').getAttribute('data-renderer'),'webgpu')
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
 console.log('opening-original');await launch('/Users/Apple/Downloads/拓扑素材.sketch')
 for(const item of cases){console.log('loading',item.key);const started=performance.now(),row=await select(item)
  await row.click();await row.press('F2');const input=page.getByLabel('重命名图层',{exact:true});await expect(input).toBeVisible();await input.fill(item.expectedName);await input.press('Enter')
  await expect(row.locator('.layer-name')).toHaveText(item.expectedName)
  await page.locator('.source-workspace-tools').getByRole('button',{name:'撤销画布修改',exact:true}).click();await expect(row.locator('.layer-name')).toHaveText(item.originalName)
  await page.locator('.source-workspace-tools').getByRole('button',{name:'重做',exact:true}).click();await expect(row.locator('.layer-name')).toHaveText(item.expectedName)
  await page.locator('.source-workspace-header').getByRole('button',{name:'保存修改',exact:true}).click()
  await expect(page.locator('.source-workspace-status')).toContainText('画布修改已保存到源文件缓存',{timeout:60000})
  const screenshot=path.join(own,item.key.replace(':','-')+'.png');await page.locator('.source-workspace-canvas').screenshot({path:screenshot})
  record.cases.push({key:item.key,id:item.id,imported:true,webgpu:true,renameUndoRedo:true,saved:true,elapsedMs:performance.now()-started,screenshot,screenshotSha256:createHash('sha256').update(await readFile(screenshot)).digest('hex')});await persist();console.log('saved',item.key)
 }
 await page.locator('.source-workspace-header').getByRole('button',{name:'导出完整文件…',exact:true}).click();await expect(page.locator('.source-workspace-status')).toContainText('完整文件已导出',{timeout:180000})
 record.exportBytes=(await import('node:fs/promises')).stat(exportFile).then(s=>s.size);record.exportBytes=await record.exportBytes;await persist();await closeAndClear()
 console.log('reopening-export');await launch(exportFile)
 for(const item of cases){const row=await select(item);await expect(row.locator('.layer-name')).toHaveText(item.expectedName);record.cases.find(r=>r.key===item.key).guiReopened=true;await persist()}
 record.status='passed';await persist();console.log(JSON.stringify(record))
}catch(error){record.status='failed';record.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:path.join(own,'failure.png')}).catch(()=>{});await persist();throw error}
finally{await closeOwned()}
