import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { NativeRenderFrame, encodeCandidate } from './candidate-frame.mjs'
const sampleCount = +(process.env.SAMPLES || 31)
const sizes = [[96,64],[512,512],[1920,1080],[3840,2160]]
const summarize = values => { const sorted = [...values].sort((a,b)=>a-b); return {median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1),samples:values} }
const results = []
for (const [width,height] of sizes) {
 const rgba = Buffer.alloc(width*height*4); for(let i=0;i<rgba.length;i++)rgba[i]=(i*13+i%251)&255
 const metadata={type:'frame',width,height,stats:{frames:1,backend:'cpu',last_render_ms:1.25,label:'中文'}}
 const identity={session:'00000000-0000-0000-0000-000000000001',id:1,kind:'frame'}
 const old=()=>{const wire=Buffer.from(JSON.stringify({...metadata,rgba:rgba.toString('base64')})+'\n'); const parts=[];for(let i=0;i<wire.length;i+=65536)parts.push(wire.subarray(i,Math.min(wire.length-1,i+65536)));const msg=JSON.parse(Buffer.concat(parts,wire.length-1).toString('utf8')); const cloned=structuredClone(msg);return {rgba:Uint8Array.from(atob(cloned.rgba),c=>c.charCodeAt(0)),width:cloned.width,height:cloned.height,bytes:wire.length}}
 const binary=()=>{const parts=encodeCandidate({...metadata,encoding:'rgba8',session:identity.session,id:identity.id},rgba);const frame=new NativeRenderFrame();for(const part of parts)for(let i=0;i<part.length;i+=65536)frame.append(part.subarray(i,i+65536));const msg=frame.decode(identity); const cloned=structuredClone(msg);return {rgba:cloned.rgba,width:cloned.width,height:cloned.height,bytes:parts.reduce((n,p)=>n+p.length,0)}}
 const samples={legacy:[],frb1:[]};let byteCounts={}
 for(let i=-3;i<sampleCount;i++)for(const key of (i%2 ? ['frb1','legacy']:['legacy','frb1'])) {
  global.gc?.();const start=performance.now();const value=(key==='legacy'?old:binary)(); const ms=performance.now()-start
  assert.deepEqual(value.rgba,new Uint8Array(rgba));assert.equal(value.width,width);assert.equal(value.height,height)
  if(i>=0)samples[key].push(ms);byteCounts[key]=value.bytes
 }
 results.push({width,height,rgbaBytes:rgba.length,wireBytes:byteCounts,legacy:summarize(samples.legacy),frb1:summarize(samples.frb1)})
 console.error(`${width}x${height}: legacy ${results.at(-1).legacy.median.toFixed(3)}ms / p95 ${results.at(-1).legacy.p95.toFixed(3)}ms; binary ${results.at(-1).frb1.median.toFixed(3)}ms / p95 ${results.at(-1).frb1.p95.toFixed(3)}ms`)
}
const report={scope:'CPU synthetic JS encoding + fragmented decode + structuredClone + existing renderer atob conversion. Candidate only; not Rust encode, OS pipe, Electron, GPU, or FPS.',node:process.version,sampleCount,warmups:3,results}
writeFileSync(new URL('./candidate-benchmark.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
