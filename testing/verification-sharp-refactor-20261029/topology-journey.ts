import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const root=process.cwd(),out=process.argv[2],source='/Users/Apple/Downloads/拓扑素材.sketch'
const {_electron,expect}=createRequire(path.join(process.cwd(),'frontend/design-client/package.json'))('@playwright/test')
if(!out||!path.isAbsolute(out))throw Error('Fresh absolute output required')
await fs.mkdir(out);const profiles=path.join(out,'profiles');await fs.mkdir(profiles)
const desktop=path.join(root,'frontend/design-desktop'),require=createRequire(path.join(desktop,'package.json'))
const target={id:'B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105',name:'拼搭样式二'},exported=path.join(out,'topology-roundtrip.sketch')
const hash=async(p:string)=>createHash('sha256').update(await fs.readFile(p)).digest('hex')
const report:any={status:'running',source,sourceHash:await hash(source),target,cases:[],scope:'Full source import; one real 274-node artboard GUI edit/undo/save/complete Sketch export/reopen. Full overview latency is a separate test.'}
let app:any,page:any
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
async function stage(id:string,fn:()=>Promise<void>){report.stage=id;await persist();try{await fn();report.cases.push({id,status:'PASS'})}catch(e){report.cases.push({id,status:'FAIL',error:String(e)});throw e}finally{await persist();console.log(id)}}
async function close(){if(!app)return;const owned=app,child=owned.process();app=undefined;let timer:any
 try{await Promise.race([owned.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned app close timeout')),15000)})])}
 catch(e){report.closeErrors??=[];report.closeErrors.push(String(e));if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}
 finally{clearTimeout(timer)}}
async function launch(file:string){
 const env={...process.env,TMPDIR:profiles,CORE_RENDER_DIAGNOSTICS:'detail'};delete (env as any).ELECTRON_RUN_AS_NODE
 app=await _electron.launch({executablePath:require('electron'),args:[desktop,'--desktop-isolated-profile'],cwd:desktop,env,chromiumSandbox:true,timeout:60000})
 for(const s of [app.process().stdout,app.process().stderr])s?.on('data',(data:Buffer)=>{void fs.appendFile(path.join(out,'host.log'),data)})
 page=await app.firstWindow();page.setDefaultTimeout(30000)
 page.on('pageerror',(e:Error)=>{report.pageErrors??=[];report.pageErrors.push(String(e))})
 report.instances??=[];report.instances.push(await app.evaluate(({app,BrowserWindow}:any)=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.setSize(1440,960);w.setTitle('拓扑完整源 · 独立回归');return {pid:process.pid,profile:app.getPath('userData'),preferences:w.webContents.getLastWebPreferences()}}))
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-source-document','true',{timeout:180000})
 await expect(page.locator('.source-pages-heading')).toContainText('306 个素材',{timeout:180000})
 await expect(page.locator('.native-source-surface')).toHaveCount(1)
 await page.getByLabel('搜索素材',{exact:true}).fill(target.name)
 const button=page.locator('.source-page-entry').filter({has:page.locator('.source-row-name',{hasText:new RegExp('^'+target.name+'$')})})
 await expect(button).toHaveCount(1);await button.dblclick()
 await expect(page.getByTestId('layer-'+target.id)).toBeVisible({timeout:180000})
 await settle();await page.getByTestId('layer-'+target.id).click();await page.keyboard.press('Shift+2');await settle()
}
async function settle(){
 await page.waitForFunction(()=>document.querySelector('.kernel-status.error,.source-status-card [role=alert]')||document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:180000})
 expect(await page.locator('.kernel-status.error,.source-status-card [role=alert]').allTextContents()).toEqual([])
}
async function zoom(value:string){await page.locator('.view-menu summary').click();const input=page.getByLabel('缩放比例',{exact:true});await input.fill(value);await input.press('Enter');await input.press('Escape')}
try{
 await stage('import-full-source-open-artboard',async()=>{await launch(source);await page.screenshot({path:path.join(out,'01-artboard.png')})})
 await stage('zoom-pan',async()=>{
  const original=await page.getByLabel('X',{exact:true}).inputValue()
  await zoom('3200');await page.waitForTimeout(80);await zoom('125');await settle()
  const canvas=page.getByTestId('canvas'),b=await canvas.boundingBox();await canvas.focus();await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
  await page.keyboard.down('Control');for(const dy of [-120,-160,180,100]){await page.mouse.wheel(0,dy);await page.waitForTimeout(16)}await page.keyboard.up('Control');await settle()
  await page.keyboard.down('Space');await page.mouse.down();await page.mouse.move(b.x+b.width/2+64,b.y+b.height/2+32,{steps:12});await page.mouse.up();await page.keyboard.up('Space');await settle()
  await expect(page.getByLabel('X',{exact:true})).toHaveValue(original);await page.keyboard.press('Shift+2');await settle()
 })
 await stage('drag-resize-rotate-undo',async()=>{
  const x=page.getByLabel('X',{exact:true}),before=await x.inputValue(),canvas=page.getByTestId('canvas'),b=await canvas.boundingBox()
  await canvas.focus();await page.keyboard.press('v');await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+40,b.y+b.height/2+20,{steps:10});await page.mouse.up();await settle()
  expect(await x.inputValue()).not.toBe(before);await page.keyboard.press('Meta+z');await expect(x).toHaveValue(before);await settle()
  for(const name of ['W','旋转 °']){const input=page.getByLabel(name,{exact:true}),original=await input.inputValue();await input.fill(String(Number(original)+5));await input.press('Enter');await input.press('Tab');await settle();await page.keyboard.press('Meta+z');await expect(input).toHaveValue(original);await settle()}
 })
 await stage('opacity-history-save',async()=>{
  const opacity=page.getByLabel('透明度 %',{exact:true});await expect(opacity).toHaveValue('100');await opacity.fill('87.5');await opacity.press('Enter');await opacity.press('Tab');await settle()
  await page.keyboard.press('Meta+z');await expect(opacity).toHaveValue('100');await settle();await page.keyboard.press('Meta+Shift+z');await expect(opacity).toHaveValue('87.5');await settle()
  await page.locator('.header-right').getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.source-canvas-status')).toContainText('画布修改已保存到源文件缓存',{timeout:120000})
  await page.screenshot({path:path.join(out,'02-edited.png')})
 })
 await stage('complete-sketch-export',async()=>{
  await app.evaluate(({dialog}:any,file:string)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},exported)
  await page.getByLabel('文件菜单',{exact:true}).click();await page.getByRole('button',{name:'导出完整文件…',exact:true}).click()
  await expect(page.locator('.source-canvas-status')).toContainText('完整文件已导出',{timeout:180000});expect((await fs.stat(exported)).size).toBeGreaterThan(100_000_000)
 })
 await stage('fresh-sketch-reopen',async()=>{await close();await launch(exported);await expect(page.getByLabel('透明度 %',{exact:true})).toHaveValue('87.5');await page.screenshot({path:path.join(out,'03-reopened.png')})})
 report.status='passed'
}catch(e){report.status='failed';report.error=String(e);if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}
finally{await close();report.sourceUnchanged=report.sourceHash===await hash(source);if(!report.sourceUnchanged)report.status='failed';await persist();console.log(JSON.stringify({status:report.status,cases:report.cases,error:report.error}));if(report.status!=='passed')process.exitCode=1}
