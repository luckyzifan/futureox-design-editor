// Real packaged Electron clipboard/keyboard workflow; owns its profile/process.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,writeFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {buildInputs} from '../scripts/build-inputs.mjs'
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),core=path.resolve(desktop,'../..')
const require=createRequire(path.join(core,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const executable=await realpath(process.argv.find(v=>v.startsWith('--app='))?.slice(6)||'')
assert.ok(executable.endsWith('/Contents/MacOS/futureox-desgin'))
const contents=path.dirname(path.dirname(executable)),archive=path.join(contents,'Resources/app.asar'),bundleRoot=path.resolve(contents,'../../..')
const verified=JSON.parse(await readFile(path.join(bundleRoot,'package-verification.json'),'utf8'))
assert.equal(verified.status,'passed');assert.deepEqual(await buildInputs(core),verified.build.sources)
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),verified.artifacts['app.asar'])
const output=await mkdtemp(path.join(tmpdir(),'forma-native-clipboard-'))
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k)))
const report={checks:[],errors:[],output,status:'running',sourceSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')}
let app,page
const checked=name=>{report.checks.push(name);console.log(name)}
try {
 app=await _electron.launch({executablePath:executable,args:['--desktop-gui-test','--core-cpu-only'],env:{...env,TMPDIR:output},chromiumSandbox:true})
 page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(String(error)))
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:30000})
 const owner=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{profile:app.getPath('userData'),sandbox:p.sandbox,contextIsolation:p.contextIsolation,webSecurity:p.webSecurity}})
 assert.ok((await realpath(owner.profile)).startsWith((await realpath(output))+path.sep));assert.equal(owner.sandbox,true);assert.equal(owner.contextIsolation,true);assert.equal(owner.webSecurity,true)
 const canvas=page.getByTestId('canvas')
 const stored=()=>page.evaluate(async()=>{const list=await window.coreDesktop.workspace.list();if(list.status!=='ok')throw Error('list failed');const head=list.documents.find(d=>!d.deleted);if(!head)return null;const result=await window.coreDesktop.workspace.open({id:head.id});if(result.status!=='ok')throw Error('open failed');return JSON.parse(result.documentJson)})
 const waitCount=async n=>{await expect.poll(async()=>Object.keys((await stored())?.nodes||{}).length,{timeout:15000}).toBe(n);await expect(page.locator('.save-status')).toHaveText('已保存到本机');return await stored()}
 const draw=async(tool,x)=>{await canvas.focus();await page.keyboard.press(tool);await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:30000});const b=await canvas.boundingBox();await page.mouse.move(b.x+b.width*x,b.y+160);await page.mouse.down();await page.mouse.move(b.x+b.width*x+100,b.y+230,{steps:5});await page.mouse.up()}
 await draw('r',.15);const before=await waitCount(1),source=Object.values(before.nodes)[0]
 await page.keyboard.press('Meta+c')
 await expect.poll(async()=> {const value=await page.evaluate(()=>window.coreDesktop.clipboard.read());return value.forma && !!JSON.parse(value.forma).document.nodes[source.id]}).toBe(true)
 const clip=await page.evaluate(()=>window.coreDesktop.clipboard.read());assert.equal(clip.status,'ok');assert.equal(clip.text,source.name)
 const graph=JSON.parse(clip.forma);assert.equal(graph.format,'forma-nodes');assert.deepEqual(Object.keys(graph.document.nodes),[source.id])
 report.mimeTypes=await app.evaluate(async({clipboard})=>(await clipboard.read()).flatMap(i=>i.types))
 assert.ok(report.mimeTypes.includes('web application/x-forma-nodes-v1'))
 checked('Cmd+C produces a real Electron 44 private graph and readable text')
 await page.keyboard.press('Meta+v');let d=await waitCount(2);const copy=Object.values(d.nodes).find(n=>n.id!==source.id)
 assert.deepEqual(copy.transform,source.transform);assert.deepEqual(copy.fills,source.fills);assert.deepEqual(d.nodes[source.id],before.nodes[source.id])
 await page.keyboard.press('Meta+x');d=await waitCount(1);assert.deepEqual(d.nodes[source.id],before.nodes[source.id])
 const cut=await page.evaluate(()=>window.coreDesktop.clipboard.read());assert.ok(JSON.parse(cut.forma).document.nodes[copy.id])
 await page.keyboard.press('Meta+v');await waitCount(2)
 for(const count of [1,2,1]){await page.keyboard.press('Meta+z');await waitCount(count)}
 assert.deepEqual(await stored(),before)
 checked('Native graph paste/cut/paste waits for clipboard success and each action undoes independently')
 await draw('o',.55);const targetDoc=await waitCount(2),target=Object.values(targetDoc.nodes).find(n=>n.id!==source.id)
 await page.keyboard.press('Meta+Shift+r');await expect.poll(async()=>(await stored()).nodes[target.id],{timeout:15000}).toBeUndefined()
 d=await waitCount(2);const replacement=Object.values(d.nodes).find(n=>n.id!==source.id)
 assert.equal(replacement.kind,'rectangle');assert.deepEqual(replacement.transform.slice(4),target.transform.slice(4));assert.equal(replacement.width,source.width)
 await page.screenshot({path:path.join(output,'native-paste-replace.png')})
 await page.keyboard.press('Meta+z');await expect.poll(async()=>(await stored()).nodes[target.id]?.kind).toBe('ellipse');assert.deepEqual(await stored(),targetDoc)
 checked('Native Shift+Cmd+R replaces the target using the graph clipboard, then Undo restores it exactly')
 await page.getByTestId(`layer-${source.id}`).click()
 await page.getByLabel('透明度 %',{exact:true}).fill('37.5');await page.getByLabel('透明度 %',{exact:true}).press('Enter')
 await expect.poll(async()=>(await stored()).nodes[source.id].opacity).toBe(.375)
 await expect(page.locator('.save-status')).toHaveText('已保存到本机')
 const snapshot=await stored(),rectangle=snapshot.nodes[source.id]
 assert.deepEqual(rectangle.transform.slice(0,4),[1,0,0,1])
 const wasm=await readFile(path.join(core,'frontend/design-client/public/kernel/design_kernel_bg.wasm'))
 const wasmHash=createHash('sha256').update(wasm).digest('hex')
 assert.ok(Object.entries(verified.artifacts).some(([name,hash])=>name.endsWith('.wasm')&&hash===wasmHash),'Reference WASM must match the packaged artifact')
 const kernel=await import(pathToFileURL(path.join(core,'frontend/design-client/src/generated/design-kernel/design_kernel.js')).href)
 await kernel.default({module_or_path:await WebAssembly.compile(wasm)})
 const engine=new kernel.VectorEngine();let generated
 try {
   engine.load_document(JSON.stringify(snapshot))
   const x=rectangle.transform[4],y=rectangle.transform[5]
   generated=Buffer.from(engine.render_region_png(JSON.stringify({pageId:snapshot.pages[0].id,nodeIds:[source.id],scale:2,rasterProfile:snapshot.rasterProfile,bounds:{x,y,width:x+rectangle.width-x,height:y+rectangle.height-y}})))
 }finally{engine.free()}
 await canvas.focus();await page.keyboard.press('Meta+Shift+c')
 await expect.poll(async()=>(await page.evaluate(()=>window.coreDesktop.clipboard.read())).image?.startsWith('data:image/png;base64,')).toBe(true)
 const pngCopy=await page.evaluate(()=>window.coreDesktop.clipboard.read()),returned=Buffer.from(pngCopy.image.split(',')[1],'base64')
 assert.deepEqual(returned,generated,'Transparent original PNG bytes must survive the real OS clipboard unchanged')
 assert.equal((await stored()).nodes[source.id].opacity,.375)
 await page.keyboard.press('Meta+v');d=await waitCount(3)
 const image=Object.values(d.nodes).find(n=>n.kind==='rectangle'&&n.fills.some(p=>p.kind==='image'))
 assert.equal(image.fills[0].image,pngCopy.image)
 report.png={bytes:generated.length,sha256:createHash('sha256').update(generated).digest('hex'),opacity:.375}
 await page.screenshot({path:path.join(output,'native-transparent-png.png')})
 checked('37.5% opacity PNG matches independent same-WASM CPU bytes through macOS clipboard and image-layer paste')
 assert.deepEqual(report.errors,[]);report.status='passed'
}catch(error){report.status='failed';report.error=String(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1}
finally{
 await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2))
 if(app){
   const child=app.process();let timer
   try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned test window close timed out')),10000)})])}
   catch(error){report.cleanupError=String(error);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,1500));if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}
   finally{clearTimeout(timer)}
 }
 await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({output,status:report.status,checks:report.checks.length,error:report.error,cleanupError:report.cleanupError}))
}
