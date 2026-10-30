/** Own browser, frozen source, real input; React profiling is not FPS. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node } from '../src/model'
const root = new URL('..', import.meta.url).pathname
const sourceRoot = process.env.DESIGN_NAVIGATION_SOURCE || root
const workspace = await mkdtemp(join(tmpdir(), 'forma-navigation-'))
// Preserve the repository-relative shader imports in the frozen source tree.
const output = join(workspace, 'frontend/design-client')
await mkdir(output, { recursive: true })
await cp(new URL('../../../design-studio/crates/design-kernel/shaders', import.meta.url), join(workspace, 'design-studio/crates/design-kernel/shaders'), { recursive: true })
for (const name of ['src','public','index.html','vite.config.ts','package.json','tsconfig.json']) await cp(join(sourceRoot,name),join(output,name),{recursive:true})
await symlink(join(root,'node_modules'),join(output,'node_modules'))
const hashes:Record<string,string>={}
for(const name of ['App.tsx','Canvas.tsx','engine.ts','Layers.tsx','Inspector.tsx','canvas-camera.ts','styles.css']) hashes[name]=createHash('sha256').update(await readFile(join(output,'src',name))).digest('hex')
await writeFile(join(output,'source-hashes.json'),JSON.stringify(hashes,null,2))
let source=await readFile(join(output,'src/App.tsx'),'utf8')
if(!source.includes('__navigationAppRenders')) source=source.replace('export default function App() {','export default function App() {\n;(window as any).__navigationAppRenders = ((window as any).__navigationAppRenders || 0)+1;')
await writeFile(join(output,'src/App.tsx'),source)
await writeFile(join(output,'src/main.tsx'),`import {createRoot} from 'react-dom/client'; import {Profiler} from 'react'; import App from './App'; import './styles.css';
createRoot(document.getElementById('root')!).render(<Profiler id="editor" onRender={(_,phase,actual)=>{const p=(window as any).__navigationProfile;if(p)p.push({phase,actual})}}><App/></Profiler>);`)
const server=spawn('bun',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'],{cwd:output,stdio:['ignore','pipe','pipe']})
let log='',browser:any,page:any;const checks:any[]=[]
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try {
 const base=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout')),20000);server.stdout.on('data',()=>{const m=log.match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0])}})})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});page=await browser.newPage({viewport:{width:1440,height:940}})
 await page.goto(base)
 await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:30000})
 const doc=blank('Canvas navigation profile');for(let i=0;i<300;i++){const n=node(i%2?'ellipse':'rectangle',(i%20)*36,Math.floor(i/20)*36,26,26);doc.nodes[n.id]=n;doc.pages[0].children.push(n.id)}
 await writeFile(join(output,'fixture.fd'),JSON.stringify(doc));await page.locator('input[type=file][accept*=".fd"]').setInputFiles(join(output,'fixture.fd'))
 await expect(page.getByLabel('文档名称')).toHaveValue(doc.name)
 const canvas=page.getByTestId('canvas'),surface=page.locator('.kernel-presentation')
 const settle=()=>expect(surface).toHaveAttribute('data-presentation-ready','true',{timeout:30000})
 await settle();await expect(page.locator('.save-status')).toHaveText('已保存到本机',{timeout:30000});await canvas.focus()
 const camera=()=>surface.evaluate((e:HTMLElement)=>({x:Number(e.dataset.cameraX),y:Number(e.dataset.cameraY),zoom:Number(e.dataset.cameraZoom)}))
 const box=await canvas.boundingBox(),x=Math.round(box.x+box.width*.65),y=Math.round(box.y+box.height*.75)
 await page.mouse.move(x,y);await page.keyboard.down('Space');await page.mouse.down()
 await page.evaluate(()=>{
   (window as any).__navigationAppRenders=0;(window as any).__navigationProfile=[]
   const probe={active:true,cameras:[] as string[],mismatch:0};(window as any).__navigationPaints=probe
   const surface=document.querySelector('.kernel-presentation')!
   const observer=new MutationObserver(()=>{if(!probe.active)return;const view=[surface.getAttribute('data-camera-x'),surface.getAttribute('data-camera-y'),surface.getAttribute('data-camera-zoom')].join('/');if(probe.cameras.at(-1)!==view)probe.cameras.push(view)})
   observer.observe(surface,{attributes:true,attributeFilter:['data-camera-x','data-camera-y','data-camera-zoom']});(window as any).__navigationObserver=observer
  })
 const start=await camera(),begun=Date.now()
 await page.mouse.move(x+180,y-80,{steps:30});
 const motion=await page.evaluate(()=>{const probe=(window as any).__navigationPaints;probe.active=false;(window as any).__navigationObserver.disconnect();return {appRenders:(window as any).__navigationAppRenders,completedCameras:probe.cameras}})
 await page.mouse.up();await page.keyboard.up('Space');await settle()
 const end=await camera(),metrics=await page.evaluate(()=>({appRenders:(window as any).__navigationAppRenders,commits:(window as any).__navigationProfile}))
 expect(end.x-start.x).toBeCloseTo(180,5);expect(end.y-start.y).toBeCloseTo(-80,5)
 const values=metrics.commits.map((v:any)=>v.actual).sort((a:number,b:number)=>a-b)
 checks.push({name:'300-node space drag reaches exact release camera',elapsedMs:Date.now()-begun,appRenders:metrics.appRenders,motion,reactCommits:values.length,reactTotalMs:values.reduce((a:number,b:number)=>a+b,0),reactP95Ms:values[Math.floor(values.length*.95)],start,end})
 if(!process.env.DESIGN_NAVIGATION_BASELINE){
  expect(motion.appRenders).toBe(0);expect(motion.completedCameras.length).toBeGreaterThan(1)
  await page.mouse.move(x,y);const before=await camera();await page.keyboard.down('Shift');await page.mouse.wheel(0,80);await page.keyboard.up('Shift');await settle();const after=await camera()
  expect(after.x-before.x).toBeCloseTo(-80,5);expect(after.y).toBeCloseTo(before.y,5);checks.push({name:'Shift wheel pans horizontally',before,after})
  await page.keyboard.down('Space');await expect(canvas).toHaveCSS('cursor','grab');await page.mouse.down();await expect(canvas).toHaveCSS('cursor','grabbing');await page.mouse.move(x+40,y+20,{steps:3});await page.mouse.up();await expect(canvas).toHaveCSS('cursor','grab');await page.keyboard.up('Space');await expect(canvas).not.toHaveCSS('cursor','grab');await settle();checks.push({name:'Space cursor is immediate and capture/release restores it'})
  await page.mouse.move(x,y);const v=await camera(),anchor={x:x-box.x,y:y-box.y};await page.keyboard.down('Meta');await page.mouse.wheel(0,-25);await page.keyboard.up('Meta');await settle();const z=await camera();expect((anchor.x-v.x)/v.zoom).toBeCloseTo((anchor.x-z.x)/z.zoom,6);expect((anchor.y-v.y)/v.zoom).toBeCloseTo((anchor.y-z.y)/z.zoom,6);checks.push({name:'Modified wheel zoom preserves world point under cursor',before:v,after:z})
  await page.keyboard.press('h');await expect(canvas).toHaveClass(/canvas-hand/);await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+90,y+30,{steps:4});await page.mouse.wheel(0,40);await page.mouse.move(x+100,y+40);await page.mouse.up();await settle();const combined=await camera();expect(combined.x-z.x).toBeCloseTo(100,5);expect(combined.y-z.y).toBeCloseTo(0,5);checks.push({name:'Wheel during hand drag does not jump back to the old origin'})
  await page.keyboard.press('v');await page.getByRole('button',{name:'收起界面',exact:true}).click();await expect(page.locator('.workspace-rail')).toBeHidden();await expect(page.locator('.layers-panel')).toBeHidden();await expect(page.locator('.properties-workspace')).toBeHidden();await settle()
  const compact=await canvas.boundingBox(), cv=await camera();await page.mouse.click(compact.x+cv.x+373*cv.zoom,compact.y+cv.y+193*cv.zoom)
  await expect(page.locator('.properties-workspace')).toBeVisible();await expect(page.locator('.layers-panel')).toBeHidden();await settle();await page.screenshot({path:join(output,'minimized-selection.png')})
  await canvas.focus();await page.keyboard.press('Escape');await expect(page.locator('.properties-workspace')).toBeHidden();await page.keyboard.press('Meta+Shift+Backslash');await expect(page.locator('.layers-panel')).toBeVisible();await expect(page.locator('.properties-workspace')).toBeVisible();await settle();checks.push({name:'Minimized UI hides side panels, opens properties on selection, restores previous panels by shortcut'})

 }
 await page.screenshot({path:join(output,'navigation.png')});await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',scope:'Chromium production WebGPU route, 300-node scene, development React timings; not physical trackpad or HDR FPS',checks},null,2));console.log(JSON.stringify({output,checks},null,2))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),checks},null,2));await page?.screenshot({path:join(output,'failure.png')});throw error}finally{await browser?.close();server.kill('SIGTERM')}
