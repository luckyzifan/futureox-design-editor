import fs from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawn,execFileSync} from 'node:child_process'
import path from 'node:path'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'

const [binary,snapshot,output,mode='sample',pageProof='false']=process.argv.slice(2)
if(!['false','true'].includes(pageProof))throw Error('Page proof must be explicit true or false')
if(!binary||!snapshot||!output)throw Error('Usage: node profile-native.mjs BINARY SOURCE_SNAPSHOT FRESH_OUT [sample|timing]')
await fs.mkdir(output)
// The source exporter places large retained metadata before the model fields.
// Read its small trusted journal, not a 574 MB JavaScript JSON string. The
// native reader checks every inferred identity before accepting the snapshot.
const journal=JSON.parse(await fs.readFile(path.join(path.dirname(snapshot),'journal.json'),'utf8'))
const documentId=journal.owner.documentId,stageHash=createHash('sha256').update(`source-canvas:${documentId}:0`).digest('hex')
const stageId=`${stageHash.slice(0,8)}-${stageHash.slice(8,12)}-5${stageHash.slice(13,16)}-a${stageHash.slice(17,20)}-${stageHash.slice(20,32)}`
const hash=createHash('sha256');for await(const bytes of createReadStream(snapshot))hash.update(bytes)
const descriptor={path:path.resolve(snapshot),bytes:(await fs.stat(snapshot)).size,hash:hash.digest('hex'),documentId,pageId:'00000000-0000-4000-8000-000000000001',stageId,nodes:124447}
const font=path.resolve('frontend/design-client/public/fonts/NotoSansSC.ttf'),preparation=new NativePreparation(path.resolve(binary),font)
const results=[],start=performance.now()
try{
 const loaded=await preparation.loadSourceSnapshot(descriptor);if(loaded.error)throw Error(loaded.error)
 results.push({stage:'load',ms:performance.now()-start})
 const pid=Number(execFileSync('pgrep',['-P',String(process.pid)],{encoding:'utf8'}).trim().split('\n')[0])
 const optionsFor=scale=>{const left=Math.floor((878*scale-800)/512)*512-1,top=Math.floor((278*scale-600)/512)*512-1;
 return {pageId:descriptor.pageId,width:1600,height:1200,view:{x:0,y:0,zoom:scale},gpuViewport:{x:Math.floor(878*scale/512)*512-1,y:Math.floor(278*scale/512)*512-1,w:514,h:514},prepareViewport:{x:left,y:top,w:Math.ceil((878*scale+800)/512)*512+1-left,h:Math.ceil((278*scale+600)/512)*512+1-top},rasterProfile:'figmaSubpixel',transparent:false,grid:false,gpuPageBackground:pageProof==='true'}};
 let sampling
 const scales=[8,19,64,32,8]
 for(let i=0;i<scales.length;i++){
  if(mode==='sample'&&i===1)sampling=spawn('/usr/bin/sample',[String(pid),'8','-file',path.join(output,'native.sample.txt')],{stdio:'ignore'})
  const at=performance.now(),reply=await preparation.request({lane:'canvas',method:'compile_gpu_packet',args:[JSON.stringify(optionsFor(scales[i]))]})
  results.push({stage:'compile',scale:scales[i],index:i,ms:performance.now()-at,error:reply.error,bytes:reply.value?.byteLength,compileStats:reply.compileStats})
  if(reply.value?.byteLength)await fs.writeFile(path.join(output,`packet-${i}.fgsc`),reply.value)

  console.log(JSON.stringify(results.at(-1)))
 }
 if(sampling&&sampling.exitCode===null)await new Promise(resolve=>sampling.once('close',resolve))
}finally{await preparation.close();await fs.writeFile(path.join(output,'report.json'),JSON.stringify({descriptor,mode,pageProof:pageProof==='true',results},null,2))}
