import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
import {foreground} from './foreground.mjs'
const root=process.cwd(),out=path.join(root,'testing/verification-drag-response-20261024'),base=JSON.parse(await readFile(path.join(out,'baseline.json')))
const name=process.argv[2],tmp=path.join(base.runtime,name),host=process.env.DRAG_HOST||path.join(base.runtime,'candidate-host-7')
await mkdir(tmp)
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const report={status:'running',scope:'native whole-page conversion/capacity probe only; no GUI rendering or motion claim',pages:[]}
const app=await _electron.launch({executablePath:path.join(root,'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CORE_GPU_WORKING_BUDGET_MIB'].includes(k))),TMPDIR:tmp},timeout:60000})
for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',d=>void appendFile(path.join(out,name+'.log'),d))
const persist=()=>writeFile(path.join(out,name+'.json'),JSON.stringify(report,null,2))
try{
 const page=await app.firstWindow();await foreground(app,page)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 const started=Date.now();await page.locator('input[type=file][accept*=".fd"]').setInputFiles('/Users/Apple/Downloads/拓扑素材.sketch')
 await expect(page.locator('.source-workspace-header').getByRole('button',{name:'导出完整文件…',exact:true})).toBeEnabled({timeout:180000})
 report.indexMs=Date.now()-started
 const source=await page.evaluate(async()=>{
  const bridge=window.coreDesktop.largeDocument,s=await bridge.open();if(s.status!=='ok')throw Error(s.message)
  const rows=await bridge.children({owner:s.owner,expectedRevision:s.revision,limit:200});if(rows.status!=='ok')throw Error(rows.message)
  return {status:s,rows:rows.items}
 });report.source=source;await persist()
 for(const row of source.rows.filter(row=>row.kind==='page')){
  const started=Date.now();const value=await page.evaluate(async({owner,revision,key})=>{
   const result=await window.coreDesktop.largeDocument.scene({owner,expectedRevision:revision,key})
   return result.status==='ok'?{status:result.status,bytes:result.bytes,nodes:result.nodes,warnings:result.warnings}:{status:result.status,message:result.message,code:result.code}
  },{owner:source.status.owner,revision:source.status.revision,key:row.key})
  report.pages.push({name:row.name,key:row.key,ms:Date.now()-started,...value});await persist()
 }
 report.status='captured'
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1}
finally{await persist();const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Owned close timed out')),15000))])}catch(error){report.closeError=String(error);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}finally{clearTimeout(timer)}await persist();console.log(JSON.stringify(report))}
