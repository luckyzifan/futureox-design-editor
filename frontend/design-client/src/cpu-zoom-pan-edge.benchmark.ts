// Visible high-zoom shadow edge; real CPU output, no browser or input claim.
import {test,expect} from 'vitest'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {VectorEngine} from './generated/design-kernel/design_kernel'
import {blank,node,paint,effect} from './model'
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
test.skipIf(process.env.CPU_ZOOM_PAN_EDGE!=='1')('cold32 visible shadow boundary matches fresh CPU tiled pixels',()=>{
 const out=process.env.CPU_ZOOM_PAN_EDGE_REPORT || '../../evidence/phase/cpu-zoom-pan/shadow-edge.json'
 mkdirSync(out.slice(0,out.lastIndexOf('/')),{recursive:true})
 const corner=process.env.CPU_ZOOM_PAN_EDGE_CORNER==='1'
 const d=blank('Visible shadow edge at3200%');d.schemaVersion=5
 const n=node('rectangle',70,80,700,570);n.fills=[paint('#8073dd')];n.effects=[effect('shadow')];d.nodes[n.id]=n;d.pages[0].children=[n.id]
 // Left edge at viewport x320; choose an interior-y edge or the top-left
 // corner at y240. Corner mode uses transparent output to verify shadow alpha.
 const options=JSON.stringify({pageId:d.pages[0].id,width:640,height:480,view:{zoom:32,x:320-70*32,y:240-(corner?80:140)*32},transparent:corner,rasterProfile:'analytic'})
 const rows:unknown[]=[];const outputs:Uint8Array[]=[]
 for(const mode of ['direct','tiled','no-shadow'] as const){
  const engine=new VectorEngine()
  try{
   const doc=structuredClone(d);if(mode==='no-shadow')doc.nodes[n.id].effects=[];engine.load_document(JSON.stringify(doc));const begin=performance.now()
   try{const pixels=mode==='tiled'?engine.assemble_tiled_rgba(options,'null'):engine.render_rgba(options);outputs.push(pixels);writeFileSync(out.replace(/\.json$/,`-${mode}.rgba`),pixels);rows.push({mode,status:'ok',durationMs:performance.now()-begin,sha256:hash(pixels),ledger:JSON.parse(engine.compositing_ledger())})}
   catch(error){rows.push({mode,status:'error',durationMs:performance.now()-begin,error:String(error),ledger:JSON.parse(engine.compositing_ledger())});throw error}
  }finally{engine.free();writeFileSync(out,JSON.stringify({buildProfile:process.env.CPU_ZOOM_PAN_PROFILE || 'scalar-dev-correctness-only',wasmSha256:hash(readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm')),scope:'Cold new engines for direct/tiled/no-shadow. Visible boundary shadow; real640x480CPU pixels. No GUI/physical input or production timing claim without release artifact.',corner,rows},null,2))}
 }
 const [direct,tiled,noShadow]=outputs;let outsideChanged=0,maxOutsideDelta=0,nonUniform=0
 for(let y=0;y<480;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;if(direct[i]!==direct[0]||direct[i+1]!==direct[1]||direct[i+2]!==direct[2])nonUniform++;if(x<320){const delta=Math.max(...[0,1,2].map(c=>Math.abs(direct[i+c]-noShadow[i+c])));if(delta>0)outsideChanged++;maxOutsideDelta=Math.max(maxOutsideDelta,delta)}}
 const partialAlpha=direct.filter((v,i)=>i%4===3&&v>0&&v<255).length
 if(corner)expect(partialAlpha).toBeGreaterThan(0)
 const identical=Buffer.compare(Buffer.from(direct),Buffer.from(tiled))===0
 const prior=JSON.parse(readFileSync(out,'utf8'));writeFileSync(out,JSON.stringify({...prior,corner,partialAlphaPixels:partialAlpha,exactFreshTiledMatch:identical,outsideChangedPixels:outsideChanged,maxOutsideChannelDelta:maxOutsideDelta,nonUniformPixels:nonUniform},null,2))
 expect(nonUniform).toBeGreaterThan(0);expect(outsideChanged).toBeGreaterThan(0);expect(maxOutsideDelta).toBeGreaterThan(0);expect(identical).toBe(true)
},600000)
