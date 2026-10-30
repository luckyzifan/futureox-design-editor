/** Serial wall-time comparison of legacy GPU address evaluation and shared
 * byte-image coordinates. Both variants use current Rust asset decoding. */
import { chromium } from '@playwright/test'
import { createServer, type Plugin } from 'vite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root=resolve(import.meta.dir,'..'), shader=resolve(root,'../../design-studio/crates/design-kernel/shaders/vector.wgsl')
const output=process.env.DESIGN_TEST_OUTPUT||await mkdtemp(join(tmpdir(),`forma-image-cost-${randomUUID()}-`))
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('Refusing nonempty evidence output')
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
const files=['src/kernel/gpu/renderer.ts','src/kernel/gpu/webgpu.ts','src/kernel/gpu/webgl.ts','src/kernel/gpu/vector.glsl','src/kernel/render-worker.ts','src/kernel/client.ts','src/kernel/Surface.tsx','src/kernel/ProgressiveSurface.tsx','public/kernel/design_kernel_bg.wasm','scripts/check-image-sampling-cost.ts','package.json']
async function hashes(){const out:Record<string,string>={};for(const name of files)out[name]=hash(await readFile(join(root,name)));out.vectorWgsl=hash(await readFile(shader));return out}
const before=await hashes();await writeFile(join(output,'source-before.json'),JSON.stringify(before,null,2))
const transforms:unknown[]=[],errors:unknown[]=[],rows:any[]=[]
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,server:Awaited<ReturnType<typeof createServer>>|undefined
try{
 for(const mode of ['legacy-address','shared-address']){
  const plugin:Plugin={name:'image-coordinate-cost-control',enforce:'pre',
   transform(source,id){if(mode!=='legacy-address'||id.split('?')[0]!==join(root,'src/kernel/gpu/renderer.ts'))return
    const anchor='this.driver.managed || (this.scene.coherentSamples && this.sampleIndex !== undefined)'
    if(source.split(anchor).length!==2)throw Error('Coordinate admission anchor changed')
    const changed=source.replace(anchor,'this.driver.managed')
    transforms.push({mode,path:id,original:hash(source),changed:hash(changed)});return changed
   },
   async load(id){if(mode!=='legacy-address'||id!==shader+'?raw')return
    const source=await readFile(shader,'utf8')
    const branch='else if(kind==3&&u(46).w>0.5){let grid=byteImageAddress(p);if(grid.z>0.5){paint=round(smpBytesIndex(sourceB,grid.xy,u(2))*opacity)/255.;}else{paint=vec4<f32>(0);}}'
    if(source.split(branch).length!==2)throw Error('Coordinate shader anchor changed')
    const changed=source.replace(branch,'');transforms.push({mode,path:id,original:hash(source),changed:hash(changed)})
    return 'export default '+JSON.stringify(changed)
   }}
  server=await createServer({root,plugins:[plugin],server:{host:'127.0.0.1',port:0,strictPort:true}});await server.listen()
  browser=await chromium.launch({headless:true,chromiumSandbox:true,args:process.platform==='darwin'?['--use-angle=metal']:[]})
  const page=await browser.newPage();page.on('pageerror',e=>errors.push({mode,error:String(e)}));page.on('console',m=>{if(m.type()==='error')errors.push({mode,error:m.text()})})
  await page.goto(server.resolvedUrls!.local[0]+'gpu-check.html')
  const result=await page.evaluate(async mode=>{
   const {KernelClient}=await import('/src/kernel/client.ts'),{initializePicking}=await import('/src/kernel/picking.ts')
   const {encode_png_rgba}=await import('/src/generated/design-kernel/design_kernel.js'),{blank,node,paint}=await import('/src/model.ts')
   await initializePicking();const rows=[]
   for(const [name,assetSide,width,height] of [['small',8,96,80],['large',512,1024,768]] as const){
    const raw=new Uint8Array(assetSide*assetSide*4);for(let i=0;i<raw.length;i+=4)raw.set([75,123,181,80],i)
    const png=encode_png_rgba(assetSide,assetSide,raw),uri='data:image/png;base64,'+btoa(String.fromCharCode(...png))
    const doc=blank(name);doc.schemaVersion=5;doc.rasterProfile='figmaSoftware'
    const image=node('rectangle',3.25,4.5,width-16,height-20);image.fills=[{...paint('#ffffff'),kind:'image',image:uri,fit:'stretch'}]
    doc.nodes={[image.id]:image};doc.pages[0].children=[image.id]
    const options={pageId:doc.pages[0].id,width,height,view:{x:.375,y:-.625,zoom:1},grid:false,transparent:true,rasterProfile:'figmaSoftware' as const}
    const client=new KernelClient();let first:Uint8Array|undefined
    try{
     for(let repeat=-1;repeat<3;repeat++){
      const start=performance.now(),result=await client.render(doc,options,false,'webgpu',true),wallMs=performance.now()-start
      if(result.backend!=='webgpu')throw Error(`Unexpected fallback: ${result.backend} ${result.reason}`)
      if(first&&first.some((v,i)=>v!==result.bytes[i]))throw Error('Identical input changed frame bytes')
      first=result.bytes.slice()
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',result.bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')
      rows.push({mode,name,assetSide,width,height,repeat,warmup:repeat<0,wallMs,renderMs:result.milliseconds,
       graphMs:result.graphMs,compileMs:result.compileMs,checkpointMs:result.checkpointMs,submissions:result.commandSubmissions,
       workingTextureBytes:result.workingTextureBytes,peakTextureBytes:result.peakTextureBytes,backend:result.backend,pixelSha256:digest})
      result.bitmap?.close()
     }
    }finally{client.dispose()}
   }return rows
  },mode)
  rows.push(...result);console.log(JSON.stringify({mode,rows:result}))
  await browser.close();browser=undefined;await server.close();server=undefined
 }
 const after=await hashes();await writeFile(join(output,'source-after.json'),JSON.stringify(after,null,2))
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Runtime source changed during measurement')
 if(errors.length)throw Error('Browser errors')
 for(const name of ['small','large'])if(new Set(rows.filter(row=>row.name===name).map(row=>row.pixelSha256)).size!==1)throw Error('Control/candidate pixels differ')
 await writeFile(join(output,'results.json'),JSON.stringify({rows,transforms,errors,sourceUnchanged:true,scope:'One warmup and three identical full-frame renders per size and variant; asset decode retained between warm samples; real GPU, all DPR/output/quality unchanged.'},null,2))
 console.log(JSON.stringify({output,passed:true}))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),rows,transforms,errors},null,2));throw error}
finally{await browser?.close();await server?.close()}
