/** Strict byte parity for new local tools, actual WebGPU/WebGL2, no HDR fixture. */
import {chromium,expect} from '@playwright/test'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const output=await mkdtemp(join(tmpdir(),'forma-local-tools-precision-'))
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
   const {initializePicking}=await import('/src/kernel/picking.ts');await initializePicking()
   const {vectorTool}=await import('/src/utility-tools.tsx')
   const fixtures=[]
   const shapeDoc=(name)=>{const d=blank(name);d.schemaVersion=10;const n=node('rectangle',30.125,25.375,90,70);n.fills=[paint('#705ad6')];d.nodes[n.id]=n;d.pages[0].children=[n.id];return{d,n}}
   {const {d,n}=shapeDoc('slice-and-review');const slice=node('slice',10,10,150,100);d.nodes[slice.id]=slice;d.pages[0].children.push(slice.id);d.reviews=[{id:crypto.randomUUID(),pageId:d.pages[0].id,position:{x:10,y:10},kind:'comment',resolved:false,messages:[{id:crypto.randomUUID(),author:'本机',text:'not part of pixels',createdAt:1}]}];fixtures.push(d)}
   {const {d,n}=shapeDoc('offset');n.pathOffset=6;fixtures.push(d)}
   {const {d,n}=shapeDoc('bend-cut');n.kind='line';n.fills=[];n.strokes=[{...((await import('/src/model.ts')).stroke('#226699',3))}];n.network={vertices:[{id:'a',x:0,y:0},{id:'b',x:100,y:20}],edges:[{id:'e',from:'a',to:'b'}],fillRule:'nonzero'};n.network=vectorTool(n,'bend',{x:50,y:10},{edge:'e',parameter:.5,delta:{x:0,y:35}}).network;n.network=vectorTool(n,'cut',{x:50,y:45},{edge:'e',parameter:.5,nonce:'cut'}).network;fixtures.push(d)}
   {const d=blank('text-on-path');d.schemaVersion=10;const n=node('text',10,30,180,80);n.text='Forma 中文';n.fontSize=18;n.fills=[paint('#134b72')];n.textPath={network:{vertices:[{id:'a',x:0,y:50},{id:'b',x:180,y:50}],edges:[{id:'e',from:'a',to:'b',c1:{x:40,y:-10},c2:{x:140,y:110}}],fillRule:'nonzero'},offset:0,normal:0,reverse:false};d.nodes[n.id]=n;d.pages[0].children=[n.id];fixtures.push(d)}
   {const {d,n}=shapeDoc('paint-region');const {editableNetwork}=await import('/src/editable-network.ts'),{vector_fill_region_json}=await import('/src/generated/design-kernel/design_kernel.js');n.kind='vector';n.network=JSON.parse(vector_fill_region_json(JSON.stringify(editableNetwork({...n,kind:'rectangle'})),40,30,false));fixtures.push(d)}
   {const d=blank('code-highlighting');d.schemaVersion=10;const f=node('frame',10,10,210,100),t=node('text',12,12,180,70);f.board={kind:'code-block',language:'rust'};f.fills=[paint('#24292f')];f.children=[t.id];t.text='fn main() { let x = 42; }';t.fontSize=14;t.fills=[paint('#e6edf3')];d.nodes={[f.id]:f,[t.id]:t};d.pages[0].children=[f.id];fixtures.push(d)}
   for(const noise of ['figma','gabor','perlin'] as const){const {d,n}=shapeDoc('texture-'+noise);n.width=24;n.height=20;n.effects=[{...effect('texture'),radius:2,opacity:1,texture:{noiseSize:[8,16],clipToShape:true,noise}}];fixtures.push(d)}
   {const {d,n}=shapeDoc('exact-gradient-blur');n.width=32;n.height=24;n.effects=[{...effect('blur'),radius:2,opacity:1,gradientBlur:{start:[0,0],end:[32,24],startCount:0,endCount:3,smooth:true}}];fixtures.push(d)}
   for(const axis of ['x','y']){const {d,n}=shapeDoc('axis-matrix-'+axis);n.fills=[{...paint('#000000','linear'),transform:axis==='x'?[1,0,0,1,0,0]:[0,1,-1,0,1,0],stops:[{offset:0,color:'#000000'},{offset:1,color:'#ffffff'}]}];fixtures.push(d)}
   for(const d of fixtures)for(const profile of (d.name.startsWith('axis-matrix-')?['analytic','figmaSoftware','figma']:['analytic','figmaSoftware']) as ('analytic'|'figmaSoftware'|'figma')[])for(const dpr of [1,2]){
    d.rasterProfile=profile
    const opts={pageId:d.pages[0].id,width:240*dpr,height:160*dpr,view:{x:.125*dpr,y:.375*dpr,zoom:dpr},transparent:true,grid:false,rasterProfile:profile}
    const cpu=await client.render(d,opts,false,'cpu',true);if(!cpu.bytes.some((v,i)=>i%4===3&&v>0))throw Error('Empty reference '+d.name)
    for(const backend of ['webgpu','webgl2'] as const){const gpu=await client.render(d,opts,false,backend,true);if(gpu.backend!==backend)throw Error(`Fallback ${backend} -> ${gpu.backend}: ${gpu.reason}`)
     let bytes=0;for(let i=0;i<cpu.bytes.length;i++)bytes+=Number(cpu.bytes[i]!==gpu.bytes[i]);const row={fixture:d.name,profile,dpr,backend,differentBytes:bytes};rows.push(row);console.log('KERNEL_LIVE_ROW '+JSON.stringify(row));if(bytes)throw Error(JSON.stringify(row))
    }
   }

  }finally{client.dispose()}
  return rows
 })
 await writeFile(join(output,'results.json'),JSON.stringify({status:'passed',rows},null,2));console.log(JSON.stringify({status:'passed',output,checks:rows.length}))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error)},null,2));console.log(JSON.stringify({status:'failed',output,error:String(error)}));throw error}finally{await browser?.close();server.kill('SIGTERM')}
