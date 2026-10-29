import assert from 'node:assert/strict'
import {appendFile,mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {closeOwnedElectron} from '../verification-source-page-load-20261026/close-owned-electron.mjs'

const root=process.cwd(),desktop=path.join(root,'frontend/design-desktop')
const out=path.join(root,'testing/verification-source-workbench-ui-20261026')
const fixture=process.env.CORE_LARGE_SKETCH_INPUT
assert(fixture,'Set CORE_LARGE_SKETCH_INPUT to the real user-owned Sketch')
const env={...process.env,TMPDIR:await mkdtemp(path.join(tmpdir(),'futureox-real-workbench-'))}
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CORE_DOCUMENT_MEMORY_BYTES','CORE_DOCUMENT_MEMORY_INHERITED'])delete env[key]
const require=createRequire(path.join(root,'frontend/design-client/package.json'))
const {_electron,expect}=require('@playwright/test')
const report={status:'running',scope:'Actual default desktop build, automatic memory policy, real Sketch import and page browsing; no full-page motion claim',sourceHash:createHash('sha256').update(await readFile(fixture)).digest('hex')}
let app,page;const writes=[]
try {
  app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[desktop,'--desktop-isolated-profile'],cwd:desktop,env,timeout:60000})
  report.pid=app.process().pid
  for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',data=>writes.push(appendFile(path.join(out,'real-gui-host.log'),data)))
  page=await app.firstWindow();page.setDefaultTimeout(30000)
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.on('page-title-updated',event=>event.preventDefault());window.setTitle('Futureox Design · 真实文件验证 · 自动内存');window.setSize(1360,880);window.show()})
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  report.capacity=await page.evaluate(()=>window.coreDesktop.documentCapacity)
  assert(report.capacity.memoryBytes>512*1024**2,'automatic policy must support a real source workset on this host')
  if(await page.getByRole('button',{name:'新建设计',exact:true}).isVisible())await page.getByRole('button',{name:'新建设计',exact:true}).click()
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(page.locator('.source-page-entry')).toHaveCount(3,{timeout:180000})
  await expect(page.locator('.source-board-navigation')).toHaveAttribute('data-has-canvas','true')
  report.pages=await page.locator('.source-row-name').allTextContents()
  assert.deepEqual([...report.pages].sort(),['浅色','深色','控件'].sort())
  assert(!await page.locator('.source-workspace-rows').innerText().then(text=>text.includes('JSON')))
  assert.equal(await page.locator('.layers-panel .pages').count(),0)
  assert.equal(await page.locator('.source-status-card [role=alert]').count(),0)
  report.rows=await page.locator('.source-page-row').evaluateAll(rows=>rows.map(row=>({height:row.getBoundingClientRect().height,align:getComputedStyle(row.querySelector('button')).textAlign})))
  assert(report.rows.every(row=>row.height<=36&&row.align==='left'))
  await page.screenshot({path:path.join(out,'real-pages.png')})
  await page.getByRole('button',{name:'载入页面 控件',exact:true}).click()
  await expect(page.locator('.source-status-card [role=status]')).toContainText('完整页面已载入：773',{timeout:120000})
  await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true',null,{timeout:120000})
  report.renderErrors=await page.locator('.kernel-status.error').allTextContents()
  assert.deepEqual(report.renderErrors,[])
  report.loadedPage='控件';report.nodes=773
  const closeNotice=page.getByRole('button',{name:'关闭导入提示',exact:true})
  if(await closeNotice.isVisible())await closeNotice.click()
  await page.screenshot({path:path.join(out,'real-controls.png')})
  await page.getByRole('button',{name:'展开 浅色',exact:true}).click()
  await expect(page.locator('.source-pages-heading small')).toHaveText('209')
  await expect(page.locator('.source-page-entry')).toHaveCount(100)
  report.lightPageRoots=209
  await page.getByRole('button',{name:'全部页面',exact:true}).click()
  await expect(page.locator('.source-page-entry')).toHaveCount(3)
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'real-failure.png')}).catch(()=>{})}
finally{
  if(app)report.cleanup=await closeOwnedElectron(app).catch(error=>{report.status='failed';process.exitCode=1;return {error:String(error)}})
  await Promise.allSettled(writes)
  await writeFile(path.join(out,'real-gui-report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  process.exit(process.exitCode||0)
}
