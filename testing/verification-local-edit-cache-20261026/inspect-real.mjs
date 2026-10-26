import {canvasZoom} from '../verification-navigation-priority-20261025/canvas-actions.mjs'
import {topologyTarget} from '../verification-navigation-priority-20261025/topology-target.mjs'
import assert from 'node:assert/strict'
import { readFile,writeFile,mkdir,appendFile,stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { foreground } from '../verification-drag-response-20261024/foreground.mjs'
import { startProfiles,stopProfiles } from '../verification-drag-response-20261024/profile-helpers.mjs'
const root=process.cwd(),out=path.join(root,'testing/verification-local-edit-cache-20261026'),base=JSON.parse(await readFile(path.join(out,'runtime.json'),'utf8'))
const kind=process.argv[2]||'117',name=process.argv[3]||kind+'-baseline',host=process.env.DRAG_HOST||base.host,run=path.join(out,name),tmp=path.join(base.runtime,name)
await mkdir(run);await mkdir(tmp)
const require=createRequire(path.join(root,'frontend/design-client/package.json')),{_electron,expect}=require('@playwright/test')
const report={status:'running',probeVersion:3,onlyPan:process.env.DRAG_ONLY_PAN==='1',host,kind,scope:'independent foreground Electron; native mouse input, rAF DOM cameras and compositor acknowledgements; no physical scanout claim',phases:[],errors:[]}
let app,page;const writes=[];const persist=()=>writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
const settle=async()=>{await page.waitForTimeout(150);await page.waitForFunction(()=>document.querySelector('.kernel-status.error')||document.querySelector('.kernel-tiles')?.dataset.detailReady==='true'&&document.querySelector('.kernel-presentation')?.dataset.presentationReady==='true',null,{timeout:120000});assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(),[])}
const pose=async()=>({x:Number(await page.getByLabel('X',{exact:true}).inputValue()),y:Number(await page.getByLabel('Y',{exact:true}).inputValue()),
  selection:await page.locator('.layer-row.selected').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-testid')))})
const camera=()=>page.locator('.kernel-tiles').evaluate(e=>({x:+e.dataset.requestedCameraX,y:+e.dataset.requestedCameraY,z:+e.dataset.requestedCameraZoom}))
async function replay(label,tool,direction=1){
  await page.getByTestId('canvas').focus();await page.keyboard.press(tool);if(process.env.MOTION_CONTINUOUS!=='1')await settle();await foreground(app,page)
  const box=await page.getByTestId('canvas').boundingBox(),x=Math.round(box.x+box.width*.5),y=Math.round(box.y+box.height*.55)
  await page.evaluate(label=>{
    window.__dragProbe={label,origin:performance.timeOrigin,start:performance.now(),events:[],frames:[]};const p=window.__dragProbe
    const tick=t=>{const root=document.querySelector('.kernel-tiles'),shown=document.querySelector('.kernel-presentation'),c=document.querySelector('.kernel-compositor');p.frames.push({t,retainedPageCommit:root?.dataset.retainedPageCommit,detailReady:root?.dataset.detailReady,requested:root?{x:+root.dataset.requestedCameraX,y:+root.dataset.requestedCameraY,z:+root.dataset.requestedCameraZoom}:null,shown:shown?{x:+(shown.dataset.visualCameraX??shown.dataset.cameraX),y:+(shown.dataset.visualCameraY??shown.dataset.cameraY),z:+shown.dataset.cameraZoom}:null,settled:shown?{x:+shown.dataset.cameraX,y:+shown.dataset.cameraY,z:+shown.dataset.cameraZoom}:null,compositor:c?{...c.dataset}:null});p.raf=requestAnimationFrame(tick)};p.raf=requestAnimationFrame(tick)
    for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{if(window.__dragProbe===p)p.events.push({t:performance.now(),type,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted,coalesced:e.getCoalescedEvents?.().length})},{capture:true})
  },label)
  report.canvasBox=box;const cameraBefore=await camera(),poseBefore=await pose()
  let capture
  if(process.env.CAPTURE_DRAG_MOTION==='1'){
    const directory=path.join(tmp,label+'-png');await mkdir(directory)
    const cdp=await page.context().newCDPSession(page),frames=[]
    cdp.on('Page.screencastFrame',event=>{
      const file=path.join(directory,String(frames.length).padStart(4,'0')+'.png')
      frames.push({file,receivedAt:Date.now(),metadata:event.metadata})
      void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{})
      writes.push(writeFile(file,Buffer.from(event.data,'base64')))
    })
    await cdp.send('Page.startScreencast',{format:'png',everyNthFrame:1})
    capture={cdp,frames}
  }
  const start=Date.now();if(process.env.DRAG_PROFILE==='1')await startProfiles(app)
  const dispatch=await app.evaluate(async({BrowserWindow},{x,y,direction,steps,interval,dx,dy})=>{
    const w=BrowserWindow.getAllWindows()[0],rows=[]
    w.webContents.sendInputEvent({type:'mouseMove',x,y})
    w.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1})
    const started=performance.now()
    for(let i=1;i<=steps;i++){
      const wait=i*interval-(performance.now()-started);if(wait>0)await new Promise(r=>setTimeout(r,wait))
      const px=x+Math.round(direction*dx*i/steps),py=y+Math.round(direction*dy*i/steps)
      w.webContents.sendInputEvent({type:'mouseMove',x:px,y:py,modifiers:['leftButtonDown']});rows.push({at:Date.now(),x:px,y:py})
    }
    w.webContents.sendInputEvent({type:'mouseUp',x:x+direction*dx,y:y+direction*dy,button:'left',clickCount:1});return rows
  },{x,y,direction,steps:Number(process.env.MOTION_STEPS||60),interval:Number(process.env.MOTION_INTERVAL||16),dx:Number(process.env.MOTION_DX||180),dy:Number(process.env.MOTION_DY||80)})
  const stopped=Date.now();if(process.env.MOTION_CONTINUOUS==='1')await page.waitForTimeout(35);else await settle();const ended=Date.now(),cameraAfter=await camera(),poseAfter=await pose()
  if(capture){
    await capture.cdp.send('Page.stopScreencast');await capture.cdp.detach()
    report.motionFrameSets??=[];report.motionFrameSets.push({label,frames:capture.frames})
    if(capture.frames.length<=3){report.sparseCapture??=[];report.sparseCapture.push({label,frames:capture.frames.length})}
  }
  if(process.env.DRAG_PROFILE==='1'){const p=path.join(run,label+'-profile');await mkdir(p);await stopProfiles(app,p,host)}
  const probe=await page.evaluate(()=>{const p=window.__dragProbe;cancelAnimationFrame(p.raf);window.__dragProbe=undefined;return p})
  await writeFile(path.join(run,label+'-frames.json'),JSON.stringify(probe,null,2));await page.screenshot({path:path.join(run,label+'.png')})
  report.phases.push({label,start,stopped,ended,cameraBefore,cameraAfter,poseBefore,poseAfter,dispatch,frames:probe.frames.length,events:probe.events.length,final:probe.frames.at(-1)});await persist()
  assert(probe.events.some(e=>e.type==='pointerdown'&&e.trusted));assert(probe.events.some(e=>e.type==='pointerup'&&e.trusted))
  if(tool==='h'){
    assert(Math.abs(cameraAfter.x-cameraBefore.x-direction*Number(process.env.MOTION_DX||180))<=2,'Pan X did not follow the native pointer trace')
    assert(Math.abs(cameraAfter.y-cameraBefore.y-direction*Number(process.env.MOTION_DY||80))<=2,'Pan Y did not follow the native pointer trace')
    assert.equal(cameraAfter.z,cameraBefore.z)
  }else{
    assert.deepEqual(poseAfter.selection,poseBefore.selection,'Object drag changed the tested selection')
    assert(Number.isFinite(poseBefore.x)&&Number.isFinite(poseBefore.y)&&Number.isFinite(poseAfter.x)&&Number.isFinite(poseAfter.y))
    assert(Math.hypot(poseAfter.x-poseBefore.x,poseAfter.y-poseBefore.y)>0,'Native object drag did not commit a position change')
  }
}
try{
  app=await _electron.launch({executablePath:path.join(root,'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[host,'--desktop-isolated-profile'],cwd:host,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CORE_GPU_WORKING_BUDGET_MIB'].includes(k))),TMPDIR:tmp,CORE_RENDER_DIAGNOSTICS:'detail'},timeout:60000})
  for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',d=>writes.push(appendFile(path.join(run,'host.log'),d)))
  page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(String(e)))
  page.on('console',message=>{if(message.text().startsWith('OWNED_SERIALIZATION_CAUSE ')){report.serializationCauses??=[];try{report.serializationCauses.push(JSON.parse(message.text().slice(26)))}catch{}}})
  report.instance=await app.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.setTitle('独立平移与拖动验证');return {pid:process.pid,profile:app.getPath('userData')}})
  if(process.env.SERIALIZE_METADATA==='1')await app.evaluate((_electron,filename)=>{
    const require=process.getBuiltinModule('module').createRequire(filename),{NativePreparation}=require(filename),original=NativePreparation.prototype.request
    globalThis.__ownedSerialization=[]
    NativePreparation.prototype.request=function(request){
      let row
      if(request?.method==='serialize'&&globalThis.__ownedSerialization.length<128){
        const value=request.args?.[0],nodes=Object.values(value?.nodes||{})
        row={at:Date.now(),kind:value?.fields?'patch':value?.pages?'document':'other',nodes:nodes.length,
          fields:Object.keys(value?.fields||{}),geometryNodes:nodes.filter(n=>n?.vectorGeometry||n?.network).length}
        globalThis.__ownedSerialization.push(row)
      }
      const result=original.call(this,request)
      if(!row)return result
      return result.then(reply=>{row.elapsed=Date.now()-row.at;row.outputChars=typeof reply.value==='string'?reply.value.length:0;row.failed=!!reply.error;return reply})
    }
  },path.join(host,'src/preparation.mjs'))
  if(kind==='sketch'&&process.env.SAVE_EXPORT_DELAY_REPRO==='1'){
    await app.evaluate((_electron,filename)=>{
      const require=process.getBuiltinModule('module').createRequire(filename)
      const {LargeDocumentHost}=require(filename),original=LargeDocumentHost.prototype.sceneCommit
      globalThis.__sourceSaveDelay={arm:false,held:false,release:undefined,restore:()=>{LargeDocumentHost.prototype.sceneCommit=original}}
      LargeDocumentHost.prototype.sceneCommit=async function(...args){
        const actual=await original.apply(this,args)
        if(globalThis.__sourceSaveDelay.arm){
          globalThis.__sourceSaveDelay.held=true
          await new Promise(resolve=>{globalThis.__sourceSaveDelay.release=resolve})
        }
        return actual
      }
    },path.join(host,'src/large-document.mjs'))
  }

  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:60000})
  await page.evaluate(()=>{
    window.__renderRequests=[];window.__sceneSummaries=[];window.__damage=[];window.__watchedWorkers=new WeakSet()
    const send=Worker.prototype.postMessage
    Worker.prototype.postMessage=function(message,...rest){
      if(!window.__watchedWorkers.has(this)){window.__watchedWorkers.add(this);this.addEventListener('message',event=>{if(event.data?.damage)window.__damage.push({at:Date.now(),...event.data})})}

      if(typeof message?.document==='string'&&!window.__motionBegun&&window.__sceneSummaries.length<16){
        try{window.__latestSource=message.document;const d=JSON.parse(message.document),nodes=Object.values(d.nodes||{}),kinds={}
          for(const n of nodes)kinds[n.kind]=(kinds[n.kind]||0)+1
          window.__sceneSummaries.push({at:Date.now(),id:message.id,nodes:nodes.length,pages:d.pages?.length,kinds,
            roots:d.pages?.reduce((sum,p)=>sum+p.children.length,0),serializedBytes:message.document.length})
        }catch{}
      }
      if(message&&typeof message==='object'&&message.options&&window.__renderRequests.length<2048){
        let o;try{o=typeof message.options==='string'?JSON.parse(message.options):message.options}catch{}
        if(o)window.__renderRequests.push({at:Date.now(),id:message.id,channel:message.channel,command:message.command,
          width:o.width,height:o.height,view:o.view,livePreview:o.livePreview,renderIntent:o.renderIntent,
          interactionChannel:o.interactionChannel,retainInteractionGraph:o.retainInteractionGraph,
          interactionOwner:o.interactionOwner,interactionGeneration:o.interactionGeneration,
          tiles:o.tileViewport?.length,documentPatch:!!message.documentPatch,readback:message.readback,
          derived:!!message.deriveFrom,derivedTransforms:message.derivedTransforms?Object.keys(message.derivedTransforms).length:0,
          serializedDocumentChars:typeof message.document==='string'?message.document.length:0})
      }
      return send.call(this,message,...rest)
    }
  })
  const file=kind==='fig'?'/Users/Apple/Downloads/01有料素材 (Copy).fig':kind==='sketch'?'/Users/Apple/Downloads/拓扑素材.sketch':'/Users/Apple/Downloads/117.sketch'
  report.fixture=file
  if(kind==='sketch'){
    await page.getByRole('button',{name:'新建设计',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click()
    await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:60000})
  }
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
  if(kind==='sketch'){
    report.topologyTarget=await topologyTarget(page,expect,settle)
  }else{
    await expect(page.getByLabel('文档名称',{exact:true})).toHaveValue(kind==='fig'?'01有料素材 (Copy)':'117',{timeout:90000});await settle()
    await page.locator('[aria-label="搜索图层"]').fill(kind==='fig'?'01_Dashboard':'117');await page.locator('.layer-name').filter({hasText:kind==='fig'?/^01_Dashboard$/:/^117$/}).first().click()
  }
  await page.keyboard.press('Shift+2');await settle();if(process.env.MOTION_ZOOM){await canvasZoom(page,Number(process.env.MOTION_ZOOM));await settle()}await page.screenshot({path:path.join(run,'before.png')})
  report.sceneSummaries=await page.evaluate(()=>{window.__motionBegun=true;return window.__sceneSummaries})
  const source=await page.evaluate(()=>window.__latestSource)
  await writeFile(path.join(tmp,'source.json'),source)
  const d=JSON.parse(source),parents=new Map(Object.values(d.nodes).flatMap(n=>(n.children||[]).map(id=>[id,n.id])))
  const selected=(await pose()).selection[0]?.slice(6)
  const isInside=id=>{let current=id;while(current){if(current===selected)return true;current=parents.get(current)}return false}
  report.sourceFile=path.join(tmp,'source.json');report.selected=selected
  report.leaves=Object.values(d.nodes).filter(n=>isInside(n.id)&&!(n.children||[]).length&&n.fills?.length).map(n=>({id:n.id,name:n.name,kind:n.kind,w:n.width,h:n.height,transform:n.transform,opacity:n.opacity,layoutParent:d.nodes[parents.get(n.id)]?.layout,ancestor:parents.get(n.id)})).slice(0,150)
  report.effects=Object.values(d.nodes).filter(n=>n.effects?.length).map(n=>({id:n.id,name:n.name,kinds:n.effects.map(e=>e.kind)})).slice(0,30)
  report.status='inspected'
}catch(error){report.status='failed';report.error=String(error);report.stack=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});process.exitCode=1}
finally{
  if(app&&process.env.SERIALIZE_METADATA==='1')report.serialization=await app.evaluate(()=>globalThis.__ownedSerialization).catch(()=>undefined)
  if(page&&!page.isClosed())report.damage=await page.evaluate(()=>window.__damage).catch(()=>undefined)
  if(page&&!page.isClosed())report.renderRequests=await page.evaluate(()=>window.__renderRequests).catch(()=>undefined)
  if(app){const owned=app.process();let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned close timeout')),15000))])}catch(e){report.closeError=String(e);process.exitCode=1;if(owned.exitCode===null&&owned.signalCode===null){owned.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,3000));if(owned.exitCode===null&&owned.signalCode===null)owned.kill('SIGKILL')}}finally{clearTimeout(timer)}}
  await Promise.allSettled(writes);await persist();console.log(JSON.stringify({status:report.status,error:report.error,phases:report.phases.map(p=>({label:p.label,settleMs:p.ended-p.stopped,events:p.events}))}))
}
