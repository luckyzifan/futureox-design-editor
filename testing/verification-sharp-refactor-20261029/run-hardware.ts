import {createServer} from '../../frontend/design-client/node_modules/vite/dist/node/index.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=process.cwd(),out=process.argv[2]
const {_electron}=createRequire(path.join(root,'frontend/design-client/package.json'))('@playwright/test')
if(!out||!path.isAbsolute(out))throw Error('Fresh absolute output required')
await fs.mkdir(out)
const server=await createServer({root,configFile:path.join(root,'frontend/design-client/vite.config.ts'),publicDir:path.join(root,'frontend/design-client/public'),server:{host:'127.0.0.1',port:0,strictPort:true},plugins:[{name:'bounded-local-report',configureServer(server){server.middlewares.use('/report',async(req,res)=>{
 try{let body='';for await(const part of req){body+=part;if(body.length>4*1024*1024)throw Error('Report too large')};await fs.writeFile(path.join(out,'report.json'),JSON.stringify(JSON.parse(body),null,2));res.end('ok')}
 catch(e){res.statusCode=500;res.end(String(e))}
})}}]})
await server.listen();const url=server.resolvedUrls!.local[0]+'testing/verification-sharp-refactor-20261029/hardware.html'
const host=path.join(out,'main.cjs');await fs.writeFile(host,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(url)});});`)
const require=createRequire(path.join(root,'frontend/design-desktop/package.json'))
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
let app
try{
 app=await _electron.launch({executablePath:require('electron'),args:[host],env,chromiumSandbox:true,timeout:45000})
 const page=await app.firstWindow();await page.waitForFunction(()=>/"status": "(passed|failed)"/.test(document.querySelector('#result')?.textContent||''),{},{timeout:600000})
 await page.screenshot({path:path.join(out,'hardware.png')})
 const report=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));console.log(JSON.stringify({status:report.status,error:report.error,adapter:report.adapter,flags:report.flags,cases:report.cases.map((r:any)=>({kind:r.kind,differences:r.differences,controlMs:r.controlMs,candidateMs:r.candidateMs,indexHits:r.indexHits,improvement:r.improvement}))}))
 if(report.status!=='passed')process.exitCode=1
}finally{await app?.close();await server.close()}
