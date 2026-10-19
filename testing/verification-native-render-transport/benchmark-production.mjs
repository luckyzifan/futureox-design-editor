import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { NativeRenderProcess } from '../../frontend/design-desktop/src/native-render.mjs'
import { decodeNativeRenderPixels } from '../../frontend/design-client/src/kernel/native-render-pixels.ts'
const fixture=new URL('./rust-codec-fixture',import.meta.url).pathname
const sizes=[[96,64],[512,512],[1920,1080],[3840,2160]].filter(([w,h])=>!process.env.SIZE||process.env.SIZE===`${w}x${h}`), count=+(process.env.SAMPLES||31)
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1),samples:values}}
const legacy=new NativeRenderProcess(fixture,undefined,'cpu'),binary=new NativeRenderProcess(fixture,undefined,'cpu',{protocol:'frb1'})
const results=[]
try {
 await Promise.all([legacy.load('{}'),binary.load('{}')])
 for(const[width,height]of sizes){
  const expected=Uint8Array.from({length:width*height*4},(_,i)=>(i*13+i%251)&255)
  const samples={json:{pipe:[],cloneDecode:[],total:[]},frb1:{pipe:[],cloneDecode:[],total:[]}}
  for(let index=-3;index<count;index++)for(const mode of (index%2?['frb1','json']:['json','frb1'])){
   global.gc?.();const start=performance.now();const reply=await(mode==='json'?legacy:binary).frame({width,height});const received=performance.now();const decoded=decodeNativeRenderPixels(structuredClone(reply));const done=performance.now()
   assert.deepEqual(decoded,expected);assert.equal(reply.stats.backend,'codec-fixture')
   if(index>=0){samples[mode].pipe.push(received-start);samples[mode].cloneDecode.push(done-received);samples[mode].total.push(done-start)}
  }
  const result={width,height,rgbaBytes:expected.length,json:Object.fromEntries(Object.entries(samples.json).map(([k,v])=>[k,summary(v)])),frb1:Object.fromEntries(Object.entries(samples.frb1).map(([k,v])=>[k,summary(v)]))};results.push(result)
  console.error(`${width}x${height} total median/p95: ${result.json.total.median.toFixed(3)}/${result.json.total.p95.toFixed(3)} -> ${result.frb1.total.median.toFixed(3)}/${result.frb1.total.p95.toFixed(3)} ms; stdio+encode+parse ${result.json.pipe.median.toFixed(3)} -> ${result.frb1.pipe.median.toFixed(3)} ms`)
 }
} finally {await Promise.all([legacy.stop(),binary.stop()])}
const files=['frontend/design-desktop/src/native-render.mjs','frontend/design-desktop/src/native-render-frame.mjs','frontend/design-client/src/kernel/native-render-pixels.ts','design-studio/crates/design-gpu/src/serve_protocol.rs','testing/verification-native-render-transport/rust-codec-fixture.rs','testing/verification-native-render-transport/rust-codec-fixture']
const report={scope:'Production Rust codec + synthetic pixels + actual OS stdio + active Node receiver + structuredClone + production renderer decode. No rendering, GPU, Electron, browser or FPS. Timings are CPU pipeline evidence only.',node:process.version,platform:process.platform,count,warmups:3,order:'Alternating order; forced GC before each sample; exact byte equality checked after timing',hashes:Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(new URL('../../'+p,import.meta.url))).digest('hex')])),results}
writeFileSync(new URL(process.env.OUTFILE||'./production-benchmark.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
