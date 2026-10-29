import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Sidecar} from '../../frontend/design-desktop/src/sidecar.mjs'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const root=process.cwd(),out=process.argv[2],source='/Users/Apple/Downloads/拓扑素材.sketch'
if(!out||!path.isAbsolute(out))throw Error('Fresh absolute output required')
await fs.mkdir(out)
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex')
const binary=path.join(root,'design-studio/target/desktop-dev/futureox-design-desktop-backend'),prepare=path.join(root,'design-studio/target/desktop-dev/design-prepare')
const report={source,sourceHash:await hash(source),backendHash:await hash(binary),prepareHash:await hash(prepare),stages:[],packets:[],status:'running'}
const backend=new Sidecar(binary,path.join(out,'recovery'),{timeoutMs:120000})
let preparation
const record=async()=>fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(report,null,2))
try{
 let at=performance.now();const opened=await backend.request('large.open',{path:source,documentId:randomUUID(),sessionEpoch:1})
 report.stages.push({stage:'source-open',ms:performance.now()-at});await record()
 const request={owner:opened.owner,expectedRevision:opened.revision},layout=[]
 for(let offset=0;;offset+=200){const page=await backend.request('large.canvasLayout',{...request,offset,limit:200});layout.push(...page.items);if(!page.hasMore)break}
 await fs.writeFile(path.join(out,'layout.json'),JSON.stringify(layout,null,2))
 at=performance.now();const snapshot=await backend.request('large.canvasSnapshot',request)
 report.stages.push({stage:'whole-source-snapshot',ms:performance.now()-at,roots:snapshot.roots,nodes:snapshot.nodes,bytes:snapshot.bytes});await record()
 const descriptor={path:snapshot.path,store:snapshot.store,documentId:opened.owner.documentId,pageId:snapshot.pageId,stageId:snapshot.stageId,nodes:snapshot.nodes}
 await fs.writeFile(path.join(out,'snapshot.json'),JSON.stringify(descriptor,null,2))
 preparation=new NativePreparation(prepare,path.join(root,'frontend/design-client/public/fonts/NotoSansSC.ttf'))
 at=performance.now();const loaded=await preparation.loadSourceSnapshot(descriptor);if(loaded.error)throw Error(loaded.error)
 report.stages.push({stage:'native-source-load',ms:performance.now()-at});await record()
 for(const [id,zoom]of [['10c6999a-19ed-4836-be94-46a2609309d7',4],['B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105',4],['70806B41-C915-4EB2-954C-449E746E4426',4]]){
  const item=layout.find(r=>r.id===id);if(!item)throw Error('Missing full-source layout root '+id)
  const width=256,height=192,cx=item.placed.x+item.placed.width/2,cy=item.placed.y+item.placed.height/2
  const options={pageId:snapshot.pageId,width,height,view:{x:width/2-cx*zoom,y:height/2-cy*zoom,zoom},rasterProfile:'figmaSubpixel',transparent:false,grid:false,gpuPageBackground:true}
  at=performance.now();const result=await preparation.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(options)]})
  if(result.error||!result.value?.byteLength)throw Error(result.error||'No native packet')
  const file=`packet-${report.packets.length}.fgsc`;await fs.writeFile(path.join(out,file),result.value)
  report.packets.push({file,hash:createHash('sha256').update(result.value).digest('hex'),bytes:result.value.byteLength,compileMs:performance.now()-at,root:item,options});await record();console.log('compiled',item.name)
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1}
finally{await preparation?.close();await backend.stop();report.sourceUnchanged=report.sourceHash===await hash(source);await record();console.log(JSON.stringify({status:report.status,stages:report.stages,packets:report.packets.map(p=>({name:p.root.name,bytes:p.bytes,compileMs:p.compileMs})),error:report.error}))}
