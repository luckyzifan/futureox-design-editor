import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const root=process.cwd(),[kind,out]=process.argv.slice(2)
const {_electron,expect}=createRequire(path.join(process.cwd(),'frontend/design-client/package.json'))('@playwright/test')
const files:Record<string,string>={ '117':'/Users/Apple/Downloads/117.sketch',fig:'/Users/Apple/Downloads/01有料素材 (Copy).fig' }
if(!files[kind]||!out||!path.isAbsolute(out))throw Error('Usage: bun gui-journey.ts 117|fig FRESH_ABSOLUTE_OUTPUT')
await fs.mkdir(out);const profiles=path.join(out,'profiles');await fs.mkdir(profiles)
const source=files[kind],title=path.basename(source).replace(/\.(sketch|fig)$/,''),desktop=path.join(root,'frontend/design-desktop')
const require=createRequire(path.join(desktop,'package.json')),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const sourceHash=hash(await fs.readFile(source)),report:any={status:'running',source,sourceHash,startedAt:new Date().toISOString(),cases:[],scope:'Owned production Electron, real GUI import and edits, SQLite and FD reopen. No physical scanout claim.'}
const persist=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
let app:any,page:any,saved:any,target:any
const fd=path.join(out,kind+'-roundtrip.fd')
async function close(){if(!app)return;const owned=app,child=owned.process();app=undefined;let timer:ReturnType<typeof setTimeout>|undefined
 try{await Promise.race([owned.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned application close timeout')),15000)})])}
 catch(e){report.closeErrors??=[];report.closeErrors.push(String(e));if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}}
 finally{clearTimeout(timer)}}
async function stage(id:string,fn:()=>Promise<void>){report.stage=id;await persist();const start=performance.now();try{await fn();report.cases.push({id,status:'PASS',wallMs:performance.now()-start})}catch(e){report.cases.push({id,status:'FAIL',wallMs:performance.now()-start,error:String(e)});throw e}finally{await persist();console.log(id)}}
async function settle(){
 await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true',null,{timeout:180000})
 expect(await page.locator('.kernel-status.error').allTextContents()).toEqual([])
 await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-backend','gpu')
 await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-fallback-phase','none')
}
async function launch(file:string){
 const env={...process.env,TMPDIR:profiles,CORE_RENDER_DIAGNOSTICS:'detail'};delete (env as any).ELECTRON_RUN_AS_NODE;delete (env as any).NODE_OPTIONS
 app=await _electron.launch({executablePath:require('electron'),args:[desktop,'--desktop-isolated-profile'],cwd:desktop,env,chromiumSandbox:true,timeout:60000})
 for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',(data:Buffer)=>{void fs.appendFile(path.join(out,'host.log'),data)})
 page=await app.firstWindow();page.setDefaultTimeout(30000)
 page.on('pageerror',(e:Error)=>{report.pageErrors??=[];report.pageErrors.push(String(e))})
 report.instances??=[];report.instances.push(await app.evaluate(({app,BrowserWindow}:any)=>{
  const w=BrowserWindow.getAllWindows()[0];w.show();w.setSize(1440,960);w.setTitle('渲染重构 · 独立功能回归')
  const p=w.webContents.getLastWebPreferences();return {pid:process.pid,profile:app.getPath('userData'),sandbox:p.sandbox,contextIsolation:p.contextIsolation,webSecurity:p.webSecurity,nodeIntegration:p.nodeIntegration}
 }))
 await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
 await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(title,{timeout:120000})
 await settle()
}
async function stored(){return page.evaluate(async(name:string)=>{
 const bridge=(window as any).coreDesktop.workspace
 for(let attempt=0;attempt<30;attempt++){
  const list=await bridge.list();if(list.status!=='ok')throw Error(list.message)
  const entry=list.documents.find((d:any)=>d.name===name)
  if(entry){const reply=await bridge.open({id:entry.id});if(reply.status==='ok')return JSON.parse(reply.documentJson);if(reply.code!=='WORKSPACE_BUSY')throw Error(reply.message)}
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 throw Error('Saved document unavailable')
},title)}
async function save(){await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})}
async function select(id:string){await page.getByLabel('搜索图层',{exact:true}).fill(saved.nodes[id].name);await page.getByTestId('layer-'+id).click()}
async function zoom(percent:number){
 await page.locator('.view-menu summary').click();const input=page.getByLabel('缩放比例',{exact:true});await input.fill(String(percent));await input.press('Enter');await input.press('Escape')
}
try{
 await stage('import',async()=>{await launch(source);await save();saved=await stored();report.imported={id:saved.id,nodes:Object.keys(saved.nodes).length,pages:saved.pages.length};target=saved.pages.flatMap((p:any)=>p.children.map((id:string)=>saved.nodes[id])).find((n:any)=>n.kind==='frame'&&n.name===(kind==='fig'?'01_Dashboard':'117'));if(!target)throw Error('Expected real board absent');report.target=target.id;await select(target.id);await page.keyboard.press('Shift+2');await settle();await page.screenshot({path:path.join(out,'01-import.png')})})
 await stage('zoom-pan',async()=>{
  await zoom(100);await settle();await zoom(3200);await page.waitForTimeout(80);await zoom(125);await settle()
  const box=await page.getByTestId('canvas').boundingBox();if(!box)throw Error('Canvas absent')
  await page.getByTestId('canvas').focus()
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.keyboard.down('Control');for(const dy of [-120,-180,-160,180,180,100]){await page.mouse.wheel(0,dy);await page.waitForTimeout(16)}await page.keyboard.up('Control');await settle()
  await page.keyboard.down('Space');await page.mouse.down();await page.mouse.move(box.x+box.width/2+100,box.y+box.height/2+60,{steps:12});await page.mouse.up();await page.keyboard.up('Space');await settle()
  await page.keyboard.press('Shift+2');await settle();await save();expect(await stored()).toEqual(saved)
  await page.screenshot({path:path.join(out,'02-motion.png')})
 })
 await stage('object-drag-undo',async()=>{
  await select(target.id);await page.keyboard.press('Shift+2');await settle()
  const input=page.getByLabel('X',{exact:true}),before=await input.inputValue(),box=await page.getByTestId('canvas').boundingBox()
  await page.getByTestId('canvas').focus();await page.keyboard.press('v')
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down()
  await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+40,{steps:12});await page.mouse.up();await settle()
  expect(await input.inputValue()).not.toBe(before)
  await page.keyboard.press('Meta+z');await expect(input).toHaveValue(before);await settle();await save();expect(await stored()).toEqual(saved)
 })
 await stage('resize-rotate-undo',async()=>{
  for(const name of ['W','旋转 °']){
   const input=page.getByLabel(name,{exact:true}),before=await input.inputValue(),value=Number(before)+(name==='W'?7:15)
   await input.fill(String(value));await input.press('Enter');await input.press('Tab');await settle()
   await page.keyboard.press('Meta+z');await expect(input).toHaveValue(before);await settle()
   await page.keyboard.press('Meta+Shift+z');await expect(input).toHaveValue(String(value));await settle()
   await page.keyboard.press('Meta+z');await settle()
  }
 })
 await stage('move-undo',async()=>{
  const input=page.getByLabel('X',{exact:true}),before=await input.inputValue()
  await page.getByTestId('canvas').click({position:{x:10,y:10}});await select(target.id)
  await page.keyboard.press('ArrowRight');await settle();const after=await input.inputValue();expect(after).not.toBe(before)
  await page.keyboard.press('Meta+z');await expect(input).toHaveValue(before);await settle()
 })
 await stage('property-save',async()=>{
  const input=page.getByLabel('透明度 %',{exact:true}),before=await input.inputValue()
  await input.fill('87.5');await input.press('Enter');await input.press('Tab');await settle()
  await page.keyboard.press('Meta+z');await expect(input).toHaveValue(before);await settle()
  await page.keyboard.press('Meta+Shift+z');await expect(input).toHaveValue('87.5');await settle();await save()
  const next=await stored(),expected=structuredClone(saved);expected.nodes[target.id].opacity=.875
  expect(next).toEqual(expected);saved=next;await page.screenshot({path:path.join(out,'03-edited.png')})
 })
 await stage('png-1x-2x-3x-export',async()=>{
  const stack=[target.id],candidates:any[]=[]
  while(stack.length){const n=saved.nodes[stack.pop()!];if(!n)continue;stack.push(...n.children);if(n.kind!=='text'&&n.children.length===0&&n.visible!==false&&!n.locked&&n.width>=1&&n.width<=96&&n.height>=1&&n.height<=96)candidates.push(n)}
  if(!candidates.length)throw Error('No small real leaf in selected board')
  const n=candidates[0];await select(n.id)
  await page.getByLabel('文件菜单',{exact:true}).click();await page.getByRole('button',{name:'导出图像 · 1x / 2x / 3x',exact:true}).click()
  const panel=page.getByRole('dialog',{name:'导出图像',exact:true});await panel.getByLabel('选中图层 / Frame',{exact:true}).check()
  await panel.getByRole('button',{name:'生成 PNG',exact:true}).click();await expect(panel.locator('.export-assets img')).toHaveCount(3,{timeout:120000})
  report.pngs=await panel.locator('.export-assets img').evaluateAll(async(images:any[])=>Promise.all(images.map(async img=>{await img.decode();return {alt:img.alt,width:img.naturalWidth,height:img.naturalHeight}})))
  for(const [i,p]of report.pngs.entries()){
   expect(p.width).toBeGreaterThan(0);expect(p.height).toBeGreaterThan(0);const file=path.join(out,`export-${i+1}x.png`)
   await app.evaluate(({BrowserWindow}:any,file:string)=>{BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event:any,item:any)=>item.setSavePath(file))},file)
   await panel.locator('.export-assets a').nth(i).click();await expect.poll(()=>fs.stat(file).then(s=>s.size).catch(()=>0),{timeout:30000}).toBeGreaterThan(8)
   const bytes=await fs.readFile(file);expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);p.sha256=hash(bytes);p.byteLength=bytes.length
  }
  report.pngTarget=n.id;await panel.getByRole('button',{name:'关闭切图',exact:true}).click();await select(target.id)
 })
 await stage('fd-save',async()=>{
  await app.evaluate(({dialog}:any,file:string)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},fd)
  await page.getByLabel('文件菜单',{exact:true}).click();await page.getByRole('button',{name:'另存为设计文件…',exact:true}).click()
  await expect.poll(()=>fs.stat(fd).then(s=>s.size).catch(()=>0),{timeout:60000}).toBeGreaterThan(0)
  await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
 })
 await stage('fd-reopen',async()=>{await close();await launch(fd);const reopened=await stored();expect({...reopened,id:saved.id}).toEqual(saved);await select(target.id);await expect(page.getByLabel('透明度 %',{exact:true})).toHaveValue('87.5');await page.keyboard.press('Shift+2');await settle();await page.screenshot({path:path.join(out,'04-reopened.png')})})
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}
finally{await close();report.sourceUnchanged=sourceHash===hash(await fs.readFile(source));if(!report.sourceUnchanged)report.status='failed';report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,cases:report.cases,error:report.error}));if(report.status!=='passed')process.exitCode=1}
