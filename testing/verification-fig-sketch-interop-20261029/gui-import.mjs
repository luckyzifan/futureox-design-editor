import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),[products,out]=process.argv.slice(2)
if(!products||!out)throw Error('Usage: gui-import.mjs PRODUCTS FRESH_OUTPUT')
await fs.mkdir(out,{recursive:true});const host=path.join(out,'host');await fs.mkdir(host)
const manifest=JSON.parse(await fs.readFile(path.join(products,'build-manifest.json'),'utf8'));assert.deepEqual(await buildInputs(root),manifest.sources)
await fs.cp(path.join(root,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(path.join(root,'frontend/design-desktop/assets'),path.join(host,'assets'));await fs.symlink(products,path.join(host,'dist'))
const pkg=JSON.parse(await fs.readFile(path.join(root,'frontend/design-desktop/package.json'),'utf8'));pkg.main='src/main.mjs';await fs.writeFile(path.join(host,'package.json'),JSON.stringify(pkg))
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const electron=createRequire(path.join(root,'frontend/design-desktop/package.json'))('electron'),env={...process.env,CORE_RENDER_DIAGNOSTICS:'detail'};delete env.ELECTRON_RUN_AS_NODE
const report={status:'running',cases:[],errors:[],products}
const app=await _electron.launch({executablePath:electron,args:[host,'--desktop-isolated-profile'],cwd:root,env,chromiumSandbox:true,timeout:60000})
let page
try{
 page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(String(e)));page.on('console',m=>{void fs.appendFile(path.join(out,'renderer.log'),m.type()+' '+m.text()+'\n')})
 report.runtime=await app.evaluate(async({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.setTitle('Sketch / FIG · import verification');w.show();return {pid:process.pid,profile:app.getPath('userData'),gpu:await app.getGPUInfo('complete')}})
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 for(const file of ['/Users/Apple/Downloads/117.sketch','/Users/Apple/Downloads/01有料素材 (Copy).fig']){
  const hash=createHash('sha256').update(await fs.readFile(file)).digest('hex'),name=path.basename(file).replace(/\.(fig|sketch)$/,'')
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
  await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(name,{timeout:240000})
  await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',undefined,{timeout:240000})
  const errors=await page.locator('.kernel-status.error').allTextContents();assert.equal(errors.length,0,errors.join('\n'))
  await page.screenshot({path:path.join(out,(name==='117'?'117':'fig')+'.png')})
  report.cases.push({name,status:'PASS',sourceUnchanged:hash===createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash})
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
 }
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.status='PASS'
}catch(e){report.status='FAIL';report.error=String(e);if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')})}
finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await app.close()}
console.log(JSON.stringify({status:report.status,cases:report.cases,error:report.error}));if(report.status!=='PASS')process.exitCode=1
