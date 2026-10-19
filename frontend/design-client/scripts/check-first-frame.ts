/** Observe actual displayed pixels on every animation frame during import/page
 * switch/reload. The rasterizer, native bridge and display policy are unchanged. */
import { chromium, _electron, expect } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { blank, node, paint, uid } from '../src/model'
import { defaultColorSettings } from '../src/color'

const output=await mkdtemp(join(tmpdir(),'forma-first-frame-')),desktop=process.env.DESIGN_ELECTRON_APP
const document=blank('Atomic first frame');document.schemaVersion=5;document.rasterProfile='figma';document.colorManagement=defaultColorSettings()
const colors=['#ef21a5','#19b45a']
document.pages=colors.map((color,index)=>{
  const root=node('rectangle',-5000,-5000,10000,10000);root.fills=[paint(color)]
  document.nodes[root.id]=root;const children=[root.id]
  for(let i=0;i<240;i++){
    const shape=node('ellipse',(i%20)*60,Math.floor(i/20)*60,55,55);shape.fills=[paint(color)]
    document.nodes[shape.id]=shape;children.push(shape.id)
  }
  return {id:uid(),name:`完整画面 ${index+1}`,children,background:'#f5f5f5'}
})
const fixture=join(output,'pages.fd');await writeFile(fixture,JSON.stringify(document))
let server:any,browser:any,app:any,page:any
const records:any[]=[],errors:string[]=[]
function observe(expected:number[]) {
  const state={active:true,frames:0,pending:0,pendingAfterDelivery:0,partial:0,published:0,firstVisibleMs:0,started:performance.now(),
    initialRendered:Number(globalThis.document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.tilesRendered||0),samples:[] as unknown[]}
  ;(window as any).__firstFrame=state
  const probe=globalThis.document.createElement('canvas');probe.width=3;probe.height=3
  const context=probe.getContext('2d',{willReadFrequently:true})!
  const tick=()=>{
    if(!state.active)return
    const tiles=globalThis.document.querySelector<HTMLElement>('.kernel-tiles'),source=tiles?.querySelector<HTMLCanvasElement>('canvas[data-frame-visible="true"]')
    if(tiles?.dataset.framePublication==='pending'){
      state.pending++;if(Number(tiles.dataset.tilesRendered)>state.initialRendered)state.pendingAfterDelivery++
    }
    if(source&&source.width&&getComputedStyle(tiles!).visibility==='visible'){
      for(let y=0;y<3;y++)for(let x=0;x<3;x++)context.drawImage(source,Math.floor(source.width*(.3+x*.2)),Math.floor(source.height*(.3+y*.2)),1,1,x,y,1,1)
      const pixels=context.getImageData(0,0,3,3).data
      let matched=0
      for(let i=0;i<pixels.length;i+=4)if(expected.every((v,c)=>Math.abs(pixels[i+c]-v)<=1)&&pixels[i+3]===255)matched++
      if(matched){
        state.published++;if(!state.firstVisibleMs)state.firstVisibleMs=performance.now()-state.started
        if(matched!==9||tiles!.dataset.framePublication!=='complete')state.partial++
        if(state.samples.length<12)state.samples.push({matched,publication:tiles!.dataset.framePublication,ready:tiles!.dataset.detailReady})
      }
    }
    state.frames++;requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
try {
  if(desktop){
    app=await _electron.launch({executablePath:desktop,args:['--desktop-gui-test'],chromiumSandbox:true,
      env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(k))),TMPDIR:output}})
    page=await app.firstWindow();await page.waitForURL(/^design-app:/)
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setContentSize(1440,960))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  }else{
    server=await createServer({root:resolve(import.meta.dir,'..'),server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen()
    browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]})
    page=await browser.newPage({viewport:{width:1440,height:960},deviceScaleFactor:2});await page.goto(server.resolvedUrls.local[0])
  }
  page.on('pageerror',(e:Error)=>errors.push(String(e)))
  const settle=async()=>{
    await expect(page.locator('.document-transition')).toHaveCount(0,{timeout:60000})
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:120000})
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready','true',{timeout:120000})
    expect(await page.locator('.kernel-status.error').allTextContents()).toEqual([])
  }
  const record=async(name:string)=>{
    await settle();await page.waitForFunction(()=>(window as any).__firstFrame?.published>=2)
    const state=await page.evaluate(()=>{const s=(window as any).__firstFrame;s.active=false;return s})
    expect(state.partial).toBe(0);expect(state.pendingAfterDelivery).toBeGreaterThan(0)
    expect(Number(await page.locator('.kernel-tiles').getAttribute('data-tile-count'))).toBeGreaterThan(1)
    records.push({name,...state});await page.screenshot({path:join(output,`${records.length}.png`)})
  }
  await settle();await page.evaluate(observe,[239,33,165])
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(document.name,{timeout:60000})
  await record('import first complete viewport')
  await page.evaluate(observe,[25,180,90]);await page.locator('.pages .page').filter({hasText:'完整画面 2'}).click()
  await record('page switch first complete viewport')
  await page.locator('.pages .page').filter({hasText:'完整画面 1'}).click();await settle()
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
  await page.addInitScript(observe,[239,33,165]);await page.reload();await record('restored document first complete viewport')
  expect(errors).toEqual([])
  await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',desktop:!!desktop,records,errors},null,2))
  console.log(JSON.stringify({output,status:'passed',records}))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),records,errors},null,2));await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error}
finally{
  if(app){const child=app.process();let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned first-frame app close timeout')),30000)})])}
    finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
  }
  await browser?.close();await server?.close()
}
