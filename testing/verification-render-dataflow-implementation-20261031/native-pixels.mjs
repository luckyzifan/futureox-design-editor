import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const root=process.cwd(),out=path.resolve('testing/verification-render-dataflow-implementation-20261031')
const prior=path.resolve('testing/verification-source-work-reuse-20261031')
const descriptor=JSON.parse(await fs.readFile(path.join(prior,'baseline-1/snapshot.json'),'utf8'))
const layout=JSON.parse(await fs.readFile(path.join(prior,'baseline-1/layout.json'),'utf8'))
const row=layout.find(r=>r.id==='10c6999a-19ed-4836-be94-46a2609309d7');assert(row)
const hash=b=>createHash('sha256').update(b).digest('hex')
const result={scope:'Same immutable 124447-node source snapshot; fresh native workers, warm OS cache; CPU PNG, not GUI/GPU latency',runs:[],snapshotSha256:hash(await fs.readFile(descriptor.path))}
let reference
for(const label of ['baseline','candidate','candidate','baseline']){
 const bin=label==='baseline'?path.join(prior,'selected-bin/design-prepare'):path.join(root,'design-studio/target/release/design-prepare')
 const worker=new NativePreparation(bin,path.join(root,'frontend/design-client/public/fonts/NotoSansSC.ttf'))
 try{
  const start=performance.now(),loaded=await worker.loadSourceSnapshot(descriptor),loadMs=performance.now()-start
  if(loaded.error)throw Error(loaded.error)
  const width=384,zoom=width/row.placed.width,height=Math.ceil(row.placed.height*zoom)
  const options={pageId:descriptor.pageId,width,height,view:{x:width/2-(row.placed.x+row.placed.width/2)*zoom,y:height/2-(row.placed.y+row.placed.height/2)*zoom,zoom},rasterProfile:'figmaSubpixel',transparent:false}
  const reply=await worker.request({lane:'canvas',method:'render_png',args:[JSON.stringify(options)]})
  if(reply.error)throw Error(reply.error)
  const bytes=Buffer.from(reply.value);if(reference)assert.deepEqual(bytes,reference);else reference=bytes
  await fs.writeFile(path.join(out,`${label}-native.png`),bytes)
  result.runs.push({label,loadMs,pixelsEqual:true,pngSha256:hash(bytes),productSha256:hash(await fs.readFile(bin)),identity:loaded.value,options})
  await fs.writeFile(path.join(out,'native-pixels.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result.runs.at(-1)))
 }finally{await worker.close()}
}
