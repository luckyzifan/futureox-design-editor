import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=process.cwd(),out=path.join(root,'testing/verification-render-pipeline-20261025'),client=path.join(root,'frontend/design-client')
Object.assign(process.env,{VITE_DESIGN_OPAQUE_SOLID_BATCH:'1',VITE_DESIGN_EXACT_WHOLE_TENT_2048:'1'})
const {createServer}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
const server=await createServer({root:client,configFile:path.join(client,'vite.config.ts'),server:{port:0,host:'127.0.0.1',fs:{allow:[root]}},clearScreen:false})
await server.listen();const port=server.httpServer.address().port
const directory=await mkdtemp(path.join(tmpdir(),'render-pipeline-pixels-')),main=path.join(directory,'main.cjs')
await writeFile(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:650,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadURL(${JSON.stringify(`http://127.0.0.1:${port}/@fs${out}/hardware.html`)});});app.on('window-all-closed',()=>app.quit());`)
const require=createRequire(path.join(client,'package.json')),{_electron}=require('@playwright/test')
let app
try{
  app=await _electron.launch({executablePath:path.join(root,'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[main],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),timeout:60000})
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(String(e)))
  await page.waitForFunction(()=>['passed','failed'].includes(window.__report?.status),null,{timeout:600000})
  const report=await page.evaluate(()=>window.__report)
  await page.screenshot({path:path.join(out,'hardware.png')})
  await writeFile(path.join(out,'hardware.json'),JSON.stringify({...report,pageErrors:errors},null,2)+'\n')
  console.log(report.status,report.error||'',report.cases.length)
  if(report.status!=='passed')process.exitCode=1
}finally{if(app)await app.close();await server.close()}
