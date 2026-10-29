import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const root=process.cwd(),[lab,out,source='/Users/Apple/Downloads/拓扑素材.sketch',fixture]=process.argv.slice(2)
if(!lab||!out)throw Error('Usage: run-lab.mjs LAB FRESH_OUTPUT [SOURCE]')
await fs.mkdir(out,{recursive:true})
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron}=require('@playwright/test')
const electron=createRequire(path.join(root,'frontend/design-desktop/package.json'))('electron'),manifest=JSON.parse(await fs.readFile(path.join(lab,'manifest.json'),'utf8'))
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex'),sourceHash=await hash(source)
const config=fixture||path.join(root,'testing/verification-source-pan-20261029/fixture.json')
const env={...process.env,CORE_RENDER_DIAGNOSTICS:'detail'};delete env.ELECTRON_RUN_AS_NODE
const app=await _electron.launch({executablePath:electron,args:[manifest.host,'--desktop-isolated-profile','--desktop-render-check=source',`--desktop-render-check-root=${manifest.renderer}`,`--desktop-render-check-fixture=${config}`],cwd:root,env,chromiumSandbox:true,timeout:60000})
for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',data=>{void fs.appendFile(path.join(out,'host.log'),data)})
let page
try {
 page=await app.firstWindow();page.on('console',message=>{void fs.appendFile(path.join(out,'renderer.log'),message.type()+' '+message.text()+'\n')});page.on('pageerror',e=>{void fs.appendFile(path.join(out,'errors.log'),String(e)+'\n')})
 // Isolated check fixture supplies the one known input at the native picker.
 // Production largeDocument authorization, source indexing and renderer are unchanged.
 const runtime=await app.evaluate(async({app,BrowserWindow,dialog,screen},source)=>{
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]})
  const w=BrowserWindow.getAllWindows()[0];w.setSize(1180,900);w.setTitle('Sketch/FIG · Source pan verification');w.show()
  return {pid:process.pid,profile:app.getPath('userData'),gpu:app.getGPUFeatureStatus(),gpuInfo:await app.getGPUInfo('complete'),display:screen.getDisplayMatching(w.getBounds())}
 },source)
 await fs.writeFile(path.join(out,'runtime.json'),JSON.stringify({runtime,sourceHash,manifest:lab},null,2))
 await page.getByRole('button',{name:'Load real source',exact:true}).click()
 await page.getByRole('button',{name:'Run pan comparison',exact:true}).waitFor({state:'visible'})
 await page.waitForFunction(()=>!(document.querySelectorAll('button')[1]).disabled,{},{timeout:300000})
 await page.getByRole('button',{name:'Run pan comparison',exact:true}).click()
 await page.waitForFunction(()=>{const t=document.querySelector('[data-testid="report"]')?.textContent;return !!t&&['complete','failed'].includes(JSON.parse(t).status)},{},{timeout:1500000})
 await page.screenshot({path:path.join(out,'final.png')})
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({ui:await page.getByTestId('report').textContent(),sourceUnchanged:sourceHash===await hash(source)},null,2))
 const profile=runtime.profile
 const files=await fs.readdir(profile,{recursive:true})
 for(const file of files.filter(name=>name.endsWith('-report.json')||name==='latest-report.json'||/^pose-\d+-(live|fresh)\.png$/.test(path.basename(name)))){
  const full=path.join(profile,file);await fs.copyFile(full,path.join(out,path.basename(file)))
 }
 console.log(JSON.stringify({out,result:await page.getByTestId('report').textContent(),profile}))
} catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.txt'),String(error));throw error}
finally{await app.close()}
