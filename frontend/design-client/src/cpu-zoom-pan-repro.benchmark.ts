import {test,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {VectorEngine} from './generated/design-kernel/design_kernel'
import {blank,node,effect,paint,demo} from './model'
const hash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex')
test.skipIf(process.env.CPU_ZOOM_PAN_REPRO!=='1')('minimal effect admission and actual tiled CPU path',()=>{
 const results:unknown[]=[];const out=process.env.CPU_ZOOM_PAN_REPRO_REPORT || '../../evidence/phase/cpu-zoom-pan/minimal-repro.json';mkdirSync('../../evidence/phase/cpu-zoom-pan',{recursive:true})
 for(const kind of ['shadow','glass','noise','none','demo'] as const)for(const method of ['render_rgba','assemble_tiled_rgba'] as const){
  if(process.env.CPU_ZOOM_PAN_REPRO_KIND && process.env.CPU_ZOOM_PAN_REPRO_KIND!==kind)continue
  if(process.env.CPU_ZOOM_PAN_REPRO_METHOD && process.env.CPU_ZOOM_PAN_REPRO_METHOD!==method)continue
  const d=kind==='demo'?demo():blank('Minimal high zoom '+kind)
  d.schemaVersion=5
  if(kind!=='demo'){const n=node('rectangle',70,80,700,570);n.fills=[paint('#8073dd')];n.effects=kind==='none'?[]:[effect(kind)];d.nodes[n.id]=n;d.pages[0].children=[n.id]}
  const engine=new VectorEngine();try{engine.load_font(readFileSync('public/fonts/NotoSansSC.ttf'));engine.load_document(JSON.stringify(d))
   for(const zoom of (process.env.CPU_ZOOM_PAN_REPRO_ZOOM?[Number(process.env.CPU_ZOOM_PAN_REPRO_ZOOM)]:[12.8,25.6,32])){const options=JSON.stringify({pageId:d.pages[0].id,width:640,height:480,transparent:false,rasterProfile:'analytic',view:{zoom,x:320-150*zoom,y:240-140*zoom}});const begin=performance.now();try{const pixels=method==='render_rgba'?engine.render_rgba(options):engine.assemble_tiled_rgba(options,'null');results.push({kind,method,zoom,durationMs:performance.now()-begin,status:'ok',bytes:pixels.length,sha256:hash(pixels),ledger:JSON.parse(engine.compositing_ledger())})}catch(error){results.push({kind,method,zoom,durationMs:performance.now()-begin,status:'error',error:String(error),ledger:JSON.parse(engine.compositing_ledger())})}writeFileSync(out,JSON.stringify({buildProfile:process.env.CPU_ZOOM_PAN_PROFILE || 'scalar-dev-correctness-only',wasmSha256:hash(readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm')),collectedAt:new Date().toISOString(),scope:'Real WASM direct and existing tiled assembly; timings under contention; no UI proof. Tiled off-bucket resampling is not an exact full-frame substitute.',results},null,2))}
  }finally{engine.free()}
 }
 if(process.env.CPU_ZOOM_PAN_REPRO_REQUIRE_SUCCESS==='1')expect(results.every(r=>(r as {status:string}).status==='ok')).toBe(true)
},600000)
