/** Real editor + real owned Rust/SQLite process. Native dialogs/clipboard are separate host/GUI checks. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Sidecar } from '../../design-desktop/src/sidecar.mjs'
const output=await realpath(await mkdtemp(join(tmpdir(),'forma-local-workspace-')))
await mkdir(join(output,'recovery'))
const binary=process.env.CORE_DESKTOP_SIDECAR||resolve('../../design-studio/target/debug/futureox-design-desktop-backend')
let backend=new Sidecar(binary,join(output,'recovery'),{workspaceDb:join(output,'workspace.sqlite3')})
const server=spawn('bun',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']})
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
const steps:string[]=[],errors:string[]=[]
try{
 const base=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite timeout')),20000);server.on('exit',c=>{clearTimeout(timer);reject(Error(`Vite ${c}`))});server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0])}})})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]})
 const gpu = process.env.FORMA_WORKSPACE_GPU === '1'
 const page=await browser.newPage({viewport:{width:1440,height:940}})
 page.on('pageerror',e=>errors.push(String(e)))
 await page.exposeFunction('ownedWorkspaceRpc',async(method:string,params:any)=>{
   if(!['workspace.list','workspace.open','workspace.commit','workspace.trash','workspace.revisions','workspace.restore'].includes(method))throw Error('Fixture RPC denied')
   try{
     const result=await backend.request(method,method==='workspace.commit'?{document:JSON.parse(params.documentJson),expectedRevision:params.expectedRevision,mutationId:params.mutationId}:params||{})
     const {document,...metadata}=result
     return {status:'ok',...metadata,...(document?{documentJson:JSON.stringify(document)}:{})}
   }catch(e:any){return{status:e.code==='WORKSPACE_CONFLICT'?'conflict':'error',code:e.code,message:String(e)}}
 })
 await page.addInitScript((gpu)=>{
   const ok={status:'ok'},cancelled={status:'cancelled'},rpc=(method:string,value?:unknown)=>(window as any).ownedWorkspaceRpc(method,value)
   Object.defineProperty(window,'coreDesktop',{value:Object.freeze({version:1,renderPolicy:Object.freeze({cpuOnly:!gpu}),
     workspace:Object.freeze({list:(v:any)=>rpc('workspace.list',v),open:(v:any)=>rpc('workspace.open',v),commit:(v:any)=>rpc('workspace.commit',v),trash:(v:any)=>rpc('workspace.trash',v),revisions:(v:any)=>rpc('workspace.revisions',v),restore:(v:any)=>rpc('workspace.restore',v)}),
     readRecovery:async()=>cancelled,writeRecovery:async()=>ok,clearRecovery:async()=>ok,setDirty:async()=>{},
     openDocument:async()=>cancelled,saveDocument:async()=>cancelled,acceptDocument:async()=>ok,
     onCommand:()=>()=>{},onCloseRequested:()=>()=>{},respondToClose:async()=>({accepted:true}),
   })})
 }, gpu)
 await page.goto(base)
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true')
 const canvas=page.getByTestId('canvas')
 if(gpu) await expect.poll(()=>page.locator('.kernel-tiles').getAttribute('data-detail-ready'),{timeout:45000}).toBe('true')
 else await page.locator('canvas.kernel-surface[data-renderer=cpu][data-frame-visible=true]').waitFor({timeout:30000})
 const box=(await canvas.boundingBox())!
 await page.getByLabel('矩形',{exact:true}).click()
 await page.mouse.move(box.x+180,box.y+170);await page.mouse.down();await page.mouse.move(box.x+340,box.y+280,{steps:8});await page.mouse.up()
 const title=page.getByLabel('文档名称');await title.fill('SQLite 本地设计 A');await title.press('Enter')
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:15000})
 const first=(await backend.request('workspace.list')).documents[0]
 expect(first.name).toBe('SQLite 本地设计 A')
 const firstOpen=await backend.request('workspace.open',{id:first.id});expect(Object.keys(firstOpen.document.nodes)).toHaveLength(1)
 steps.push('real editor drawing and rename persisted in Rust SQLite')
 await page.screenshot({path:join(output,'sqlite-editor.png')})
 await page.getByLabel('新建文档标签').click()
 await title.fill('SQLite 本地设计 B');await title.press('Enter')
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:15000})
 await expect(page.getByRole('tab',{name:'SQLite 本地设计 A',exact:true})).toBeVisible()
 await page.getByRole('tab',{name:'SQLite 本地设计 A',exact:true}).click()
 await expect(title).toHaveValue('SQLite 本地设计 A')
 steps.push('two local document tabs switch through durable revisions')
 await expect(page.locator('.workspace-rail').getByRole('button',{name:'文件',exact:true})).toHaveCount(0)
 const openLibrary=page.locator('.document-location')
 await expect(openLibrary).toHaveText('本机设计')
 await openLibrary.click()
 await expect(page.getByRole('dialog',{name:'本机文档库'})).toBeVisible()
 await expect(page.getByRole('button',{name:/SQLite 本地设计 B.*版本/})).toBeVisible()
 await page.screenshot({path:join(output,'sqlite-library.png')})
 const firstLibrary=page.getByRole('dialog',{name:'本机文档库'}),search=page.getByLabel('搜索本机设计')
 await expect(search).toBeFocused()
 await search.fill('不存在的设计');await expect(firstLibrary.getByText('没有匹配的设计',{exact:true})).toBeVisible();await expect(firstLibrary.locator('.local-file-row')).toHaveCount(0)
 await search.fill('SQLite 本地设计 B');await expect(firstLibrary.locator('.local-file-row')).toHaveCount(1);await expect(firstLibrary.getByRole('button',{name:/SQLite 本地设计 B.*版本/})).toBeVisible()
 await search.fill('')
 const lastLibraryControl=firstLibrary.locator('button:not(:disabled),input:not(:disabled)').last()
 await lastLibraryControl.focus();await page.keyboard.press('Tab');await expect(page.getByLabel('关闭本机文档库')).toBeFocused()
 await page.keyboard.press('Shift+Tab');await expect(lastLibraryControl).toBeFocused()
 await page.keyboard.press('Escape');await expect(firstLibrary).toHaveCount(0);await expect(openLibrary).toBeFocused()
 steps.push('local library filters names, shows a search empty state and owns/restores keyboard focus')
 await title.fill('SQLite 本地设计 A 已修改');await title.press('Enter')
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:15000})
 const revisions=await backend.request('workspace.revisions',{id:first.id});expect(revisions.revisions.length).toBeGreaterThan(1)
 steps.push('local library and revision history reflect committed edits')
 await openLibrary.click()
 const library=page.getByRole('dialog',{name:'本机文档库'})
 const aRow=library.locator('.local-file-row').filter({has:page.getByRole('button',{name:/^SQLite 本地设计 A 已修改.*版本/})})
 await aRow.getByRole('button',{name:'历史版本',exact:true}).click()
 const history=page.getByRole('region',{name:'文档历史版本'})
 await history.locator('.local-file-row').filter({has:page.getByText(new RegExp(`^版本 ${first.revision} ·`))}).getByRole('button',{name:'恢复此版本',exact:true}).click()
 await expect(title).toHaveValue('SQLite 本地设计 A')
 const restored=await backend.request('workspace.open',{id:first.id})
 expect(restored.revision).toBe(revisions.revisions[0].revision+1)
 expect(restored.document).toEqual(firstOpen.document)
 steps.push('restoring history through the UI creates a new durable head without rewriting history')
 await openLibrary.click()
 const bRow=library.locator('.local-file-row').filter({has:page.getByRole('button',{name:/^SQLite 本地设计 B.*版本/})})
 await bRow.getByRole('button',{name:'移入回收站',exact:true}).click()
 await expect(bRow).toHaveCount(0)
 await library.getByRole('button',{name:'回收站',exact:true}).click()
 await bRow.getByRole('button',{name:'恢复',exact:true}).click()
 await expect(bRow).toHaveCount(0)
 await library.getByRole('button',{name:'全部设计',exact:true}).click()
 await expect(bRow).toBeVisible()
 await page.getByLabel('关闭本机文档库').click()
 expect((await backend.request('workspace.list')).documents).toHaveLength(2)
 steps.push('library trash and recovery retain both actual SQLite documents')
 await backend.stop();backend=new Sidecar(binary,join(output,'recovery'),{workspaceDb:join(output,'workspace.sqlite3')})
 await page.reload()
 // Opening B after trash recovery proves the restart does not depend on the old in-memory tab.
 await expect(title).toHaveValue('SQLite 本地设计 B',{timeout:15000})
 await openLibrary.click()
 await library.getByRole('button',{name:/^SQLite 本地设计 A.*版本/}).click()
 await expect(title).toHaveValue('SQLite 本地设计 A')
 expect(Object.keys((await backend.request('workspace.open',{id:first.id})).document.nodes)).toHaveLength(1)
 steps.push('owned backend restart and renderer reload recover actual SQLite design')
 await page.screenshot({path:join(output,'sqlite-reopened.png')})
 expect(errors).toEqual([])
 await writeFile(join(output,'results.json'),JSON.stringify({steps,errors,scope:'Real browser editor with fixed test bridge to real Rust/SQLite; not native-dialog verification.'},null,2))
 console.log(JSON.stringify({output,steps,errors}))
}catch(error){
 const page=browser?.contexts()[0]?.pages()[0];if(page) { await writeFile(join(output,'ui-failure.json'),JSON.stringify({body:await page.locator('body').innerText(),status:await page.locator('.kernel-status').getAttribute('title').catch(()=>null)})); } if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{})
 await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),steps,errors},null,2));console.log(JSON.stringify({output,error:String(error)}));throw error
}finally{await browser?.close();await backend.stop();server.kill('SIGTERM')}
