import {readFile,writeFile,mkdir,cp,copyFile}from'node:fs/promises'
import {createRequire}from'node:module'
import path from'node:path'
const root=process.cwd(),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client'),out=path.join(root,'testing/verification-topology-repairs-20261023')
const manifest=JSON.parse(await readFile(path.join(out,'baseline-manifest.json'),'utf8')),name=process.argv[2]||'pixel-check'
const owned=path.join(manifest.privateRuntimeRoot,name),host=path.join(owned,'host');await mkdir(path.join(host,'dist'),{recursive:true})
await cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true});await cp(path.join(desktop,'assets'),path.join(host,'assets'),{recursive:true})
await writeFile(path.join(host,'package.json'),JSON.stringify({name:'owned-topology-pixels',version:'0.0.0',type:'module',main:'src/main.mjs'}))
for(const dir of ['bin','sidecar','fonts'])await cp(path.join(desktop,'dist',dir),path.join(host,'dist',dir),{recursive:true})
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root:client,configFile:path.join(client,'vite.config.ts'),base:'./',build:{outDir:path.join(host,'dist/renderer'),emptyOutDir:true,rolldownOptions:{input:path.join(client,'topology-repair-check.html')}}})
await copyFile(path.join(host,'dist/renderer/topology-repair-check.html'),path.join(host,'dist/renderer/optical-field-check.html'))
const require=createRequire(path.join(client,'package.json')),{_electron}=require('@playwright/test');let app
try{
 app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile','--desktop-render-check=optical','--desktop-render-check-root='+path.join(host,'dist/renderer'),'--desktop-render-check-fixture='+manifest.controlsFixture],timeout:60000,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),CORE_DOCUMENT_MEMORY_BYTES:'1219977216',CORE_DOCUMENT_MEMORY_INHERITED:'1'}})
 const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.hide()})
 await page.waitForFunction(()=>{try{return ['passed','failed'].includes(JSON.parse(document.querySelector('#results')?.textContent||'{}').status)}catch{return false}},null,{timeout:180000})
 const result=JSON.parse(await page.locator('#results').textContent());await writeFile(path.join(out,name+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1
}finally{if(app)await app.close()}
