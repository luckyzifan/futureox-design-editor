/** Actual worker WebGPU/WebGL2 and Rust reference for the newly connected effects. */
import {chromium,expect} from '@playwright/test'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const output=await mkdtemp(join(tmpdir(),'forma-kernel-live-'))
const server=spawn('bun',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']})
let log='',browser:any;server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try{
 const base=await new Promise<string>((resolve,reject)=>{const t=setTimeout(()=>reject(Error(log)),20000);server.stdout.on('data',()=>{const m=log.match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(t);resolve(m[0])}})})
 browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--use-angle=metal']});const page=await browser.newPage();page.on('console',m=>{if(m.text().startsWith('KERNEL_LIVE_ROW '))console.log(m.text())});await page.goto(base+'/gpu-check.html')
 const rows=await page.evaluate(async()=>{
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
  const {KernelClient}=await import('/src/kernel/client.ts'),{blank,node,paint,effect}=await import('/src/model.ts'),{defaultColorSettings}=await import('/src/color.ts')
  const client=new KernelClient(),rows=[]
  try{
   for(const profile of ['analytic','figma','figmaSoftware'] as const)for(const managed of [false,true])for(const chain of [false,true]){
    if(managed&&profile==='analytic')continue
    const d=blank(),n=node('rectangle',20.125,18.375,38,28);d.schemaVersion=9
    n.fills=[{...paint('#ff4400'),kind:'linear',stops:[{offset:0,color:managed?'color(rec2100-linear 3 .3 .1)':'#ff4400'},{offset:1,color:'#2255cc'}]}]
    n.radii=[6,6,6,6];n.effects=[{...effect('blur'),radius:2,gradientBlur:{start:[0,0],end:[38,28],startCount:0,endCount:3,smooth:true}}]
    if(chain)n.effects.push({...effect('blur'),radius:1,gradientBlur:{start:[0,0],end:[0,28],startCount:2,endCount:0,smooth:false}})
    d.nodes[n.id]=n;d.pages[0].children=[n.id];d.rasterProfile=managed?'figma':profile;if(managed)d.colorManagement=defaultColorSettings()
    const opts={pageId:d.pages[0].id,width:96,height:72,view:{x:.125,y:.375,zoom:1},transparent:true,grid:false,rasterProfile:profile}
    const cpu=await client.render(d,opts,false,'cpu',true)
    for(const backend of ['webgpu','webgl2'] as const){const gpu=await client.render(d,opts,false,backend,true);if(gpu.backend!==backend)throw Error(`Fallback ${backend} -> ${gpu.backend}: ${gpu.reason}`)
     let bytes=0,bits=0;for(let i=0;i<cpu.bytes.length;i++)bytes+=Number(cpu.bytes[i]!==gpu.bytes[i])
     if(managed){if(!cpu.linear||!gpu.linear)throw Error('Missing HDR buffer');const a=new Uint32Array(cpu.linear.buffer,cpu.linear.byteOffset,cpu.linear.length),b=new Uint32Array(gpu.linear.buffer,gpu.linear.byteOffset,gpu.linear.length);for(let i=0;i<a.length;i++)bits+=Number(a[i]!==b[i])}
     rows.push({profile,managed,chain,backend,bytes,bits,hybridEffects:gpu.hybridEffects})
     console.log('KERNEL_LIVE_ROW '+JSON.stringify(rows.at(-1)));if(bytes||bits||!(gpu.hybridEffects!>0))throw Error(JSON.stringify(rows.at(-1)))
    }
   }
  }finally{client.dispose()}
  return rows
 })
 await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',rows},null,2));console.log(JSON.stringify({status:'passed',output,checks:rows.length}))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error)},null,2));console.log(JSON.stringify({status:'failed',output,error:String(error)}));throw error}finally{await browser?.close();server.kill('SIGTERM')}
