import assert from'node:assert/strict'
import{readFile,writeFile}from'node:fs/promises'
import{createHash}from'node:crypto'
import{pathToFileURL}from'node:url'
const root=process.cwd(),out=root+'/testing/verification-drag-response-20261024',runtime='/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/drag-response-20261024-6lnpejll'
const oldPath=runtime+'/pre-hash-wasm',newPath=root+'/frontend/design-client/src/generated/design-kernel'
const old=await import(pathToFileURL(oldPath+'/design_kernel.js')),next=await import(pathToFileURL(newPath+'/design_kernel.js'))
const hashes={};for(const[label,api,dir]of [['reference',old,oldPath],['candidate',next,newPath]]){const bytes=await readFile(dir+'/design_kernel_bg.wasm');api.initSync({module:bytes});hashes[label]=createHash('sha256').update(bytes).digest('hex')}
const font=new Uint8Array(await readFile(root+'/frontend/design-client/public/fonts/NotoSansSC.ttf'))
const fixtures=[['117',runtime+'/117-operations-opaque-native-1/original.json'],['fig','/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/heavy-motion-20261024-hjpt7asv/fig-combined-1/original.json'],['controls','/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/topology-cause-probe-gllbs6sk/controls-scene.json']]
const report={scope:'real previous/current WASM packet bytes, not GPU or GUI acceptance',hashes,cases:[]}
function ids(packet){const v=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),start=((24+v.getUint32(8,true)+3)&~3)+4*(v.getUint32(12,true)+v.getUint32(16,true)),result=[];let at=start;while(at<packet.length){result.push(v.getUint32(at,true));at+=9+v.getUint32(at+5,true)}assert.equal(at,packet.length);return result}
function ranges(values){const result=[];for(const n of [...values].sort((a,b)=>a-b)){const last=result.at(-1);if(last&&n===last[1]+1)last[1]=n;else result.push([n,n])}return result}
for(const[name,path]of fixtures){
 const json=await readFile(path,'utf8'),doc=JSON.parse(json),engines=[new old.VectorEngine(),new next.VectorEngine()],known=new Set(),scope='byte-oracle/'+name
 try{
  for(const e of engines){e.load_font(font);e.load_document(json);e.bind_frame_scene_scope(scope)}
  for(const [iteration,view]of [{x:0,y:0,zoom:1},{x:0,y:0,zoom:1},{x:13.25,y:-2.5,zoom:1},{x:13.25,y:-2.5,zoom:1},{x:3.5,y:1.25,zoom:2.5751186999430833}].entries()){
   const options=JSON.stringify({pageId:doc.pages[0].id,width:514,height:514,view,rasterProfile:name==='fig'?'analytic':'figmaSubpixel',frameResources:{scope,ranges:ranges(known)}})
   const packets=engines.map(e=>e.compile_gpu_packet(options));assert.deepEqual(packets[1],packets[0],`${name} ${iteration} packet bytes`)
   for(const id of ids(packets[0]))known.add(id)
   report.cases.push({name,iteration,bytes:packets[0].length,resourceIds:known.size,sha256:createHash('sha256').update(packets[0]).digest('hex')})
  }
 }finally{for(const e of engines)e.free()}
}
report.status='passed';await writeFile(out+'/frame-hash-packet-bytes-1.json',JSON.stringify(report,null,2));console.log(report.status,report.cases.length)
