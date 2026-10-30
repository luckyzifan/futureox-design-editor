/** Owned browser input and actual WebGPU; no user browser/profile attached. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, uid } from '../src/model'
const output = await mkdtemp(join(tmpdir(), 'forma-scale-tools-'))
const server = spawn('bun', ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'], {cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']})
let log='', browser:any, page:any; const checks:any[]=[]
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try {
 const base=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite timeout')),20000);server.stdout.on('data',()=>{const m=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0])}})})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]})
 page=await browser.newPage({viewport:{width:1440,height:940},deviceScaleFactor:2})
 if(!process.env.DESIGN_SCALE_MATERIALS_ONLY){
 await page.goto(base);await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:30000})
 const d=blank('Scale real input'),n=node('rectangle',100,100,100,80);d.nodes[n.id]=n;d.pages[0].children=[n.id];const secondPage=uid();d.pages.push({id:secondPage,name:'移动目标',background:'#ffffff',children:[]})
 const fixture=join(output,'input.fd');await writeFile(fixture,JSON.stringify(d));await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
 const read=()=>page.evaluate(async()=>{const {localOpen}=await import('/src/local-store.ts');return (await localOpen())!.document})
 await expect(page.getByLabel('文档名称')).toHaveValue(d.name);await page.getByTestId(`layer-${n.id}`).click()
 const before=await read(), canvas=page.getByTestId('canvas'), settle=()=>expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:30000})
 await settle();await canvas.focus();await page.keyboard.press('k')
 await expect(canvas).toHaveClass(/canvas-scale/);await expect(page.getByLabel('缩放倍率',{exact:true})).toBeFocused()
 await expect(page.getByLabel('缩放倍率',{exact:true})).toHaveValue('1x')
 await page.getByLabel('缩放倍率',{exact:true}).fill('2x');await page.getByLabel('缩放倍率',{exact:true}).press('Enter')
 await expect(canvas).toHaveClass(/canvas-select/);await expect(canvas).toBeFocused()
 await expect.poll(async()=>(await read()).nodes[n.id].transform).toEqual([2,0,0,2,50,60])
 await expect(page.getByLabel('W',{exact:true})).toHaveValue('200');await expect(page.getByLabel('H',{exact:true})).toHaveValue('160')
 await page.screenshot({path:join(output,'01-scale-center.png')});checks.push({name:'K focuses factor; 2x commits centered similarity, displayed W/H match, returns to Move'})
 await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(before.nodes)
 await page.getByRole('button',{name:'移动工具',exact:true}).click();await page.getByRole('menuitemradio',{name:'缩放',exact:true}).click()
 await page.getByRole('radio',{name:'左上',exact:true}).click();await page.getByLabel('缩放宽度',{exact:true}).fill('150');await page.getByLabel('缩放宽度',{exact:true}).press('Enter')
 await expect.poll(async()=>(await read()).nodes[n.id].transform).toEqual([1.5,0,0,1.5,100,100])
 await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(before.nodes)
 checks.push({name:'Move submenu Scale, top-left anchor width scales both axes and one Undo restores document'})
 await page.keyboard.press('k');await page.getByLabel('缩放倍率',{exact:true}).fill('0');await page.getByLabel('缩放倍率',{exact:true}).press('Enter')
 await expect(canvas).toHaveClass(/canvas-scale/);expect((await read()).nodes).toEqual(before.nodes)
 await page.keyboard.press('Escape');await expect(canvas).toHaveClass(/canvas-select/)
 checks.push({name:'Invalid zero factor stays editable without mutating document; Escape exits'})
 await page.keyboard.press('k');await settle()
 const handle=page.getByTestId('resize-2'), box=await handle.boundingBox();if(!box)throw Error('missing scale handle')
 const x=box.x+box.width/2,y=box.y+box.height/2
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+45,y+36,{steps:8});await page.mouse.up();await settle()
 await expect.poll(async()=>(await read()).nodes[n.id].transform[0]).toBeGreaterThan(1)
 const dragged=(await read()).nodes[n.id];expect(dragged.transform[0]).toBe(dragged.transform[3]);expect(dragged.width).toBe(100);expect(dragged.height).toBe(80)
 await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(before.nodes)
 checks.push({name:'Scale corner drag keeps uniform native transform and exact Undo',transform:dragged.transform})
 await canvas.focus();await page.keyboard.press('k');await expect(canvas).toHaveClass(/canvas-scale/);await settle();const altBox=await page.getByTestId('resize-2').boundingBox();if(!altBox)throw Error('missing center scale handle')
 const ax=altBox.x+altBox.width/2,ay=altBox.y+altBox.height/2
 await page.keyboard.down('Alt');await page.mouse.move(ax,ay);await page.mouse.down();await page.mouse.move(ax+30,ay+24,{steps:6});await page.mouse.up();await page.keyboard.up('Alt');await settle()
 await expect.poll(async()=>(await read()).nodes[n.id].transform[0]).toBeGreaterThan(1)
 const centered=(await read()).nodes[n.id],m=centered.transform
 expect(m[4]+centered.width*m[0]/2).toBeCloseTo(150,9);expect(m[5]+centered.height*m[3]/2).toBeCloseTo(140,9)
 await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(before.nodes)
 checks.push({name:'Option Scale drag keeps original center fixed and one Undo restores the exact graph'})

 await canvas.focus();await page.keyboard.press('v')
 const layer=page.getByTestId(`layer-${n.id}`)
 await layer.click({button:'right'});await page.getByRole('menuitem',{name:'创建选区画板',exact:true}).click()
 await expect.poll(async()=>Object.keys((await read()).nodes).length).toBe(2)
 const framed=await read(),frameId=framed.pages[0].children[0];expect(framed.nodes[frameId].kind).toBe('frame')
 await page.getByTestId(`layer-${frameId}`).click({button:'right'});await page.getByRole('menuitem',{name:'转换为分区',exact:true}).click()
 await expect.poll(async()=>(await read()).nodes[frameId].kind).toBe('section');await page.keyboard.press('Meta+z');await settle()
 await page.getByTestId(`layer-${frameId}`).click({button:'right'});await page.getByRole('menuitem',{name:'解除编组',exact:true}).click()
 await expect.poll(async()=>Object.keys((await read()).nodes).length).toBe(1)
 checks.push({name:'Layer right click uses shared context commands; frame selection, convert section, Undo and unframe are real mutations'})
 await canvas.focus();await page.keyboard.press('Meta+r');await expect(page.getByLabel('重命名图层',{exact:true})).toBeFocused()
 await page.getByLabel('重命名图层',{exact:true}).fill('右键与快捷键');await page.getByLabel('重命名图层',{exact:true}).press('Enter')
 await expect.poll(async()=>(await read()).nodes[n.id].name).toBe('右键与快捷键')
 await layer.click({button:'right'});await page.getByRole('menuitem',{name:'移动到页面',exact:true}).click();await page.getByRole('menuitem',{name:'移动目标',exact:true}).click()
 await expect.poll(async()=>(await read()).pages.find((p:any)=>p.id===secondPage).children).toEqual([n.id])
 await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).pages[0].children).toEqual([n.id])
 checks.push({name:'Cmd+R edits layer name; right-click page picker moves layer and Undo restores its source page'})
 await page.getByTestId(`layer-${n.id}`).click();await canvas.focus();await page.keyboard.press('Meta+d')
 await expect.poll(async()=>Object.keys((await read()).nodes).length).toBe(2)
 await page.keyboard.press('Meta+a');await page.keyboard.press('Control+Meta+m')
 await expect.poll(async()=>Object.keys((await read()).nodes).length).toBe(3)
 const masked=await read(),maskRoot=masked.nodes[masked.pages[0].children[0]];expect(masked.nodes[maskRoot.children[0]].mask).toBe(true)
 await page.keyboard.press('Meta+z');await expect.poll(async()=>Object.keys((await read()).nodes).length).toBe(2)
 checks.push({name:'macOS Control+Command+M executes the same mask command and one Undo restores the two selected layers'})

 }
 const gpu=await browser.newPage();await gpu.goto(base+'/gpu-check.html')
 const materials=await gpu.evaluate(async()=>{
  const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
  const info={vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter}
  const {KernelClient}=await import('/src/kernel/client.ts'),{initializePicking}=await import('/src/kernel/picking.ts');await initializePicking()
  const {blank,node,paint,stroke,effect}=await import('/src/model.ts'),{Editor}=await import('/src/engine.ts'),{defaultColorSettings}=await import('/src/color.ts')
  const rows=[]
  for(const backend of ['webgpu','webgl2'] as const) for(const managed of [false,true]){
   const doc=blank(),f=node('frame',0,0,96,96),bg=node('rectangle',0,0,96,96),glass=node('rectangle',14,14,56,52),text=node('text',8,68,80,22)
   f.fills=[];f.clip=false;f.children=[bg.id,glass.id,text.id];bg.fills=[{...paint('#ff0000'),kind:'linear',stops:[{offset:0,color:managed?'color(rec2100-linear 3 1 0)':'#ff0000'},{offset:1,color:'#0044ff'}]}]
   glass.radii=[8,8,8,8];glass.fills=[{...paint('#ffffff'),opacity:.1}];glass.strokes=[{...stroke(),width:1.5}];glass.effects=[{...effect('glass'),radius:2,glass:{depth:5,refraction:.4,dispersion:.2,lightAngle:30,lightIntensity:.4}}, {...effect('texture'),texture:{noiseSize:[2,3],clipToShape:true},opacity:.2}];text.text='Scale';text.fontSize=12
   doc.nodes={[f.id]:f,[bg.id]:bg,[glass.id]:glass,[text.id]:text};doc.pages[0].children=[f.id];doc.rasterProfile='figma';doc.schemaVersion=5;if(managed)doc.colorManagement=defaultColorSettings()
   const editor=new Editor(doc);editor.select([f.id]);const original=editor.state.doc;if(!editor.scaleSelection(2,0))throw Error('scale failed: '+editor.state.message)
   const client=new KernelClient()
   try {
    const options={pageId:doc.pages[0].id,width:192,height:192,transparent:true,grid:false,rasterProfile:'figma' as const,view:{x:0,y:0,zoom:2}}
    const a=await client.render(original,options,false,backend,true),b=await client.render(editor.state.doc,{...options,view:{x:0,y:0,zoom:1}},false,backend,true)
    if(a.backend!==backend||b.backend!==backend)throw Error('unexpected backend fallback')
    let byteDifferences=0,floatDifferences=0;for(let i=0;i<a.bytes.length;i++)if(a.bytes[i]!==b.bytes[i])byteDifferences++
    if(managed){if(!a.linear||!b.linear)throw Error('HDR float buffer missing');const x=new Uint32Array(a.linear.buffer,a.linear.byteOffset,a.linear.length),y=new Uint32Array(b.linear.buffer,b.linear.byteOffset,b.linear.length);for(let i=0;i<x.length;i++)if(x[i]!==y[i])floatDifferences++}
    if(byteDifferences||floatDifferences)throw Error(JSON.stringify({managed,byteDifferences,floatDifferences}))
    const cpu=await client.render(editor.state.doc,{...options,view:{x:0,y:0,zoom:1}},false,'cpu',true)
    let cpuByteDifferences=0,cpuFloatDifferences=0;const samples:any[]=[];for(let i=0;i<b.bytes.length;i++)if(b.bytes[i]!==cpu.bytes[i])cpuByteDifferences++
    if(managed){if(!cpu.linear||!b.linear)throw Error('CPU HDR reference missing');const x=new Uint32Array(b.linear.buffer,b.linear.byteOffset,b.linear.length),y=new Uint32Array(cpu.linear.buffer,cpu.linear.byteOffset,cpu.linear.length);for(let i=0;i<x.length;i++)if(x[i]!==y[i]){cpuFloatDifferences++;if(samples.length<20)samples.push({i,x:(i/4|0)%192,y:Math.floor(i/768),channel:i%4,gpu:b.linear[i],cpu:cpu.linear[i],gpuBits:x[i],cpuBits:y[i]})}}
    if(cpuByteDifferences||cpuFloatDifferences)throw Error(JSON.stringify({managed,cpuByteDifferences,cpuFloatDifferences,samples}))
    rows.push({managed,backend:b.backend,byteDifferences,floatDifferences,cpuByteDifferences,cpuFloatDifferences,scope:'Scale vs equivalent view transform, glass, texture, stroke and text; not external Figma pixel parity'})
   }finally{client.dispose();editor.dispose()}
  }
  return {adapter:info,rows}
 })
 checks.push({name:'Actual hardware WebGPU SDR bytes and HDR float bits match equivalent camera transform',...materials})
 await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',checks},null,2));console.log(JSON.stringify({status:'passed',output,checks},null,2))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),checks},null,2));await page?.screenshot({path:join(output,'failure.png')});console.log(JSON.stringify({status:'failed',output,error:String(error)}));throw error}finally{await browser?.close();server.kill('SIGTERM')}
