import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const root=process.cwd(),{host}=JSON.parse(await readFile('testing/verification-render-pipeline-20261025/runtime.json','utf8'))
const native=new NativePreparation(path.join(host,'dist/bin/design-prepare'),path.join(root,'frontend/design-client/public/fonts/NotoSansSC.ttf'))
const call=(method,args=[])=>native.request({lane:'canvas',method,args})
try{
  const nodes=Object.fromEntries(Array.from({length:2000},(_,i)=>['n'+i,{id:'n'+i,kind:'ellipse',width:20,height:20,
    transform:[1,0,0,1,i%25,i%17],fills:[{kind:'solid',color:'#123456'}]}]))
  const document=JSON.stringify({schemaVersion:1,id:'d',name:'d',pages:[{id:'p',name:'p',children:Object.keys(nodes),background:'#ffffff'}],nodes})
  assert.equal((await call('load_document',[document])).error,undefined)
  const options=JSON.stringify({pageId:'p',width:64,height:64,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'})
  const pending=native.request({lane:'canvas',method:'compile_gpu_packet',args:[options],cancellationId:37})
  await new Promise(resolve=>setTimeout(resolve,5));native.cancel(37)
  assert.equal((await pending).error,'PREVIEW_CANCELLED')
  const recovery=await call('compile_gpu_packet',[options]);assert.equal(recovery.error,undefined)
  assert(recovery.value.byteLength>24);native.cancel(37)
  const repeated=await call('compile_gpu_packet',[options]);assert.equal(repeated.error,undefined)
  assert.deepEqual(repeated.value,recovery.value)
  const report={status:'passed',scope:'actual host Node worker and rebuilt Rust child; active cancellation, subsequent compile and late cancellation',nodes:2000,packetBytes:recovery.value.byteLength}
  await writeFile('testing/verification-render-pipeline-20261025/native-cancellation.json',JSON.stringify(report,null,2)+'\n');console.log(report)
}finally{await native.close()}
