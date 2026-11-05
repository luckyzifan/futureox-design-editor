// Runs on a dedicated worker. Bounds are checked again here before reading
// any file. The Electron main process never loops over the sampled pixels.
import {openSync,closeSync,readSync,fstatSync} from 'node:fs'
import {parentPort} from 'node:worker_threads'
export function readBitmapSamples(file,iw,ih,body,pairs=false){
 const src=Buffer.from(body);if(src.length<16||src.length%4||src.length>65544)throw Error('Invalid sample indices')
 const w=src.readUInt32LE(0),h=src.readUInt32LE(4)
 if(!w||!h||w*h>524288||src.length!==(2+(pairs?2*w*h:w+h))*4||!Number.isSafeInteger(iw*ih*4)||iw*4>1024*1024)throw Error('Invalid sample extent')
 const read=(i,max)=>{const v=src.readUInt32LE(8+i*4);if(v>=max)throw Error('Invalid source coordinate');return v}
 const fd=openSync(file,'r')
 try{
  if(fstatSync(fd).size!==iw*ih*4)throw Error('Incomplete source image')
  const readAt=(row,at)=>{let used=0;while(used<row.length){const count=readSync(fd,row,used,row.length-used,at+used);if(!count)throw Error('Truncated source row');used+=count}}
  const data=new Uint8Array(w*h*(pairs?16:4)),out=new Uint32Array(data.buffer)
  if(pairs){
   const jobs=new Map()
   for(let i=0;i<w*h;i++){
    const x=read(2*i,iw),y=read(2*i+1,ih),dst=Math.floor(i/w)*4*w+2*(i%w)
    for(let dy=0;dy<2;dy++){const sy=Math.min(ih-1,y+dy),a=jobs.get(sy)??[];a.push(x,dst+dy*2*w);jobs.set(sy,a)}
   }
   const row=Buffer.allocUnsafe(iw*4)
   for(const [y,a] of jobs){readAt(row,y*row.length);for(let j=0;j<a.length;j+=2){
    out[a[j+1]]=row.readUInt32LE(a[j]*4);out[a[j+1]+1]=row.readUInt32LE(Math.min(a[j]+1,iw-1)*4)
   }}
  }else{
   const xs=Array.from({length:w},(_,i)=>read(i,iw)),ys=Array.from({length:h},(_,i)=>read(i+w,ih))
   const min=Math.min(...xs),max=Math.max(...xs),row=Buffer.allocUnsafe((max-min+1)*4)
   let last=-1
   for(let y=0;y<h;y++){if(last!==ys[y]){readAt(row,(ys[y]*iw+min)*4);last=ys[y]}
    for(let x=0;x<w;x++)out[y*w+x]=row.readUInt32LE((xs[x]-min)*4)}
  }
  return data
 }finally{closeSync(fd)}
}
parentPort?.on('message',({id,file,iw,ih,body,pairs})=>{
 try{const bytes=readBitmapSamples(file,iw,ih,body,pairs);parentPort.postMessage({id,buffer:bytes.buffer},[bytes.buffer])}
 catch{parentPort.postMessage({id,error:true})}
})
