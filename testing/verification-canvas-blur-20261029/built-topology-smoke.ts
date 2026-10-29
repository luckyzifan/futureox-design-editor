import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const root=process.cwd(),build=process.argv[2],out=process.argv[3]
if(!build||!out||![build,out].every(path.isAbsolute))throw Error('Built desktop and fresh absolute output required')
await fs.mkdir(out)
const source='/Users/Apple/Downloads/拓扑素材.sketch',desktop=path.join(root,'frontend/design-desktop'),host=path.join(out,'host')
const hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex')
const manifest=JSON.parse(await fs.readFile(path.join(build,'build-manifest.json'),'utf8'))
await fs.mkdir(host);await fs.cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
for(const [file,expected]of Object.entries(manifest.sources))if(file.startsWith('frontend/design-desktop/src/')){
 const copied=path.join(host,'src',file.slice('frontend/design-desktop/src/'.length));if(await hash(copied)!==expected)throw Error('Host source drift: '+file)
}
await fs.copyFile(path.join(desktop,'package.json'),path.join(host,'package.json'))
await fs.symlink(path.join(desktop,'assets'),path.join(host,'assets'));await fs.symlink(build,path.join(host,'dist'))
const require=createRequire(path.join(desktop,'package.json')),{_electron,expect}=createRequire(path.join(root,'frontend/design-client/package.json'))('@playwright/test')
const report:any={status:'running',source,sourceHash:await hash(source),buildManifestHash:await hash(path.join(build,'build-manifest.json')),events:[],warnings:[],pageErrors:[]}
let app:any,page:any
try{
 const profileRoot=path.join(out,'profiles');await fs.mkdir(profileRoot)
 const env={...process.env,TMPDIR:profileRoot,CORE_RENDER_DIAGNOSTICS:'0'};delete (env as any).ELECTRON_RUN_AS_NODE
 app=await _electron.launch({executablePath:require('electron'),args:[host,'--desktop-isolated-profile'],cwd:host,env,chromiumSandbox:true,timeout:60000})
 page=await app.firstWindow();page.setDefaultTimeout(30000)
 page.on('pageerror',(e:Error)=>report.pageErrors.push(String(e)))
 page.on('console',(m:any)=>{if(/Canvas (blur arithmetic|spatial blur) unavailable/.test(m.text()))report.warnings.push(m.text())})
 await app.evaluate(({BrowserWindow}:any)=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.setSize(1440,960);w.setTitle('拓扑素材 · 模糊减量验证')})
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-source-document','true',{timeout:180000})
 await expect(page.locator('.source-pages-heading')).toContainText('306',{timeout:180000});report.events.push('complete-source-catalogue-306')
 const search=page.getByLabel('搜索素材',{exact:true});await search.fill('模板二')
 const row=page.locator('.source-page-entry').filter({has:page.locator('.source-row-name',{hasText:/^模板二$/})}).first();await row.dblclick()
 await expect(page.getByTestId('layer-70806B41-C915-4EB2-954C-449E746E4426')).toBeVisible({timeout:180000})
 await page.getByTestId('layer-70806B41-C915-4EB2-954C-449E746E4426').click();await page.keyboard.press('Shift+2')
 await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:180000})
 report.kernelStatus=await page.locator('.kernel-status').allTextContents()
 expect(await page.locator('.kernel-status.error').allTextContents()).toEqual([])
 expect(report.kernelStatus.join(' ')).toContain('WebGPU');expect(report.warnings).toEqual([])
 report.events.push('modern-blur-root-webgpu-ready')
 await page.screenshot({path:path.join(out,'topology-ready.png')})
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1}
finally{
 if(app){let timer:ReturnType<typeof setTimeout>|undefined;const child=app.process()
  try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned GUI close timeout')),15000)})])}
  catch(error){report.closeWarning=String(error);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}
  finally{clearTimeout(timer)}
 }
 report.sourceUnchanged=report.sourceHash===await hash(source);if(!report.sourceUnchanged){report.status='failed';process.exitCode=1}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
