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
 await launch('/Users/Apple/Downloads/拓扑素材.sketch');await select(cases[1]);record.layout=await page.evaluate(()=>{const list=document.querySelector('.source-workspace-navigation .layer-list'),nav=document.querySelector('.source-workspace-navigation');return {mountedRows:list.querySelectorAll('[role=treeitem]').length,listHeight:list.clientHeight,scrollHeight:list.scrollHeight,navigationHeight:nav.clientHeight}});record.status='observed';await persist();console.log(JSON.stringify(record.layout));await page.locator('.source-workspace-header').getByRole('button',{name:'返回设计',exact:true}).click();await expect(page.locator('.source-workspace-header')).toHaveCount(0,{timeout:60000})
}finally{await closeOwned()}
