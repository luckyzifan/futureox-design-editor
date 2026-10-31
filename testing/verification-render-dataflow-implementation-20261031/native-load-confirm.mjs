import fs from 'node:fs/promises'
import path from 'node:path'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const root=process.cwd(),out=path.resolve('testing/verification-render-dataflow-implementation-20261031')
const prior=path.resolve('testing/verification-source-work-reuse-20261031')
const descriptor=JSON.parse(await fs.readFile(path.join(prior,'baseline-1/snapshot.json'),'utf8'))
const result={scope:'Additional fresh-process native-load group after both products have already launched; warm OS cache. Initial pixel/load group remains separately recorded.',runs:[]}
for(const label of ['baseline','candidate','candidate','baseline']){
 const bin=label==='baseline'?path.join(prior,'selected-bin/design-prepare'):path.join(root,'design-studio/target/release/design-prepare')
 const worker=new NativePreparation(bin,path.join(root,'frontend/design-client/public/fonts/NotoSansSC.ttf'))
 try{const start=performance.now(),reply=await worker.loadSourceSnapshot(descriptor)
  if(reply.error)throw Error(reply.error)
  if(reply.value.nodes!==124447)throw Error('Incomplete source identity')
  result.runs.push({label,loadMs:performance.now()-start,nodes:reply.value.nodes})
  await fs.writeFile(path.join(out,'native-load-confirm.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result.runs.at(-1)))
 }finally{await worker.close()}
}
