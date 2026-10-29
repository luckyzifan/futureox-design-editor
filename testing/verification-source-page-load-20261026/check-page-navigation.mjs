// Actual Electron + native source adapter; synthetic low-budget page fixture.
import assert from 'node:assert/strict'
import {cp,copyFile,mkdir,mkdtemp,symlink,writeFile,appendFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {closeOwnedElectron} from './close-owned-electron.mjs'

const root=process.cwd(),out=path.join(root,'testing/verification-source-page-load-20261026')
const runtime=await mkdtemp(path.join(tmpdir(),'futureox-source-page-gui-')),host=path.join(runtime,'host')
const desktop=path.join(root,'frontend/design-desktop')
await mkdir(host)
await cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
await copyFile(path.join(desktop,'package.json'),path.join(host,'package.json'))
await symlink(path.join(desktop,'node_modules'),path.join(host,'node_modules'))
await symlink(path.join(desktop,'assets'),path.join(host,'assets'))
await mkdir(path.join(host,'dist','sidecar'),{recursive:true})
await mkdir(path.join(host,'dist','bin'))
await cp(process.env.CORE_GUI_RENDERER||'/tmp/futureox-source-page-ui-20261026',path.join(host,'dist','renderer'),{recursive:true})
await symlink(path.join(root,'frontend/design-client/public/fonts'),path.join(host,'dist','fonts'))
for(const binary of ['futureox-design-desktop-backend','design-prepare','design-render'])
  await copyFile(path.join(root,'design-studio/target/desktop-dev',binary),path.join(host,'dist',binary.startsWith('futureox')?'sidecar':'bin',binary))
const fixture=path.join(runtime,'page-navigation.sketch')
execFileSync('python3',['-c',`
import json,zipfile,sys,uuid
def layer(i):
 return {'_class':'artboard','do_objectID':str(uuid.UUID(int=i+1)),'name':f'Board {i+1}','frame':{'x':(i%16)*140,'y':(i//16)*140,'width':100,'height':100},'layers':[{'_class':'rectangle','do_objectID':str(uuid.UUID(int=i+1001)),'name':'Rectangle','frame':{'x':0,'y':0,'width':80,'height':80}}]}
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('meta.json',json.dumps({'version':136}))
 z.writestr('document.json',json.dumps({'pages':[{'_ref':f'pages/{p}'} for p in ['a','b','c']]}))
 for p,name,start,count in [('a','Page A',0,192),('b','Page B',200,2),('c','Page C',210,2)]:
  z.writestr(f'pages/{p}.json',json.dumps({'_class':'page','do_objectID':p,'name':name,'layers':[layer(i) for i in range(start,start+count)]}))
`,fixture])
const require=createRequire(path.join(root,'frontend/design-client/package.json'))
const {_electron,expect}=require('@playwright/test')
let app,page;const writes=[]
const report={scope:'Actual Electron/native source navigation, synthetic 192-root page, 1 MiB trusted memory / 64 KiB document allowance; not real-topology rendering performance',status:'running'}
try{
  app=await _electron.launch({executablePath:path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],cwd:host,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CORE_DOCUMENT_MEMORY_INHERITED'].includes(k))),TMPDIR:runtime,CORE_DOCUMENT_MEMORY_BYTES:'1048576'},timeout:60000})
  for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',data=>writes.push(appendFile(path.join(out,'gui-host.log'),data)))
  page=await app.firstWindow();page.setDefaultTimeout(30000)
  await app.evaluate(({dialog,BrowserWindow},fixture)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});const w=BrowserWindow.getAllWindows()[0];w.on('page-title-updated',event=>event.preventDefault());w.setTitle('自动化测试 · 1 MiB · 请勿用于设计');w.setSize(1280,800);w.hide()},fixture)
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  if(await page.getByRole('button',{name:'新建设计',exact:true}).isVisible())await page.getByRole('button',{name:'新建设计',exact:true}).click()
  await page.getByRole('button',{name:'保存',exact:true}).click()
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
  await page.getByRole('button',{name:'文件菜单',exact:true}).click()
  await page.getByRole('button',{name:'打开大型 JSON / Sketch…',exact:true}).click()
  await expect(page.getByRole('button',{name:'页面 / 画板',exact:true})).toBeVisible({timeout:60000})
  await page.getByRole('button',{name:'页面 / 画板',exact:true}).click()
  await expect(page.locator('.source-workspace-rows>div').filter({hasText:/Page [ABC]/})).toHaveCount(3,{timeout:60000})
  report.pages=await page.locator('.source-workspace-rows').innerText()
  assert(report.pages.includes('Page A')&&report.pages.includes('Page B')&&report.pages.includes('Page C'))
  await page.screenshot({path:path.join(out,'gui-all-pages.png')})
  await page.locator('.source-workspace-rows>div').filter({hasText:'Page A'}).locator('button').first().click()
  const ranges=page.locator('[aria-label="页面分段"]')
  await expect(ranges).toBeVisible({timeout:60000})
  report.firstRange=await ranges.innerText()
  await page.getByRole('button',{name:'下一部分',exact:true}).click()
  await expect.poll(()=>ranges.innerText()).not.toBe(report.firstRange)
  report.secondRange=await ranges.innerText()
  await page.screenshot({path:path.join(out,'gui-page-range.png')})
  await page.getByRole('button',{name:'上一部分',exact:true}).click()
  await expect.poll(()=>ranges.innerText()).toBe(report.firstRange)
  report.renderErrors=await page.locator('.kernel-status.error').allTextContents()
  assert.deepEqual(report.renderErrors,[])
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'gui-failure.png')}).catch(()=>{})}
finally{
  if(app)report.cleanup=await closeOwnedElectron(app).catch(error=>{report.status='failed';process.exitCode=1;return {error:String(error)}})
  await Promise.allSettled(writes)
  await writeFile(path.join(out,'gui-report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  // No lingering inspector/Playwright transport may keep a fault-injection
  // launcher alive after the owned Electron process has been verified dead.
  process.exit(process.exitCode||0)
}
