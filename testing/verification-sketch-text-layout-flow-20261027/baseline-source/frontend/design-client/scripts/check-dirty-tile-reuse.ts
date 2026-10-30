/** Production worker: certified reuse vs the same worker compiling witnesses.
 * Measures this controlled SDR workload, not Figma or native event latency. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const output=await mkdtemp(join(tmpdir(),'forma-dirty-tile-reuse-'))
const server=spawn('bun',['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','0','--strictPort'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']})
let log='',browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try {
  const base=await new Promise<string>((resolve,reject)=>{const t=setTimeout(()=>reject(Error(log)),20000);server.stdout.on('data',()=>{const m=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0])}})})
  browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--use-angle=metal']})
  const page=await browser.newPage();await page.goto(base+'/gpu-check.html')
  const rows=await page.evaluate(async()=>{
    const {KernelClient}=await import('/src/kernel/client.ts'),{blank,node,paint,effect}=await import('/src/model.ts')
    const rows=[]
    for(const profile of ['analytic','figmaSoftware'] as const)for(const dpr of [1,2]){
      const fast=new KernelClient(),baseline=new KernelClient()
      try {
        let d=blank('dirty certificate');d.schemaVersion=10;d.rasterProfile=profile
        for(let i=0;i<24;i++){const n=node('rectangle',12+(i%6)*118,12+Math.floor(i/6)*116,72,68);n.fills=[paint(i%2?'#7061ba':'#397d69')];n.opacity=i%3?.8:1;d.nodes[n.id]=n;d.pages[0].children.push(n.id)}
        const parent=node('frame',530,40,140,120),child=node('ellipse',10,15,60,60)
        parent.transform=[1,.125,-.1,1,530,40];parent.fills=[];parent.clip=false;parent.children=[child.id];d.nodes[parent.id]=parent;d.nodes[child.id]=child;d.pages[0].children.push(parent.id)
        const edit=(fn:any)=>{const n=structuredClone(d.nodes[child.id]);fn(n);d={...d,nodes:{...d.nodes,[child.id]:n}}}
        let view={x:.125*dpr,y:.375*dpr,zoom:dpr},transparent=true
        async function render(client:any,disable:boolean){
          const tiles=new Map(),tileViewport=[]
          for(let y=0;y<512*dpr;y+=256)for(let x=0;x<768*dpr;x+=256)tileViewport.push({key:`${x}:${y}`,x,y,width:256,height:256,zoom:dpr,phaseX:view.x-Math.floor(view.x),phaseY:view.y-Math.floor(view.y)})
          const t=performance.now();const stats=await client.render(d,{pageId:d.pages[0].id,width:768*dpr,height:512*dpr,view,transparent,grid:false,rasterProfile:profile,tileViewport,tileOwner:{documentId:d.id,sessionEpoch:1}},false,'webgpu',true,false,{disableCertifiedTileReuse:disable},(tile:any)=>tiles.set(tile.key,tile.bytes))
          if(stats.backend!=='webgpu'||tiles.size!==tileViewport.length)throw Error('Incomplete hardware frame')
          return {tiles,stats,elapsed:performance.now()-t}
        }
        for(const step of ['cold','unchanged','nested-move','opacity','background','effect','undo','phase']){
          if(step==='nested-move')edit((n:any)=>n.transform[4]+=64)
          if(step==='opacity')edit((n:any)=>n.opacity=.25)
          if(step==='background')transparent=false
          if(step==='effect')edit((n:any)=>n.effects=[{...effect('shadow'),radius:2,x:6,y:8}])
          if(step==='undo')edit((n:any)=>{n.effects=[];n.transform[4]-=64})
          if(step==='phase')view={...view,x:view.x+17.25,y:view.y-9.5}
          const a=await render(fast,false),b=await render(baseline,true)
          let differences=0
          for(const [key,bytes]of a.tiles){const expected=b.tiles.get(key);if(!expected||bytes.length!==expected.length)throw Error('Tile geometry mismatch');for(let i=0;i<bytes.length;i++)differences+=Number(bytes[i]!==expected[i])}
          const row={profile,dpr,step,differences,certified:a.stats.certifiedTileHits||0,witnessHits:b.stats.tileCacheHits||0,fastCompileMs:a.stats.compileMs,baselineCompileMs:b.stats.compileMs,fastMs:a.elapsed,baselineMs:b.elapsed};rows.push(row)
          if(differences)throw Error(JSON.stringify(row))
          if(['unchanged','nested-move','opacity'].includes(step)&&!row.certified)throw Error('Missing production dirty-region reuse: '+JSON.stringify(row))
          if(['cold','background','effect','undo','phase'].includes(step)&&row.certified)throw Error('Invalid proof survived global change: '+JSON.stringify(row))
        }
      }finally{fast.dispose();baseline.dispose()}
    }
    return rows
  })
  const hashes={}
  for(const file of ['src/kernel/render-worker.ts','src/kernel/exact-tile-cache.ts','src/generated/design-kernel/design_kernel_bg.wasm'])hashes[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex')
  await writeFile(join(output,'results.json'),JSON.stringify({scope:'Controlled SDR production worker WebGPU; no native latency or HDR claim',status:'passed',rows,hashes},null,2))
  console.log(JSON.stringify({output,status:'passed',checks:rows.length,rows:rows.filter(r=>r.step==='nested-move')}))
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error)}));console.log(JSON.stringify({output,status:'failed',error:String(error)}));throw error}
finally{await browser?.close();server.kill('SIGTERM')}
