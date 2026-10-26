import assert from 'node:assert/strict'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
if(isMainThread){
  const flag=new SharedArrayBuffer(4),worker=new Worker(new URL(import.meta.url),{workerData:{flag,root:process.cwd()}})
  const report=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('WASM cancellation timeout'))},60000)
    worker.on('error',error=>{clearTimeout(timer);reject(error)})
    worker.on('message',message=>{
      if(message.started){Atomics.store(new Int32Array(flag),0,1);Atomics.notify(new Int32Array(flag),0)}
      else {clearTimeout(timer);resolve(message)}
    })
  })
  await worker.terminate();assert.equal(report.status,'passed')
  await writeFile('testing/verification-render-pipeline-20261025/wasm-cancellation.json',JSON.stringify(report,null,2)+'\n')
  console.log(report)
}else{
  const {initSync,VectorEngine}=await import(path.join(workerData.root,'frontend/design-client/src/generated/design-kernel/design_kernel.js'))
  initSync({module:await readFile(path.join(workerData.root,'frontend/design-client/public/kernel/design_kernel_bg.wasm'))})
  const nodes=Object.fromEntries(Array.from({length:600},(_,i)=>['n'+i,{id:'n'+i,kind:'ellipse',width:20,height:20,
    transform:[1,0,0,1,i%25,i%17],fills:[{kind:'solid',color:'#123456'}]}]))
  const document=JSON.stringify({schemaVersion:1,id:'d',name:'d',pages:[{id:'p',name:'p',children:Object.keys(nodes),background:'#ffffff'}],nodes})
  const options=JSON.stringify({pageId:'p',width:64,height:64,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'})
  const engine=new VectorEngine(),fresh=new VectorEngine();engine.load_document(document);fresh.load_document(document)
  let checkpoints=0,error
  try{engine.compile_gpu_packet_cancellable(options,()=>{
    if(++checkpoints===100){parentPort.postMessage({started:true});Atomics.wait(new Int32Array(workerData.flag),0,0,5000)}
    return Atomics.load(new Int32Array(workerData.flag),0)!==0
  })}catch(e){error=String(e)}
  assert.equal(error,'PREVIEW_CANCELLED');assert.equal(checkpoints,100)
  assert.equal(engine.compile_gpu(options),fresh.compile_gpu(options))
  assert.deepEqual(engine.render_png(options),fresh.render_png(options))
  engine.free();fresh.free()
  parentPort.postMessage({status:'passed',scope:'real WASM in an independent Node worker; deterministic mid-compilation gate, not latency measurement',checkpoints,recoveredSceneAndPng:true})
}
