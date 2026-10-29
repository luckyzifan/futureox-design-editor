/** Real topology interval programs: exact four-plane MRT coverage oracle. */
import {readFile} from 'node:fs/promises'
import {decodeScenePacket} from '../src/kernel/gpu/scene-packet'
import {runProof,sha256} from './exact-prefix-proof-utils'
const file=process.env.DESIGN_COVERAGE_PACKET
if(!file)throw Error('DESIGN_COVERAGE_PACKET required')
await runProof('topology-packed-coverage',[file],async proof=>{
 const bytes=await readFile(file),scene=decodeScenePacket(new Uint8Array(bytes)),curves=Array.from(scene.curves)
 const candidates=Object.values(scene.nodes).flatMap(n=>[n.fill,...n.strokes.map(s=>s.path)])
  .filter(p=>p.area&&p.count>0&&p.sampleCount===4&&p.rect.w>0&&p.rect.h>0&&p.rect.w*p.rect.h<=1048576&&[3,4].includes(curves[p.area!.first*4]))
 const paths=[3,4].flatMap(header=>[...new Map(candidates.filter(p=>curves[p.area!.first*4]===header).map(p=>[sha256(JSON.stringify(p)),p])).values()]
  .sort((a,b)=>b.area!.count-a.area!.count).slice(0,3))
 if(!paths.length)throw Error('No real area programs')
 const manifest={packet:file,packetSha256:sha256(bytes),nodes:Object.keys(scene.nodes).length,paths:paths.map(p=>({rect:p.rect,header:curves[p.area!.first*4],words:p.area!.count*4})),scope:'Same real native topology programs, hardware raw coverage, four exact phases; not GUI latency or full-editor fidelity'}
 await proof.write('fixtures.json',manifest)
 if(proof.prepareOnly)return {status:'prepared',...manifest}
 const result=await proof.browser(async page=>{
  return page.evaluate(async(payload)=>{
   const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
   const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
   const device=raw.device as GPUDevice,records:any[]=[],batches:any[]=[]
   const scene:any={...payload.scene,curves:new Float32Array(payload.scene.curves),vertices:new Float32Array(payload.scene.vertices)}
   try{
    if(device.adapterInfo.isFallbackAdapter!==false)throw Error('Hardware GPU required')
    raw.packedCoverageEnabled=true;raw.sampleOnlyCoverageEnabled=true
    await driver.prepareScene(scene,true)
    let components=0
    for(const [index,path] of payload.paths.entries()){
     const regions=[path.rect,{x:path.rect.x+1,y:path.rect.y+1,w:Math.max(1,Math.min(19,path.rect.w-1)),h:Math.max(1,Math.min(11,path.rect.h-1))}]
     for(const region of regions){
      driver.begin(new Float32Array(scene.vertices),new Float32Array(scene.curves))
      const control=Array.from({length:4},()=>driver.createBinaryCoverage!(region.w,region.h))
      const candidate=Array.from({length:4},()=>driver.createBinaryCoverage!(region.w,region.h))
      try{
       raw.sampleOnlyCoverageEnabled=false
       for(let phase=0;phase<4;phase++)driver.maskRegion(path,control[phase],phase,region)
       raw.sampleOnlyCoverageEnabled=true
       const before=raw.packedCoveragePasses
       if(!driver.maskAll(path,candidate,region)||raw.packedCoveragePasses!==before+1)throw Error('Actual MRT dispatch absent')
       let different=0,zeros=0,ones=0
       for(let phase=0;phase<4;phase++){
        const a=await driver.readSurface(control[phase]),b=await driver.readSurface(candidate[phase])
        const aa=new Uint32Array(a.buffer,a.byteOffset,a.length),bb=new Uint32Array(b.buffer,b.byteOffset,b.length)
        if(aa.length!==bb.length)throw Error('Coverage length differs')
        for(let i=0;i<aa.length;i++){different+=Number(aa[i]!==bb[i]);zeros+=Number(aa[i]===0);ones+=Number(aa[i]===0x3f800000)}
        components+=aa.length
       }
       if(different)throw Error('MRT differs from original four area draws')
       records.push({index,region,different,zeros,ones,drawsBefore:4,drawsAfter:1})
       await driver.checkpoint('readback')
      }finally{for(const target of [...control,...candidate])driver.destroy(target)}
     }
    }
    const path=payload.paths[0],targets=Array.from({length:4},()=>driver.createBinaryCoverage!(path.rect.w,path.rect.h))
    try{
     driver.begin(new Float32Array(scene.vertices),new Float32Array(scene.curves))
     for(const enabled of [false,true]){raw.sampleOnlyCoverageEnabled=enabled;if(enabled)driver.maskAll(path,targets);else for(let i=0;i<4;i++)driver.mask(path,targets[i],i);await driver.checkpoint('timing')}
     for(let block=0;block<3;block++)for(const enabled of [false,true,true,false]){
      raw.sampleOnlyCoverageEnabled=enabled;const before=driver.drawCalls,start=performance.now()
      for(let repeat=0;repeat<8;repeat++)if(enabled){if(!driver.maskAll(path,targets))throw Error('Timed MRT decline')}else for(let i=0;i<4;i++)driver.mask(path,targets[i],i)
      const encodeMs=performance.now()-start;await driver.checkpoint('timing')
      batches.push({block,enabled,draws:driver.drawCalls-before,encodeMs,completeMs:performance.now()-start})
     }
    }finally{await driver.checkpoint('readback');for(const t of targets)driver.destroy(t)}
    return {status:'passed',adapter:driver.stats().adapter,components,different:0,records,batches}
   }catch(error){return {status:'failed',error:String(error),records,batches}}
   finally{await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});driver.dispose()}
  },{scene:{...scene,curves:Array.from(scene.curves),vertices:Array.from(scene.vertices)},paths})
 })
 await proof.write('gpu-result.json',result)
 if(result.status!=='passed')throw Error(result.error)
 return {...manifest,...result}
})
