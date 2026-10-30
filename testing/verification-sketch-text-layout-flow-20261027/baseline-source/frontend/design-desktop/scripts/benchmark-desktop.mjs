// Paired packaged Electron benchmark, owned profiles and real Rust/SQLite.
// node benchmark-desktop.mjs FIXTURE OUTPUT BEFORE_EXECUTABLE AFTER_EXECUTABLE
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
const require=createRequire(new URL('../../design-client/package.json',import.meta.url))
const {_electron,expect}=require('@playwright/test')
const [fixture,output,...executables]=process.argv.slice(2)
assert(fixture&&output&&executables.length===2)
await mkdir(output,{recursive:true})
const fixtureSha256=createHash('sha256').update(await readFile(fixture)).digest('hex')
const envelope=JSON.parse(await readFile(fixture,'utf8')),fixtureDocument=envelope.document??envelope
const rows=[]
const order=(process.env.DESIGN_BENCH_ORDER||'0,1,1,0').split(',').map(Number)
assert(order.length&&order.every(value=>value===0||value===1))
for(const variant of order){
 const executable=path.resolve(executables[variant]), run=rows.length
 const owned=await mkdtemp(path.join(os.tmpdir(),'forma-desktop-bench-'))
 let app,page
 try{
  const started=performance.now()
  app=await _electron.launch({executablePath:executable,args:['--desktop-gui-test'],chromiumSandbox:true,timeout:60000,
   env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key))),TMPDIR:owned}})
  page=await app.firstWindow();await page.waitForURL(/^design-app:/)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,960))
  const surface=page.locator('.kernel-presentation'),canvas=page.getByTestId('canvas'),tiles=page.locator('.kernel-tiles')
  const settle=async()=>{
   await page.waitForFunction(()=>!!document.querySelector('.kernel-status.error') ||
    document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&
    document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready')==='true',null,{timeout:120000})
   expect(await page.locator('.kernel-status.error').allTextContents()).toEqual([])
   await expect(tiles).toHaveAttribute('data-renderer','webgpu')
  }
  const zoom=async percent=>{
   await page.getByLabel('缩放与视图设置',{exact:true}).click()
   await page.getByLabel('缩放比例',{exact:true}).fill(String(percent));await page.getByLabel('缩放比例',{exact:true}).press('Enter')
   await page.getByLabel('缩放与视图设置',{exact:true}).click()
   await expect(surface).toHaveAttribute('data-requested-camera-zoom',String(percent/100));await settle()
  }
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:45000});await settle()
  const startupMs=performance.now()-started
  const capabilities=await page.evaluate(()=>({nativePreparation:!!window.coreDesktop.preparation,localCodec:!!window.coreDesktop.documentCodec,dpr:devicePixelRatio,width:innerWidth,height:innerHeight}))
  const importAt=performance.now();await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(fixtureDocument.name,{timeout:120000})
  await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:120000});await settle()
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})
  const importedMs=performance.now()-importAt
  const doc=await page.evaluate(async()=>{const list=await window.coreDesktop.workspace.list();if(list.status!=='ok')throw Error('Workspace list failed');const latest=[...list.documents].sort((a,b)=>b.updatedAt-a.updatedAt)[0];const opened=await window.coreDesktop.workspace.open({id:latest.id});if(opened.status!=='ok')throw Error('Workspace open failed');return JSON.parse(opened.documentJson)})
  assert.equal(Object.keys(doc.nodes).length,752)
  const operations=[]
  for(const percent of [50,100,47.3,100]){
   const at=performance.now()
   await zoom(percent)
   operations.push({kind:'zoom',percent,ms:performance.now()-at})
   console.log(JSON.stringify({run,variant,operation:operations.at(-1)}))
  }
  await page.mouse.move(5,5)
  const screenshot=await canvas.screenshot({path:path.join(output,`canvas-${run}-${variant}.png`)})
  const drawing=await page.evaluate(()=>{
   const source=document.querySelector('.kernel-presentation canvas[data-frame-visible="true"]')
   if(!(source instanceof HTMLCanvasElement))throw Error('Missing published drawing canvas')
   const copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height
   const context=copy.getContext('2d');if(!context)throw Error('Missing pixel readback context')
   context.drawImage(source,0,0)
   return {width:copy.width,height:copy.height,png:copy.toDataURL('image/png').split(',')[1]}
  })
  const drawingPng=Buffer.from(drawing.png,'base64')
  await writeFile(path.join(output,`drawing-${run}-${variant}.png`),drawingPng)
  const group=Object.values(doc.nodes).find(n=>n.name==='组合 51');assert(group)
  await page.getByLabel('搜索图层',{exact:true}).fill(group.name);await page.getByTestId(`layer-${group.id}`).click();await page.getByLabel('搜索图层',{exact:true}).fill('')
  await canvas.focus();const fitStart=performance.now();await page.keyboard.press('Shift+2')
  let fitSelection
  try {await settle();fitSelection={ok:true,ms:performance.now()-fitStart,zoom:await surface.getAttribute('data-requested-camera-zoom')}}
  catch(error){fitSelection={ok:false,ms:performance.now()-fitStart,error:String(error),zoom:await surface.getAttribute('data-requested-camera-zoom')};await page.screenshot({path:path.join(output,`fit-failure-${run}.png`)})}
  if(variant===1)assert(fitSelection.ok,`Candidate fit-to-selection failed: ${fitSelection.error}`)
  // The baseline records the known failure; candidate completion is required.
  // Compare drag at the same 100% scale, centered on the selected object.
  await zoom(100)
  const box=await page.getByTestId('canvas-selection-outline').first().boundingBox();assert(box)
  const x=box.x+box.width*.45,y=box.y+box.height*.55
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+96,y+32,{steps:24})
  const release=performance.now();await page.mouse.up();await settle()
  operations.push({kind:'drag-release-to-detail',ms:performance.now()-release})
  await canvas.focus();await page.keyboard.press('Meta+z');await settle()
  await canvas.focus();await page.keyboard.press('Meta+s')
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:120000})
  // Flush the host IPC ordering after the saved status is published, before
  // quitting. Closing while autosave is pending correctly asks the user.
  await page.evaluate(()=>window.coreDesktop.workspace.list())
  rows.push({run,variant,executable,capabilities,startupMs,importedMs,operations,fitSelection,
   drawing:{width:drawing.width,height:drawing.height,sha256:createHash('sha256').update(drawingPng).digest('hex')},
   canvasSha256:createHash('sha256').update(screenshot).digest('hex')})
  await writeFile(path.join(output,'results.json'),JSON.stringify({fixtureSha256,scope:'Same-host packaged Electron, fresh profiles, ABBA order; UI completion latency, not physical input-to-photon',rows},null,2))
  console.log(JSON.stringify(rows.at(-1)))
 }catch(error){console.error(error);await page?.screenshot({path:path.join(output,`failure-${run}.png`)}).catch(()=>{});throw error}
 finally{
  if(app){const child=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned app close timed out')),30000)})])}
   finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){
    child.kill('SIGTERM')
    await new Promise(resolve=>{const deadline=setTimeout(()=>{child.kill('SIGKILL');resolve()},2000);child.once('exit',()=>{clearTimeout(deadline);resolve()})})
   }}}
 }
}
