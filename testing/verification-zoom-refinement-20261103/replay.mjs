// Run from the repository root with a local Sketch archive and a fresh output directory.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'

const [source,out]=process.argv.slice(2).map(p=>path.resolve(p))
if(!source||!out)throw Error('Usage: node replay.mjs SOURCE.sketch NEW_OUTPUT')
const desktop=path.resolve('frontend/design-desktop')
const { _electron }=createRequire(path.resolve('frontend/design-client/package.json'))('playwright')
const electron=createRequire(path.join(desktop,'package.json'))('electron')
await fs.mkdir(out)
const host=path.join(out,'host')
await fs.mkdir(host)
await fs.cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
const main=path.join(host,'src/main.mjs')
const code=(await fs.readFile(main,'utf8')).replace('backgroundThrottling: !renderCheck','backgroundThrottling: false')
await fs.writeFile(main,code.replaceAll('ownedWindow.show()','ownedWindow.showInactive()'))
await fs.writeFile(path.join(host,'package.json'),JSON.stringify({type:'module',main:'src/main.mjs'}))
await fs.symlink(process.env.VERIFY_PRODUCTS||path.join(desktop,'dist'),path.join(host,'dist'))
await fs.symlink(path.join(desktop,'assets'),path.join(host,'assets'))
const env={...process.env,TMPDIR:out,CORE_RENDER_DIAGNOSTICS:process.env.CORE_RENDER_DIAGNOSTICS||'1'}
delete env.ELECTRON_RUN_AS_NODE
const app=await _electron.launch({executablePath:electron,args:[host,'--desktop-isolated-profile'],env,chromiumSandbox:true})
const report={page:Number(process.env.VERIFY_PAGE||0),material:process.env.VERIFY_MATERIAL||'模板二',zooms:[]}
try{
  const page=await app.firstWindow()
  await app.evaluate(({BrowserWindow})=>{
    const w=BrowserWindow.getAllWindows()[0]
    w.setSize(1440,960);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive()
  })
  await (await page.context().newCDPSession(page)).send('Emulation.setFocusEmulationEnabled',{enabled:true})
  await page.locator('.app-shell[data-desktop-ready=true]').waitFor()
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
  const picker=page.getByLabel('素材页面',{exact:true})
  await picker.waitFor({timeout:90000})
  const ids=await picker.locator('option').evaluateAll(rows=>rows.map(row=>row.value).filter(Boolean))
  await picker.selectOption(ids[report.page])
  await page.locator('.source-page-entry').filter({has:page.getByText(report.material,{exact:true})}).first().click()
  const badge='.native-source-surface .kernel-status'
  await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='WebGPU · 清晰',badge,{timeout:120000})
  for(const percent of (process.env.VERIFY_ZOOMS||'400,950,1600,3200').split(',').map(Number)){
    const menu=page.locator('.view-menu')
    if(!await menu.evaluate(n=>n.open))await menu.locator('summary').click()
    const field=page.getByLabel('缩放比例',{exact:true})
    await field.fill(String(percent))
    const start=await page.evaluate(selector=>{
      const el=document.querySelector(selector)
      window.__refineObserver?.disconnect()
      window.__refineTransition=false
      window.__refineObserver=new MutationObserver(records=>{
        if(el.textContent!=='WebGPU · 清晰'||records.some(r=>[...r.removedNodes].some(n=>n.textContent!=='WebGPU · 清晰')))
          window.__refineTransition=true
      })
      window.__refineObserver.observe(el,{childList:true,subtree:true,characterData:true})
      return performance.now()
    },badge)
    await field.press('Enter')
    await page.waitForFunction(({badge,percent})=>{
      const c=document.querySelector('.native-source-content'),s=document.querySelector(badge)?.textContent
      if(s==='画板绘制未完成')return true
      return window.__refineTransition && s==='WebGPU · 清晰' && c?.dataset.cameraReprojected==='false' &&
        Math.abs(JSON.parse(c.dataset.projectedCamera).zoom-percent/100)<1e-6
    },{badge,percent},{timeout:55000,polling:'raf'})
    const end=await page.evaluate(()=>performance.now())
    const status=page.locator(badge)
    assert.equal(await status.textContent(),'WebGPU · 清晰',await status.getAttribute('title'))
    // Read the native output after timing. CapturePage can return an older composited frame.
    const data=await page.locator('.native-source-content').evaluate(async c=>{
      const copy=new OffscreenCanvas(c.width,c.height)
      copy.getContext('2d').drawImage(c,0,0)
      const bytes=new Uint8Array(await(await copy.convertToBlob({type:'image/png'})).arrayBuffer())
      let raw=''
      for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768))
      return {png:btoa(raw),width:c.width,height:c.height,view:JSON.parse(c.dataset.projectedCamera)}
    })
    await fs.writeFile(path.join(out,'pixels-'+percent+'.png'),Buffer.from(data.png,'base64'))
    report.zooms.push({percent,elapsedMs:Math.round(end-start),width:data.width,height:data.height,view:data.view})
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
    await page.waitForTimeout(160)
  }
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{})}
console.log(JSON.stringify(report))
