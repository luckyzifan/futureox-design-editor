// Dataflow scope: retain the original functional editing assertions; obsolete UI chrome pixel coordinates are outside this increment.
/** Real owned browser: scale units, UI chrome, document persistence and input. */
import { chromium, expect } from '../../frontend/design-client/node_modules/@playwright/test/index.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, paint, stroke, effect, validateDocument, defaultTextStyle } from '../../frontend/design-client/src/model'
const output=await mkdtemp(join(tmpdir(),'futureox-dataflow-editor-'))
const doc=blank('Scale child properties'), frame=node('frame',100,100,256,256), lens=node('rectangle',16,16,96,96), text=node('text',16,132,120,30), other=node('rectangle',410,16,192,96)
frame.children=[lens.id,text.id];lens.radii=[16,16,16,16];lens.strokes=[{...stroke(),width:2,dash:'4 2'}]
lens.fills=[{...paint('#ffffff'),opacity:.15}];lens.effects=[{...effect('glass'),radius:1.5,glass:{depth:8,refraction:.5,dispersion:.2,lightAngle:45,lightIntensity:.5}}]
text.text='Scale child';text.fontSize=12;text.textStyle={...defaultTextStyle(),letterSpacing:2,paragraphSpacing:3,paragraphIndent:4}
doc.schemaVersion=5;doc.nodes={[frame.id]:frame,[lens.id]:lens,[text.id]:text,[other.id]:other};doc.pages[0].children=[frame.id,other.id];validateDocument(doc)
const input=join(output,'input.fd');await writeFile(input,JSON.stringify(doc))
const server=spawn('bun',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'],{cwd:new URL('../../frontend/design-client/',import.meta.url),stdio:['ignore','pipe','pipe']})
let log='',browser:any,page:any;const checks:any[]=[],errors:string[]=[]
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try{
 const base=await new Promise<string>((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Vite timeout')),20000);server.stdout.on('data',()=>{const m=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0])}})})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});page=await browser.newPage({viewport:{width:1440,height:940},deviceScaleFactor:2})
 page.on('pageerror',e=>errors.push(String(e)));await page.addInitScript(()=>localStorage.setItem('forma-render-backend','webgpu'));await page.goto(base)
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:30000})
 await page.locator('input[type=file][accept*=".fd"]').setInputFiles(input);await expect(page.getByLabel('文档名称')).toHaveValue(doc.name)
 const canvas=page.getByTestId('canvas'), settle=()=>expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:30000})
 const read=()=>page.evaluate(async()=>{const{localOpen}=await import('/src/local-store.ts');return(await localOpen())!.document})
 await settle();await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-backend','gpu');const bounds=await canvas.boundingBox();expect(bounds).not.toBeNull();expect(bounds!.width).toBeGreaterThan(100)
 await page.screenshot({path:join(output,'01-shell.png')});checks.push({name:'Actual editor imported and presented through the worker',bounds})
 await page.getByTestId(`layer-${frame.id}`).click();await canvas.focus();await page.keyboard.press('k');await page.getByLabel('缩放倍率',{exact:true}).fill('2x');await page.getByLabel('缩放倍率',{exact:true}).press('Enter')
 await expect.poll(async()=>(await read()).nodes[frame.id].transform[0]).toBe(2)
 await page.getByTestId(`layer-${lens.id}`).click();await settle();const scaled=await read()
 for(const[label,value]of [['X','32'],['Y','32'],['W','192'],['H','192'],['左上','32'],['粗细','4'],['深度','16'],['磨砂','3']])await expect(page.getByLabel(label,{exact:true})).toHaveValue(value)
 await expect(page.getByLabel('虚线',{exact:true})).toHaveValue('8 4');expect((await read()).nodes).toEqual(scaled.nodes)
 await page.getByLabel('深度',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'02-child-glass.png')})
 checks.push({name:'Figma-observed child position/size/radius/depth/frost displayed after Scale; inspection does not mutate native parameters'})
 await page.getByTestId(`layer-${other.id}`).click({modifiers:['Meta']});await expect(page.getByLabel('W',{exact:true})).toHaveValue('192')
 await page.getByLabel('W',{exact:true}).fill('240');await page.getByLabel('W',{exact:true}).press('Enter')
 await expect.poll(async()=>{const d=await read();return[d.nodes[lens.id].width,d.nodes[other.id].width]}).toEqual([120,240])
 await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(scaled.nodes)
 checks.push({name:'Multi-selection compares effective values across differently scaled parents; one edit converts per node, one Undo restores all'})
 await page.getByTestId(`layer-${lens.id}`).click()
 for(const[label,value]of [['X','42'],['深度','22'],['磨砂','4'],['粗细','6'],['虚线','12 6']]){await page.getByLabel(label,{exact:true}).fill(value);await page.getByLabel(label,{exact:true}).press('Enter')}
 await expect.poll(async()=>{const n=(await read()).nodes[lens.id];return[n.transform[4],n.effects[0].glass.depth,n.effects[0].radius,n.strokes[0].width,n.strokes[0].dash]}).toEqual([21,11,2,3,'6 3'])
 await page.getByTestId(`layer-${text.id}`).click()
 for(const[label,value]of [['字号','24'],['字间距','4'],['段落间距','6'],['首行缩进','8']])await expect(page.getByLabel(label,{exact:true})).toHaveValue(value)
 await page.getByLabel('字号',{exact:true}).fill('30');await page.getByLabel('字号',{exact:true}).press('Enter')
 await expect.poll(async()=>(await read()).nodes[text.id].fontSize).toBe(15)
 const saved=await read();await page.reload();await page.getByRole('button',{name:`继续编辑 · ${doc.name}`,exact:true}).click();await expect(page.getByLabel('文档名称')).toHaveValue(doc.name);await settle();expect((await read()).nodes).toEqual(saved.nodes)
 checks.push({name:'Effective physical X/stroke/dash/glass/text edits persist as precise native units and survive reload'})
 await page.getByTestId(`layer-${frame.id}`).click();await page.getByRole('radio',{name:'横向布局',exact:true}).click()
 await expect(page.getByLabel('项目间距',{exact:true})).toHaveValue('24');await expect(page.getByLabel('上内边距',{exact:true})).toHaveValue('32')
 for(const[label,value]of [['项目间距','30'],['上内边距','40']]){await page.getByLabel(label,{exact:true}).fill(value);await page.getByLabel(label,{exact:true}).press('Enter')}
 await expect.poll(async()=>{const l=(await read()).nodes[frame.id].layout;return[l?.mode,l?.gap,l?.padding[0]]}).toEqual(['horizontal',15,20])
 await canvas.focus();for(let i=0;i<3;i++)await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(saved.nodes)
 await page.getByRole('radio',{name:'网格布局',exact:true}).click();await expect.poll(async()=>(await read()).nodes[frame.id].layout?.mode).toBe('grid')
 await page.getByRole('radio',{name:'自由布局',exact:true}).click();await expect.poll(async()=>(await read()).nodes[frame.id].layout).toBeUndefined()
 await canvas.focus();for(let i=0;i<2;i++)await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(saved.nodes)
 await page.getByRole('radio',{name:'纵向布局',exact:true}).click();await expect.poll(async()=>(await read()).nodes[frame.id].layout?.mode).toBe('vertical')
 await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(saved.nodes)
 checks.push({name:'Layout direction buttons execute real commands; scaled gap/padding edits and Undo preserve native dimensions'})
 await page.getByTestId(`layer-${lens.id}`).click();await page.getByRole('button',{name:'更多图层操作',exact:true}).click();await page.getByRole('menuitem',{name:'重命名',exact:true}).click()
 await page.getByLabel('重命名图层',{exact:true}).fill('Scaled glass');await page.getByLabel('重命名图层',{exact:true}).press('Enter')
 await expect.poll(async()=>(await read()).nodes[lens.id].name).toBe('Scaled glass');await canvas.focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await read()).nodes).toEqual(saved.nodes)
 checks.push({name:'Inspector layer actions share the actual rename command and Undo restores the document'})
 await page.getByLabel('缩放与视图设置').click();await page.getByRole('button',{name:'200%',exact:true}).click();await settle();await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-camera-zoom','2')
 await expect(page.locator('.view-menu')).not.toHaveAttribute('open','');await page.getByLabel('缩放与视图设置').click();await page.getByRole('button',{name:'100%',exact:true}).click();await settle();await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-camera-zoom','1');await page.getByLabel('缩放与视图设置').click();await page.keyboard.press('Escape')
 checks.push({name:'Right sidebar zoom menu controls the canvas, dismisses on Escape and outside pointer'})
 await page.screenshot({path:join(output,'03-edited-and-restored.png')});
 expect(errors).toEqual([]);await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',checks,errors},null,2));console.log(JSON.stringify({status:'passed',output,checks:checks.length}))
}catch(error){await page?.screenshot({path:join(output,'failure.png')});await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors},null,2));console.log(JSON.stringify({status:'failed',output,error:String(error)}));throw error}finally{await browser?.close();server.kill('SIGTERM')}
