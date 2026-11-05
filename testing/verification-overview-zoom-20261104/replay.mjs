// File overview uses trusted pointer/wheel input. A separate oracle launch can render an exact recorded camera.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const [product,file,out]=process.argv.slice(2).map(p=>path.resolve(p))
const fileHash=createHash('sha256').update(await fs.readFile(file)).digest('hex')
const desktop=path.resolve('frontend/design-desktop')
const electron=createRequire(path.join(desktop,'package.json'))('electron')
const {_electron}=createRequire(path.resolve('frontend/design-client/package.json'))('playwright')
await fs.mkdir(out)
const scratch=await fs.mkdtemp(path.join(tmpdir(),'futureox-overview-'))
const host=path.join(scratch,'host'),direct=process.env.OVERVIEW_PROJECT==='1'
if(!direct){
  await fs.mkdir(host);await fs.cp(process.env.OVERVIEW_HOST||path.join(desktop,'src'),path.join(host,'src'),{recursive:true})
  await fs.symlink(product,path.join(host,'dist'));await fs.symlink(path.join(desktop,'assets'),path.join(host,'assets'))
  await fs.writeFile(path.join(host,'package.json'),JSON.stringify({type:'module',main:'observe.mjs'}))
  const observer=pathToFileURL(path.resolve('testing/verification-topology-completion-20261104/source-timing.mjs')).href
  await fs.writeFile(path.join(host,'observe.mjs'),`import {NativePreparation} from './src/preparation.mjs'
import {Sidecar} from './src/sidecar.mjs'
import {LargeDocumentHost} from './src/large-document.mjs'
import {observeSourceCompiles} from ${JSON.stringify(observer)}
import {appendFileSync} from 'node:fs'
const observed=new WeakSet(),call=Sidecar.prototype.request
Sidecar.prototype.request=function(...args){
 if(!observed.has(this)){observed.add(this);this.child.stderr.on('data',chunk=>appendFileSync(${JSON.stringify(path.join(out,'backend.log'))},chunk))}
 return call.apply(this,args)
}
observeSourceCompiles(NativePreparation,${JSON.stringify(path.join(out,'packets.ndjson'))})
${process.env.DENSE_SNAPSHOT_SCOPE?`const {observeDenseSource}=await import(${JSON.stringify(new URL('../verification-dense-refinement-20261104/probe.mjs',import.meta.url).href)});observeDenseSource(NativePreparation,${JSON.stringify(out)},${JSON.stringify(process.env.DENSE_SNAPSHOT_SCOPE)})`:''}
const opening=LargeDocumentHost.prototype.openingView
LargeDocumentHost.prototype.openingView=async function(req){const t=Date.now(),r=await opening.call(this,req);if(r.detail)appendFileSync(${JSON.stringify(path.join(out,'detail.ndjson'))},JSON.stringify({t,at:Date.now(),index:r.detail.index,viewport:req.viewport,encoded:r.detail.png.length,indexing:r.indexing})+'\\n');return r}
const preview=LargeDocumentHost.prototype.canvasPreview
LargeDocumentHost.prototype.canvasPreview=async function(req){const t=Date.now();const r=await preview.call(this,req);
appendFileSync(${JSON.stringify(path.join(out,'previews.ndjson'))},JSON.stringify({t,ms:Date.now()-t,phase:r.phase,bounds:r.bounds,width:r.width,height:r.height,scale:r.scale})+'\\n');return r}
const original=LargeDocumentHost.prototype.canvasSnapshot
LargeDocumentHost.prototype.canvasSnapshot=async function(req){const t=Date.now()
 try{const r=await original.call(this,req);appendFileSync(${JSON.stringify(path.join(out,'scopes.ndjson'))},JSON.stringify({t,ms:Date.now()-t,keys:req.materialKeys,window:req.navigationWindow,bytes:r.bytes,nodes:r.nodes,status:r.status})+'\\n');return r}
 catch(error){appendFileSync(${JSON.stringify(path.join(out,'scopes.ndjson'))},JSON.stringify({t,ms:Date.now()-t,keys:req.materialKeys,error:String(error)})+'\\n');throw error}}
await import('./src/main.mjs')`)
}else assert.equal(product,path.join(desktop,'dist'))
const env={...process.env,CORE_RENDER_DIAGNOSTICS:'1',TMPDIR:scratch};delete env.ELECTRON_RUN_AS_NODE
const app=await _electron.launch({executablePath:electron,args:[direct?desktop:host,'--desktop-isolated-profile'],env,chromiumSandbox:true})
const log=createWriteStream(path.join(out,'render.log'))
for(const pipe of [app.process().stdout,app.process().stderr])pipe?.on('data',chunk=>log.write(chunk))
const report={fileHash,segments:[],entry:direct?'project':'isolated'}
let page
try{
  page=await app.firstWindow()
  page.on('pageerror',error=>void fs.appendFile(path.join(out,'console.log'),String(error)+'\n'))
  page.on('console',message=>{if(['error','warning'].includes(message.type()))void fs.appendFile(path.join(out,'console.log'),message.text()+'\n')})
  const thumbsDir=await app.evaluate(({app})=>app.getPath('userData')+'/recovery-v1/large-documents/opening-thumbnails')
  if(process.env.OVERVIEW_THUMBS){await fs.mkdir(thumbsDir,{recursive:true});for(const name of await fs.readdir(process.env.OVERVIEW_THUMBS))if(name.endsWith('.thumb'))await fs.copyFile(path.join(process.env.OVERVIEW_THUMBS,name),path.join(thumbsDir,name))}
  const screen=async(name,b)=>{if(process.env.OVERVIEW_GUI!=='1'&&!(process.env.DENSE_PIXELS==='1'&&name.startsWith('dense-')))return
    const rect={x:Math.round(b.x+14),y:Math.round(b.y+155),width:Math.floor(b.width)-28,height:Math.floor(b.height)-235}
    const encoded=await app.evaluate(async({BrowserWindow},box)=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(box)).toPNG().toString('base64'),rect)
    await fs.writeFile(path.join(out,name+'.png'),Buffer.from(encoded,'base64'))
    if(['neighbours','return','dense-settled','dense-shifted','dense-return','dense-retarget','far-area','high-100','high-3200','high-pan-return','high-return','high-second-return','high-cross-return','high-cross-held'].includes(name)){
      const capture=await page.locator('.native-source-content').evaluate(c=>{
        const holder=document.querySelector('[data-testid="canvas"]').getBoundingClientRect(),r=c.getBoundingClientRect()
        const copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;copy.getContext('2d').drawImage(c,0,0)
        return {x:(r.x-holder.x)*devicePixelRatio,y:(r.y-holder.y)*devicePixelRatio,dpr:devicePixelRatio,png:copy.toDataURL().split(',')[1]}
      })
      await fs.writeFile(path.join(out,name+'-native.png'),Buffer.from(capture.png,'base64'))
      report[name+'Native']={x:capture.x,y:capture.y,dpr:capture.dpr}
    }
  }
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setSize(1440,960);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive()})
  const cdp=await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true})
  await page.locator('.app-shell[data-desktop-ready=true]').waitFor()
  await page.evaluate(()=>{
    const r=window.__ov={frames:[],inputs:[],thumbnailReceipts:[],clicks:0,live:true}
    const ids=new WeakMap();let counter=0
    const tick=()=>{if(!r.live)return
      const svg=document.querySelector('.source-opening-surface'),g=svg?.firstElementChild
      const v=g?.getAttribute('transform')?.match(/[-+.\deE]+/g)?.filter(n=>Number.isFinite(Number(n))).map(Number)
      const c=document.querySelector('.native-source-content'),h=c?.closest('.native-source-surface'),nav=document.querySelector('.source-board-navigation')
      if(c&&!ids.has(c))ids.set(c,++counter)
      r.frames.push([performance.timeOrigin+performance.now(),v||null,c?ids.get(c):0,h?getComputedStyle(h).visibility:'absent',h?.querySelector('.kernel-status')?.textContent||'',
        Number(c?.dataset.sourceShownSequence)||0,Number(c?.dataset.sourceShownNewScale)||0,Number(c?.dataset.sourceBitmapScale)||0,
        c?.dataset.sourceReadyCamera||'',Number(nav?.dataset.detailRoots)||0,Number(svg?.dataset.renderedMaterials)||0,Number(document.querySelector('.source-overview-image')?.dataset.worldScale)||0,
        Boolean(document.querySelector('.source-overview-handoff')),h?.querySelector('.kernel-status')?getComputedStyle(h.querySelector('.kernel-status')).opacity:'',c?.dataset.sourceRegionalMaterials||'',c?.dataset.sourceShownCoverage||''])
      requestAnimationFrame(tick)
    };requestAnimationFrame(tick)
    const attached=new WeakSet()
    const listen=image=>{
      if(attached.has(image))return
      attached.add(image);image.addEventListener('load',()=>{
        const src=image.getAttribute('href'),pos=src?.indexOf(',')??-1
        if(pos<0)return
        const h=atob(src.slice(pos+1,pos+33)),u=i=>h.charCodeAt(i)*16777216+h.charCodeAt(i+1)*65536+h.charCodeAt(i+2)*256+h.charCodeAt(i+3)
        r.thumbnailReceipts.push([performance.timeOrigin+performance.now(),Number(image.dataset.openingMaterial),u(16),u(20)])
      })
    }
    new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes){
      if(node.matches?.('image[data-opening-material]'))listen(node)
      for(const image of node.querySelectorAll?.('image[data-opening-material]')??[])listen(image)
    }}).observe(document.body,{childList:true,subtree:true})
    window.addEventListener('click',e=>{if(e.target.closest?.('.source-page-entry'))r.clicks++},true)
    for(const type of ['pointermove','pointerup','wheel'])window.addEventListener(type,e=>{
      if(e.isTrusted&&(e.buttons||type!=='pointermove')&&e.target.closest?.('[data-testid="canvas"]'))r.inputs.push([performance.timeOrigin+performance.now(),type,e.clientX,e.clientY,e.deltaY??0])
    },true)
  })
  const epoch=()=>page.evaluate(()=>performance.timeOrigin+performance.now())
  report.open=await epoch()
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
  if(process.env.OVERVIEW_DIAGNOSTIC==='1'){
    await page.waitForTimeout(6000)
    await fs.writeFile(path.join(out,'early.json'),JSON.stringify(await page.evaluate(()=>({
      text:document.body.innerText.slice(0,7000),
      materials:document.querySelectorAll('.source-page-entry[data-source-material-id]').length,
      images:[...document.querySelectorAll('image[data-opening-material]')].map(n=>({i:n.dataset.openingMaterial,x:n.getAttribute('x'),y:n.getAttribute('y')})),
    })),null,2))
    await page.screenshot({path:path.join(out,'early.png')})
  }
  const ids=['13C88C4A-E57E-4793-82A6-9EC5DA7FDA62','9DD6B419-A85F-432D-AFC6-AF2A5F5B4FF6','59AD38D3-0BFE-487B-AB68-DB970F9A0325','C00A68A4-68CC-481D-B3ED-AD33630E7FFD','15320022-5CAD-4B16-A924-A05C502D25BA']
  const known=process.env.OVERVIEW_LAYOUT?JSON.parse(await fs.readFile(process.env.OVERVIEW_LAYOUT,'utf8')):undefined
  if(known){assert.equal(report.fileHash,'498098eb5e390e7088245c267a01896b1b832ad61098faddb1fba35f5ac8da86')
    await page.waitForFunction(()=>document.querySelectorAll('.source-page-entry[data-source-material-id]').length===306&&window.__ov.frames.at(-1)?.[1]?.[2]>0,null,{timeout:90000})
  }else await page.waitForFunction(ids=>{
    const rows=[...document.querySelectorAll('.source-page-entry[data-source-material-id]')]
    return ids.every(id=>{const i=rows.findIndex(n=>n.dataset.sourceMaterialId===id);return i>=0&&document.querySelector('image[data-opening-material="'+i+'"]')})
  },ids,{timeout:90000})
  const items=known??await page.evaluate(ids=>{const rows=[...document.querySelectorAll('.source-page-entry[data-source-material-id]')];return ids.map(id=>{
    const i=rows.findIndex(n=>n.dataset.sourceMaterialId===id),r=document.querySelector('image[data-opening-material="'+i+'"]');return {id,ordinal:i,name:rows[i].querySelector('.source-row-name').textContent,x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}
  })},ids)
  report.items=items;report.thumbnails=await epoch()
  report.thumbnailPixels=await page.evaluate(items=>items.map(({ordinal})=>{const src=document.querySelector('image[data-opening-material="'+ordinal+'"]')?.getAttribute('href');if(!src)return null;const raw=atob(src.slice(src.indexOf(',')+1,src.indexOf(',')+33)),n=k=>raw.charCodeAt(k)*16777216+raw.charCodeAt(k+1)*65536+raw.charCodeAt(k+2)*256+raw.charCodeAt(k+3);return [n(16),n(20)]}),items)
  await fs.writeFile(path.join(out,'layout.json'),JSON.stringify(items))
  const b=await page.getByTestId('canvas').boundingBox(),center={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}
  report.viewport=b
  const cam=()=>page.evaluate(()=>window.__ov.frames.findLast(f=>f[1])?.[1])
  const waitFrames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))
  const wheel=(dx,dy,zoom)=>cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...center,deltaX:dx,deltaY:dy,modifiers:zoom?2:0})
  const waitExact=async(timeout=16000)=>{try{await page.waitForFunction(()=>{
    const r=window.__ov.frames.at(-1);if(!r||r[3]!=='visible'||r[4]!=='WebGPU · 清晰'||!r[8]||!r[1])return false
    const c=JSON.parse(r[8]);return Math.abs(c.x-r[1][0])<.01&&Math.abs(c.y-r[1][1])<.01&&Math.abs(c.zoom-r[1][2])<1e-6
  },null,{timeout,polling:'raf'});return true}catch{return false}}
  const record=async(name,run,settle=true)=>{
    const begin=await epoch(),start=await cam();await run();await waitFrames();const up=await epoch()
    const snapshots=process.env.OVERVIEW_GUI==='1'&&process.env.OVERVIEW_SKIP_NEIGHBOURS!=='1'&&name==='zoom-to-neighbours'?(async()=>{
      for(const [delay,label] of [[900,'zoom-900ms'],[1250,'zoom-2200ms']]){
        await page.waitForTimeout(delay);await screen(label,b)
        report[label]=await page.evaluate(()=>window.__ov.frames.at(-1))
      }
    })():undefined
    const regional=process.env.DENSE_REGIONS==='1'&&name==='dense-cold-view'?(async()=>{
      const pose=await cam()
      try{
        const handle=await page.waitForFunction(v=>{
          const c=document.querySelector('.native-source-content'),host=c?.closest('.native-source-surface')
          if(!host||getComputedStyle(host).visibility!=='visible'||c.dataset.cameraReprojected!=='false'||!c.dataset.sourceRegionalBounds)return
          const camera=JSON.parse(c.dataset.projectedCamera||'null')
          if(!camera||Math.abs(camera.x-v[0])>.01||Math.abs(camera.y-v[1])>.01||Math.abs(camera.zoom-v[2])>1e-7)return
          const cv=document.createElement('canvas');cv.width=c.width;cv.height=c.height;cv.getContext('2d').drawImage(c,0,0)
          return {at:performance.timeOrigin+performance.now(),world:JSON.parse(c.dataset.sourceRegionalBounds),keys:JSON.parse(c.dataset.sourceRegionalMaterials),
            view:camera,dpr:devicePixelRatio,width:c.width,height:c.height,png:cv.toDataURL().split(',')[1]}
        },pose,{timeout:30000,polling:'raf'})
        const {png,...receipt}=await handle.jsonValue();await handle.dispose()
        await fs.writeFile(path.join(out,'dense-first-regions.png'),Buffer.from(png,'base64'))
        report.regional=receipt
        await screen('dense-first-window',b)
      }catch{report.regional=null}
    })():undefined
    const restored=process.env.OVERVIEW_CAPTURE_RETURN==='1'&&name==='high-cross-return'?(async()=>{
      try{
        const h=await page.waitForFunction(()=>{const e=document.querySelector('.source-overview-handoff');if(e?.style.visibility!=='visible')return false
          const c=e.querySelector('canvas'),r=c.getBoundingClientRect()
          return {at:performance.timeOrigin+performance.now(),width:c.width,height:c.height,transform:c.style.transform,x:r.x,y:r.y}
        },null,{timeout:2600,polling:'raf'})
        report.returnedBitmap={...await h.jsonValue(),inputEnd:up};await h.dispose()
        await screen('return-held-bitmap',b)
      }catch{report.returnedBitmap=null}
    })():undefined
    const ready=settle?await waitExact(name.startsWith('dense-')||name.startsWith('high-')||name==='far-area'?90000:16000):undefined
    const end=await epoch();if(snapshots)await snapshots;if(regional)await regional;if(restored)await restored
    const endView=await cam()
    const visible=await page.evaluate(({v,b})=>[...document.querySelectorAll('.source-opening-surface image')].filter(im=>{
      const x=Number(im.getAttribute('x'))*v[2]+v[0],y=Number(im.getAttribute('y'))*v[2]+v[1]
      return x<b.width&&y<b.height&&x+Number(im.getAttribute('width'))*v[2]>0&&y+Number(im.getAttribute('height'))*v[2]>0
    }).map(im=>Number(im.dataset.openingMaterial)),{v:endView,b})
    report.segments.push({name,begin,up,end,start,endView,ready,visible})

    await fs.writeFile(path.join(out,'progress.json'),JSON.stringify(report))
  }
  const centerAt=async(x,y,n=5)=>{const [vx,vy,z]=await cam(),dx=vx+x*z-(center.x-b.x),dy=vy+y*z-(center.y-b.y)
    for(let i=0;i<n;i++){await wheel(dx/n,dy/n,false);await page.waitForTimeout(25)}}
  const pinch=async(factor,n)=>{for(let i=0;i<n;i++){await wheel(0,-100*Math.log(factor)/n,true);await page.waitForTimeout(30)}}
  const pan=async(dx,dy,button='middle')=>{const buttons=button==='left'?1:4
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...center,button,buttons,clickCount:1})
    for(let i=1;i<=16;i++){await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:center.x+Math.round(dx*i/16),y:center.y+Math.round(dy*i/16),button,buttons});await page.waitForTimeout(15)}
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:center.x+dx,y:center.y+dy,button,buttons:0})}
  const cluster=items.slice(1,4),l=Math.min(...cluster.map(m=>m.x)),r=Math.max(...cluster.map(m=>m.x+m.w)),t=Math.min(...cluster.map(m=>m.y)),bt=Math.max(...cluster.map(m=>m.y+m.h))
  const initial=await cam();report.initialFit=initial
  if(process.env.OVERVIEW_HOVER==='1'){
    // An unanswered thumbnail must not be mistaken for empty canvas.
    if(process.env.OVERVIEW_ONLY_INNER!=='1')await page.waitForFunction(()=>document.querySelectorAll('image[data-opening-material]').length===306,null,{timeout:120000,polling:'raf'})
    const points=process.env.OVERVIEW_ONLY_INNER==='1'?[]:await page.evaluate(()=>{
      const host=document.querySelector('[data-testid="canvas"]'),b=host.getBoundingClientRect()
      const rows=[...document.querySelectorAll('.source-page-entry[data-source-material-id]')]
      const boxes=[...document.querySelectorAll('image[data-opening-material]')].map(n=>({r:n.getBoundingClientRect(),id:rows[+n.dataset.openingMaterial]?.dataset.sourceMaterialId}))
      const hit=(x,y)=>boxes.findLast(({r})=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)?.id
      const clear=(x,y)=>{const t=document.elementFromPoint(x,y);return t&&host.contains(t)&&!t.closest('button,input,select,textarea,.source-canvas-status,.canvas-controls,.canvas-scrollbars')}
      const points=[]
      for(const {r,id} of boxes){const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2)
        if(x>b.left+8&&x<b.right-8&&y>b.top+8&&y<b.bottom-8&&r.width>6&&r.height>6&&hit(x,y)===id&&clear(x,y)){points.push({x,y,id});if(points.length===2)break}}
      for(let y=Math.ceil(b.top+36);y<b.bottom-45;y+=41){for(let x=Math.ceil(b.left+26);x<b.right-40;x+=47)if(!hit(x,y)&&clear(x,y)){points.push({x,y,id:null});return points}}
      return points
    })
    if(process.env.OVERVIEW_ONLY_INNER!=='1')assert.equal(points.length,3,'two separate materials and blank canvas required')
    report.hover=[]
    for(const point of points){
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0})
      await page.waitForFunction(id=>(document.querySelector('[data-testid="source-hover-outline"]')?.getAttribute('data-material-id')??null)===id,point.id,{timeout:4000,polling:'raf'})
      const receipt=await page.evaluate(()=>{const p=document.querySelector('[data-testid="source-hover-outline"]');return {id:p?.getAttribute('data-material-id'),fill:p?.getAttribute('fill'),path:p?.getAttribute('d'),visible:p&&getComputedStyle(p).display!=='none'}})
      assert.equal(!!receipt.visible,!!point.id);report.hover.push({point,receipt})
      if(point.id)await screen('hover-'+report.hover.length,b)
    }
    if(process.env.OVERVIEW_HOVER_DETAIL==='1'){
      // These source UUIDs and offsets come from page 1, artboard 116 in the unmodified Sketch ZIP.
      const root='918953D3-4C42-461C-8C03-6F6F011359C0',group='CA6F308B-D86A-4671-8428-2D58B63CB8F8',label='2F47F0D2-F75E-42E1-A5F4-886C51530760'
      await record('hover-to-title',async()=>{await centerAt(23347.5,1016);await pinch(1/(await cam())[2],14)})
      assert(report.segments.at(-1).ready,'source title did not present')
      const sample=async(expected,name)=>{
        await page.waitForFunction(id=>document.querySelector('[data-testid="source-hover-outline"]')?.dataset.nodeId===id,expected,{timeout:6000,polling:'raf'})
        const receipt=await page.locator('[data-testid="source-hover-outline"]').evaluate(n=>{
          const b=n.getBoundingClientRect(),canvas=document.querySelector('.native-source-content')
          return {node:n.dataset.nodeId,root:n.dataset.materialId,d:n.getAttribute('d'),remoteSubmission:canvas.dataset.sourcePresentation,rect:{x:b.x,y:b.y,w:b.width,h:b.height}}
        });assert.equal(receipt.root,root);report[name]=receipt
        await fs.writeFile(path.join(out,name+'.png'),await page.screenshot({clip:b}))
      }
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...center,button:'none',buttons:0})
      await sample(group,'hover-group')
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Meta',code:'MetaLeft',modifiers:4,windowsVirtualKeyCode:91})
      await sample(label,'hover-text')
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Meta',code:'MetaLeft',modifiers:0,windowsVirtualKeyCode:91})
      await sample(group,'hover-group-restored')
    }
    if(process.env.OVERVIEW_HOVER_ONLY==='1'){
      assert.equal(await page.evaluate(()=>window.__ov.clicks),0)
      await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
    }
  }
  if(process.env.OVERVIEW_HOVER_ONLY==='1'){
    // The pointer-only check ends without changing the camera.
  }else if(process.env.OVERVIEW_ORACLE_FROM){
    const reference=JSON.parse(await fs.readFile(process.env.OVERVIEW_ORACLE_FROM,'utf8'))
    assert.equal(reference.fileHash,fileHash);assert.equal(reference.viewport.width,b.width);assert.equal(reference.viewport.height,b.height)
    const label=process.env.OVERVIEW_ORACLE_SEGMENT||'high-3200',segment=reference.segments.find(row=>row.name===label)
    assert(segment?.ready && ['high-3200','high-return','high-100','high-pan-return','high-cross-return'].includes(label))
    await record(label,async()=>page.evaluate(v=>{
      const c=document.querySelector('[data-testid="canvas"]');let f=c[Object.keys(c).find(k=>k.startsWith('__reactFiber$'))]
      while(f){const e=f.memoizedProps?.editor;if(e?.state){e.discardPendingView();e.set({view:{x:v[0],y:v[1],zoom:v[2]}});return}f=f.return}
      throw Error('Missing canvas editor for independent camera reference')
    },segment.endView))
    await screen(label,b)
    assert.deepEqual((await cam()),segment.endView)
    report.freshReference=label
  }else{
  if(process.env.OVERVIEW_MIN_PAN==='1'){
    await record('minimum-zoom',()=>pinch(.019/initial[2],8),false)
    assert.equal((await cam())[2],.02)
    for(const button of ['left','middle']){
      const origin=await cam()
      await record('minimum-'+button+'-pan',()=>pan(72,38,button),false)
      const moved=await cam()
      assert(Math.abs(moved[0]-origin[0]-72)<1e-6&&Math.abs(moved[1]-origin[1]-38)<1e-6,button+' pan was blocked')
      await record('minimum-'+button+'-return',()=>pan(-72,-38,button),false)
    }
    await record('restore-fit',async()=>pinch(initial[2]/(await cam())[2],8),false)
    await screen('minimum-pan',b)
  }
  await record('overview-pan',()=>centerAt((l+r)/2,(t+bt)/2),false)
  const scale=Math.min(b.width/(r-l),b.height/(bt-t))*.95
  await record('zoom-to-neighbours',async()=>pinch(scale/(await cam())[2],20),process.env.OVERVIEW_SKIP_NEIGHBOURS!=='1')
  await screen('neighbours',b)
  if(process.env.OVERVIEW_HIGH_ZOOM==='1'){
    let focus=items[0],point={x:focus.x+focus.w*.52,y:focus.y+focus.h*.53}
    if(process.env.OVERVIEW_HIGH_FOCUS){
      const index=Number(process.env.OVERVIEW_HIGH_FOCUS)
      const found=await page.evaluate(async i=>{
        const im=document.querySelector('image[data-opening-material="'+i+'"]')
        if(!im){
          const reply=await window.coreDesktop.largeDocument.openingView({offset:i,cursor:0})
          if(reply.status!=='ok'||!reply.items?.length)throw Error('Missing focus material')
          const b=reply.items[0].placed,focus={ordinal:i,x:b.x,y:b.y,w:b.width,h:b.height}
          return {focus,point:{x:b.x+b.width*.52,y:b.y+b.height*.53}}
        }
        const source=new Image();source.src=im.getAttribute('href');await source.decode()
        const c=document.createElement('canvas');c.width=source.width;c.height=source.height;const ctx=c.getContext('2d');ctx.drawImage(source,0,0)
        const rgba=ctx.getImageData(0,0,c.width,c.height).data
        let x=c.width/2,y=c.height/2,best=Infinity
        for(let py=0;py<c.height;py++)for(let px=0;px<c.width;px++){
          const k=(py*c.width+px)*4,d=(px-c.width/2)**2+(py-c.height/2)**2
          if(rgba[k+3]>200&&rgba[k+2]-rgba[k]>24&&rgba[k+2]>120&&d<best){x=px+.5;y=py+.5;best=d}
        }
        const focus={ordinal:i,x:+im.getAttribute('x'),y:+im.getAttribute('y'),w:+im.getAttribute('width'),h:+im.getAttribute('height')}
        return {focus,point:{x:focus.x+focus.w*x/c.width,y:focus.y+focus.h*y/c.height}}
      },index)
      focus=found.focus;point=found.point
    }
    if(process.env.OVERVIEW_HIGH_POINT_FROM){
      const prior=JSON.parse(await fs.readFile(process.env.OVERVIEW_HIGH_POINT_FROM,'utf8'))
      assert.equal(prior.fileHash,fileHash);assert.equal(prior.highFocus.focus.ordinal,focus.ordinal)
      point=prior.highFocus.point
    }
    report.highFocus={focus,point}
    await record('high-focus',()=>centerAt(point.x,point.y),false)
    await record('high-100',async()=>pinch(1/(await cam())[2],18))
    await screen('high-100',b)
    await record('high-800-moving',()=>pinch(8,14),false)
    await record('high-3200',()=>pinch(4,12))
    await screen('high-3200',b)
    if(process.env.OVERVIEW_HIGH_CROSS){
      const far=await page.evaluate(async index=>{
        const r=await window.coreDesktop.largeDocument.openingView({offset:index,cursor:0})
        const box=r.items[0].placed;return {x:box.x+box.width*.52,y:box.y+box.height*.53}
      },Number(process.env.OVERVIEW_HIGH_CROSS))
      await record('high-cross-return',async()=>{
        await centerAt(far.x,far.y,3)
        if(process.env.OVERVIEW_CROSS_WAIT_READY==='1'){
          await waitFrames();assert(await waitExact(45000),'remote destination did not reach device density')
          report.visitedFar={point:far,view:await cam(),at:await epoch()};await screen('remote-destination',b)
        }else await page.waitForTimeout(160)
        await centerAt(point.x,point.y,3)
      })
      await screen('high-cross-return',b)
      if(process.env.OVERVIEW_HIGH_HOLD_MS){
        await page.waitForTimeout(Number(process.env.OVERVIEW_HIGH_HOLD_MS));await screen('high-cross-held',b)
      }
    }
    await record('high-pan',()=>pan(64,32))
    await record('high-pan-return',()=>pan(-64,-32))
    await screen('high-pan-return',b)
    await record('high-down-moving',()=>pinch(1/32,16),false)
    await record('high-up-moving',()=>pinch(32,16),false)
    await record('high-return',()=>pinch(1/32,16))
    await screen('high-return',b)
    await record('high-second-up',()=>pinch(32,18))
    await record('high-second-return',()=>pinch(1/32,18))
    await screen('high-second-return',b)
  }else{
  await record('short-pan',()=>pan(75,24))
  await record('return',()=>pan(-75,-24))
  await record('zoom-in',()=>pinch(1.85,12))
  await record('across',()=>pan(-300,-90))
  await record('reverse-zoom-out',()=>pinch(1/2.7,14))
  await record('zoom-back',()=>pinch(2.7/1.85,12))
  await record('cross-return',()=>pan(162,49))
  await screen('return',b)
  }
  if(process.env.OVERVIEW_SWEEP==='1'){
    const z=initial[2],worldX=(center.x-b.x-initial[0])/z,worldY=(center.y-b.y-initial[1])/z
    await record('whole-file',async()=>{await pinch(z/(await cam())[2],16);await waitFrames();await centerAt(worldX,worldY)},false)
    if(process.env.OVERVIEW_ALL==='1'){
      await page.waitForFunction(()=>document.querySelector('.source-opening-surface')?.dataset.renderedMaterials==='306'&&
          new Set(window.__ov.thumbnailReceipts.map(x=>x[1])).size===306,null,{timeout:150000,polling:'raf'})
      report.all306At=await epoch()
      report.all306Visible=await page.evaluate(()=>{
        const canvas=document.querySelector('[data-testid="canvas"]').getBoundingClientRect()
        return [...document.querySelectorAll('.source-opening-surface image')].filter(image=>{
          const b=image.getBoundingClientRect();return b.left<canvas.right&&b.top<canvas.bottom&&b.right>canvas.left&&b.bottom>canvas.top
        }).length
      })
      assert.equal(report.all306Visible,306,'the fit camera does not contain the whole catalogue')
      await screen('whole-file',b)
    }
    await page.waitForFunction(first=>{
      const page=document.querySelector('image[data-opening-material="'+first+'"]')?.dataset.openingPage
      return page&&[...document.querySelectorAll('image[data-opening-material]')].filter(im=>
        im.dataset.openingPage!==page&&+im.getAttribute('width')>=250&&+im.getAttribute('height')>=150).length>=3
    },items[0].ordinal,{timeout:150000})
    const world=await page.evaluate(()=>[...document.querySelectorAll('image[data-opening-material]')].map(im=>({
      i:+im.dataset.openingMaterial,p:im.dataset.openingPage,x:+im.getAttribute('x'),y:+im.getAttribute('y'),w:+im.getAttribute('width'),h:+im.getAttribute('height')
    })))
    const firstPage=world.find(i=>i.i===items[0].ordinal)?.p,others=world.filter(i=>i.p!==firstPage&&i.w>=250&&i.h>=150)
    assert(others.length>=3)
    const pivot=others[Math.floor(others.length/2)],group=others.filter(i=>i.p===pivot.p)
      .sort((a,b)=>Math.hypot(a.x-pivot.x,a.y-pivot.y)-Math.hypot(b.x-pivot.x,b.y-pivot.y)).slice(0,3)
    const x=Math.min(...group.map(i=>i.x)),y=Math.min(...group.map(i=>i.y)),r=Math.max(...group.map(i=>i.x+i.w)),d=Math.max(...group.map(i=>i.y+i.h))
    if(process.env.OVERVIEW_DENSE==='1'){
      const target={x:30.635252184381557,y:-1212.8690463838036,zoom:.09855276255057685}
      await record('dense-cold-view',async()=>{await centerAt((center.x-b.x-target.x)/target.zoom,(center.y-b.y-target.y)/target.zoom)
        await waitFrames();await pinch(target.zoom/(await cam())[2],18)})
      await screen('dense-settled',b)
      if(process.env.DENSE_REVERSAL==='1'){
        await record('dense-pan',()=>pan(64,32))
        if(process.env.DENSE_RETARGET==='1')await screen('dense-shifted',b)
        await record('dense-pan-back',()=>pan(-64,-32))
        await screen('dense-return',b)
        await record('dense-more-detail',()=>pinch(1.4,8))
        await record('dense-zoom-back',()=>pinch(1/1.4,8))
        if(process.env.DENSE_RETARGET==='1'){
          // Change direction before any intermediate target can settle.
          await record('dense-inflight-return',async()=>{
            await pinch(1.7,6);await pan(-280,95);await pinch(1.18,4)
            await pinch(1/1.18,4);await pan(280,-95);await pinch(1/1.7,6)
          })
          await screen('dense-retarget',b)
          if(report.all306Visible===306){
            const used=new Set(report.segments.filter(s=>!['whole-file','overview-pan'].includes(s.name)).flatMap(s=>s.visible))
            const boards=await page.evaluate(()=>Array.from(document.querySelectorAll('image[data-opening-material]'),im=>({
              i:+im.dataset.openingMaterial,x:+im.getAttribute('x'),y:+im.getAttribute('y'),w:+im.getAttribute('width'),h:+im.getAttribute('height')
            })))
            const unseen=boards.filter(m=>!used.has(m.i)&&m.w>=600&&m.h>=400)
            const far=unseen.sort((a,b)=>b.y-a.y||b.x-a.x)[0]
            assert(far,'no unvisited large artboard for the cross-file zoom')
            report.farMaterial=far
            await record('far-area',async()=>{
              await pinch(initial[2]/(await cam())[2],10);await centerAt(far.x+far.w/2,far.y+far.h/2)
              await pinch(Math.min(b.width/far.w,b.height/far.h)*.72/(await cam())[2],14)
            })
            assert(report.segments.at(-1).visible.includes(far.i))
            await screen('far-area',b)
          }
        }
      }
    }else await record('other-artboards',async()=>{await centerAt((x+r)/2,(y+d)/2);await waitFrames();await pinch(Math.min(b.width/(r-x),b.height/(d-y))*.9/(await cam())[2],18)})
    report.otherOrdinals=group.map(i=>i.i)
  }
  }
  const raw=await page.evaluate(()=>{const r=window.__ov;r.live=false;return r})
  report.materialClicks=raw.clicks
  assert.equal(raw.clicks,0)
  if(!report.freshReference&&process.env.OVERVIEW_HOVER_ONLY!=='1')assert(raw.frames.some(f=>f[9]>1),'no multi-material scene was exercised')
  await fs.writeFile(path.join(out,'frames.json'),JSON.stringify({frames:raw.frames,inputs:raw.inputs,thumbnailReceipts:raw.thumbnailReceipts}))
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
  if(process.env.OVERVIEW_SAVE_THUMBS==='1')await fs.cp(thumbsDir,path.join(out,'thumbs'),{recursive:true}).catch(()=>{})
  await cdp.detach()
}catch(error){
  const state=await page.evaluate(()=>({text:document.body.innerText.slice(0,7000),
    materials:document.querySelectorAll('.source-page-entry[data-source-material-id]').length,
    hover:document.querySelector('[data-testid="source-hover-outline"]')?.outerHTML,native:document.querySelector('.native-source-content')?.outerHTML?.slice(0,3500),
    images:document.querySelectorAll('image[data-opening-material]').length,
    frames:window.__ov?.frames.slice(-3)})).catch(()=>undefined)
  await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({message:String(error),state},null,2))
  await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})
  throw error
}finally{
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})
  await new Promise(done=>log.end(done));await fs.rm(scratch,{recursive:true,force:true})
}
