// Run from the frozen Vite source copy. Only that copy has the A/B shader selector.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {withGpuPage} from '../../testing/verification-effect-work-20261104/gpu-page.mjs'
const [packets,output,...tiles]=process.argv.slice(2)
await withGpuPage({},async page=>{
  page.on('pageerror',error=>console.error(String(error)))
  await page.route('**/__retention_packet/*',route=>route.fulfill({
    contentType:'application/octet-stream',path:path.join(packets,path.basename(new URL(route.request().url()).pathname))}))
  const rows=[]
  for(const tile of tiles){
    const result=await page.evaluate(async tile=>{
      const {initializePicking}=await import('/src/kernel/picking.ts')
      const {VectorEngine}=await import('/src/generated/design-kernel/design_kernel.js')
      const {decodeScenePacket}=await import('/src/kernel/gpu/scene-packet.ts')
      const {createGpu}=await import('/src/kernel/gpu/factory.ts')
      const {managedSceneImageLoader}=await import('/src/kernel/scene-image-hydration.ts')
      const {DecodedImageCache}=await import('/src/kernel/decoded-image-cache.ts')
      await initializePicking()
      const bytes=new Uint8Array(await (await fetch('/__retention_packet/'+tile+'.pkt')).arrayBuffer())
      const colors=decodeScenePacket(bytes).colorManagement
      const owners=[]
      const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('')
      try{
        for(const arm of ['A','B']){
          globalThis.__qaDenseArm=arm
          const kernel=new VectorEngine()
          kernel.load_document(JSON.stringify({id:'qa',name:'qa',schemaVersion:5,pages:[{id:'p',name:'p',background:'#ffffff',children:[]}],nodes:{},colorManagement:colors}))
          const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel,scope:'qa',settings:JSON.stringify(colors)}),
            {key:async()=>undefined,read:async()=>undefined,write(){}})
          const gpu=await createGpu('webgpu',true,true,colors,loader,false,true)
          const scene=decodeScenePacket(bytes);scene.sourceDetailTile=false;scene.sourceImageDisplay=true
          gpu.driver.captureDisplay=true
          if(arm==='A')Object.defineProperty(gpu.driver,'densePairsReady',{get:()=>false,configurable:true})
          const drawPair=gpu.driver.drawDensePair?.bind(gpu.driver)
          gpu.driver.__qaPairs=0
          if(drawPair)gpu.driver.drawDensePair=(...args)=>{const used=drawPair(...args);if(used)gpu.driver.__qaPairs++;return used}
          owners.push({kernel,gpu,scene,arm,samples:[]})
        }
        async function draw(o, pixels=false){
          globalThis.__qaDenseArm=o.arm
          const d=o.gpu.driver, finish=d.finish
          if(pixels)d.finish=async function(texture,...args){o.raw=await this.readSurface(texture);return finish.call(this,texture,...args)}
          try{
            await d.device.queue.onSubmittedWorkDone()
            const previousPairs=d.__qaPairs
            const start=performance.now(), r=await o.gpu.render(o.scene,false,true,()=>true,undefined,true)
            await d.device.queue.onSubmittedWorkDone()
            const complete=performance.now()-start
            r.bitmap?.close();if(r.gpuTile)d.releasePresented?.([r.gpuTile])
            return {complete,graph:r.graphMs,finish:r.finishMs,checkpoint:r.checkpointMs,
              draws:r.drawCalls,passes:r.passPixels,peak:r.peakTextureBytes,pairs:d.__qaPairs-previousPairs}
          }finally{d.finish=finish}
        }
        for(const o of owners){await draw(o,true);await draw(o)}
        const a=new Uint32Array(owners[0].raw.buffer,owners[0].raw.byteOffset,owners[0].raw.length),
          b=new Uint32Array(owners[1].raw.buffer,owners[1].raw.byteOffset,owners[1].raw.length)
        if(a.length!==b.length)throw Error('Float channel counts differ')
        let diff=0;for(let i=0;i<a.length;i++) if(a[i]!==b[i])diff++
        if(diff)throw Error('Float pixels differ: '+diff)
        const pixelHash=await digest(a)
        for(const i of [0,1,1,0,1,0,0,1])owners[i].samples.push(await draw(owners[i]))
        const s=owners[0].scene, dense=s.densePaint
        const starts=dense?[...Object.values(dense.nodes),...Object.values(dense.sources??{})]:[]
        const words=dense? s.vertices.subarray(dense.vertexFloats):[]
        return {tile,channels:a.length,diff,pixelHash,packetBytes:bytes.byteLength,encodedRoots:starts.length,
          leafRoots:starts.filter(pc=>words[pc*4]===words[pc*4+1]).length,
          arms:owners.map(o=>({name:o.arm,samples:o.samples}))}
      }finally{for(const {gpu,kernel} of owners){gpu.driver.poolKey=undefined;gpu.dispose();kernel.free()}}
    },tile)
    rows.push(result);assert(!result.diff&&result.encodedRoots)
    console.log(tile,result.leafRoots,result.encodedRoots,result.arms.map(a=>a.samples.map(s=>Math.round(s.complete))))
    await fs.writeFile(output,JSON.stringify(rows,null,2)+'\n')
  }
})
