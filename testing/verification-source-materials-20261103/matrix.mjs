// Run from the repository root with a local Sketch archive and a fresh output directory.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {replayWheel} from './wheel.mjs'

const [source,out]=process.argv.slice(2).map(p=>path.resolve(p))
if(!source||!out)throw Error('Usage: node matrix.mjs SOURCE.sketch NEW_OUTPUT')
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
const hash=createHash('sha256')
for await(const chunk of createReadStream(source))hash.update(chunk)
const zoom=Number(process.env.VERIFY_PERCENT||3200),timeout=Number(process.env.VERIFY_LIMIT_MS||8000)
const selected=process.env.VERIFY_ONLY?new Set(process.env.VERIFY_ONLY.split(',')):undefined
const report={sourceSha256:hash.digest('hex'),zoom,timeout,materials:[]}
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
try{
  const page=await app.firstWindow()
  await app.evaluate(({BrowserWindow})=>{
    const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,960);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive()
  })
  await (await page.context().newCDPSession(page)).send('Emulation.setFocusEmulationEnabled',{enabled:true})
  await page.locator('.app-shell[data-desktop-ready=true]').waitFor()
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(source)
  const picker=page.getByLabel('素材页面',{exact:true})
  await picker.waitFor({timeout:90000})
  const pages=await picker.locator('option').evaluateAll(rows=>rows.filter(r=>r.value).map(r=>({id:r.value,name:r.textContent})))
  for(const sourcePage of pages){
    await picker.selectOption(sourcePage.id)
    await page.waitForFunction(id=>document.querySelector('.source-board-navigation')?.dataset.activeSourcePage===id,sourcePage.id)
    const rows=page.locator('.source-page-entry')
    const catalogue=await rows.evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.sourceMaterialId,name:n.querySelector('.source-row-name').textContent})))
    for(const [index,material] of catalogue.entries()){
      if(selected&&!selected.has(material.id))continue
      const row={page:sourcePage.name,index,...material};report.materials.push(row)
      try{
        assert(material.id,'missing source ID')
        await page.evaluate(()=>{window.__priorSourceCanvas=document.querySelector('.native-source-content')})
        await rows.nth(index).evaluate(n=>n.click())
        await page.waitForFunction(()=>{const c=document.querySelector('.native-source-content');return c&&c!==window.__priorSourceCanvas},null,{timeout:20000,polling:'raf'})
        const menu=page.locator('.view-menu')
        if(!await menu.evaluate(n=>n.open))await menu.locator('summary').click()
        const input=page.getByLabel('缩放比例',{exact:true});await input.fill(String(zoom))
        const start=await page.evaluate(()=>performance.now())
        await input.press('Enter')
        await page.waitForFunction(percent=>{
          const c=document.querySelector('.native-source-content'),s=document.querySelector('.native-source-surface .kernel-status')
          if(!c||!s)return false
          if(s.textContent==='画板绘制未完成')return true
          const v=JSON.parse(c.dataset.projectedCamera||'null')
          if(!v||Math.abs(v.zoom*100-percent)>1e-5)return false
          return s.textContent==='当前倍率为预览精度'||s.textContent==='WebGPU · 清晰'&&c.dataset.cameraReprojected==='false'&&c.dataset.sourceReadyCamera===c.dataset.projectedCamera
        },zoom,{timeout,polling:'raf'})
        row.elapsedMs=Math.round(await page.evaluate(()=>performance.now())-start)
        const badge=page.locator('.native-source-surface .kernel-status'),label=await badge.textContent()
        row.status=label==='WebGPU · 清晰'?'ready':label==='当前倍率为预览精度'?'limited':'error'
        if(row.status!=='ready')row.error=await badge.getAttribute('title')
        if(row.status==='ready'&&process.env.VERIFY_PIXELS==='1'){
          const data=await page.locator('.native-source-content').evaluate(c=>{
            const out=document.createElement('canvas');out.width=c.width;out.height=c.height
            out.getContext('2d').drawImage(c,0,0)
            return out.toDataURL('image/png').split(',')[1]
          })
          await fs.writeFile(path.join(out,material.id+'.png'),Buffer.from(data,'base64'))
        }
      }catch(e){
        row.status='timeout-or-input-error';row.error=String(e).slice(0,240)
        row.last=await page.evaluate(()=>{
          const c=document.querySelector('.native-source-content'),s=document.querySelector('.native-source-surface .kernel-status')
          return {badge:s?.textContent,reason:s?.title,visibleDensity:c?.dataset.sourceRenderScale}
        }).catch(()=>null)
      }
      await persist()
      if(process.env.VERIFY_WHEEL==='1'){
        assert.equal(selected?.size,1,'select one source ID for a wheel replay')
        await fs.writeFile(path.join(out,'wheel.json'),JSON.stringify(await replayWheel(page)))
      }
    }
  }
  assert(report.materials.length>0,'no matching source materials')
  if(selected)assert.equal(report.materials.length,selected.size,'missing source material IDs')
  const budgetMs=Number(process.env.VERIFY_BUDGET_MS||1000)
  assert(Number.isFinite(budgetMs)&&budgetMs>0,'invalid refinement budget')
  const ready=report.materials.filter(r=>r.status==='ready')
  const withinBudget=ready.filter(r=>r.elapsedMs<budgetMs).length
  report.summary={budgetMs,materials:report.materials.length,ready:ready.length,withinBudget,
    readyOverBudget:ready.length-withinBudget,unresolved:report.materials.length-ready.length}
  report.complete=true;await persist()
  if(process.env.VERIFY_REQUIRE_BUDGET==='1'&&withinBudget!==report.materials.length)process.exitCode=1
}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}
