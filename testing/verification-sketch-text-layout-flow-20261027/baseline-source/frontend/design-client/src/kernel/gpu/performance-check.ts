import { KernelClient, type KernelResult } from '../client'
import { largeScene } from '../../stress-fixtures'
const button=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector('#status')!,output=document.querySelector('#results')!
const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
button.onclick=async()=>{
 button.disabled=true;output.replaceChildren();document.querySelector('#summary')!.replaceChildren();const records:unknown[]=[]
 try{
  const query=new URLSearchParams(location.search),baseline=query.has('baseline'),pan=query.has('pan');document.querySelector('#mode')!.textContent=`${baseline?'旧提交路径':'优化路径'} · ${pan?'连续平移（编译缓存应失效）':'静态重绘'}`;
  const doc=largeScene(),opts={pageId:doc.pages[0].id,width:320,height:192,view:{x:-6400,y:3200,zoom:0.0032},transparent:true,grid:false,rasterProfile:'figma' as const}
  for(const backend of ['cpu','webgpu','webgl2'] as const){
   const client=new KernelClient(),frames:KernelResult[]=[]
   try{
    for(let i=0;i<5;i++){status.textContent=`${backend} ${i+1}/5`;const options=pan?{...opts,view:{...opts.view,x:opts.view.x+(i-1)*0.125}}:opts;const r=await client.render(doc,options,false,backend,true,false,baseline?{disableSolidBatch:true,disableSceneCache:true}:undefined);r.bitmap?.close();if(r.backend!==backend)throw new Error('后端未按请求执行');frames.push(r)}
    const warm=frames.slice(1),data={backend,baseline,pan,frames:warm.map(r=>({total:r.milliseconds,compile:r.compileMs,graph:r.graphMs,finish:r.finishMs,load:r.loadMs,compileCacheHit:r.compileCacheHit,draws:r.drawCalls,submissions:r.commandSubmissions,maskHits:r.maskHits,maskRasterizations:r.maskRasterizations})),median:{total:median(warm.map(r=>r.milliseconds)),compile:median(warm.map(r=>r.compileMs)),graph:median(warm.map(r=>r.graphMs||0)),finish:median(warm.map(r=>r.finishMs||0))}}
    const rgba=frames.at(-1)!.bytes;const frameHashes=await Promise.all(frames.map(async r=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(r.bytes))),v=>v.toString(16).padStart(2,'0')).join('')));Object.assign(data,{rgbaBytes:rgba.length,rgbaSha256:frameHashes.at(-1),frameHashes});records.push(data);const row=document.querySelector<HTMLTableSectionElement>('#summary')!.insertRow();for(const value of [backend,data.median.total.toFixed(1),data.median.compile.toFixed(1),data.median.graph.toFixed(1),data.median.finish.toFixed(1),String(warm[0].drawCalls)])row.insertCell().textContent=value;const section=document.createElement('section'),h=document.createElement('h2'),pre=document.createElement('pre');h.textContent=backend;pre.textContent=JSON.stringify(data,null,2);section.append(h,pre)
    let binary='';for(let i=0;i<rgba.length;i+=32768)binary+=String.fromCharCode(...rgba.subarray(i,i+32768));const a=document.createElement('a');a.textContent=`下载 ${backend} RGBA`;a.download=`performance-${backend}.rgba`;a.href=`data:application/octet-stream;base64,${btoa(binary)}`;section.append(a);output.append(section)
   }finally{client.dispose()}
  }
  status.textContent='完成';status.setAttribute('data-results',JSON.stringify(records))
 }catch(error){status.textContent=String(error)}finally{button.disabled=false}
}
