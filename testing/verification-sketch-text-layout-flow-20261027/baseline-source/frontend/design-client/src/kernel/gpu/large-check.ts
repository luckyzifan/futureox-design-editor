import { KernelClient, type KernelOptions } from '../client'
import { initializePicking } from '../picking'
import { largeScene, deepScene, copiedScene, rampScene } from '../../stress-fixtures'
import { blank, node, paint } from '../../model'
import { exportImage } from '../../export'
const run=document.querySelector<HTMLButtonElement>('#run')!,status=document.querySelector('#status')!,results=document.querySelector('#results')!
const different=(a:Uint8Array,b:Uint8Array)=>{if(a.length!==b.length)throw new Error('像素数组大小不同');let pixels=0,max=0;for(let i=0;i<a.length;i+=4){let error=0;for(let c=0;c<4;c++)error=Math.max(error,Math.abs(a[i+c]-b[i+c]));if(error)pixels++;max=Math.max(max,error)}return {pixels,max}}
function pngLink(bytes:Uint8Array,name:string){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const link=document.createElement('a');link.href=`data:image/png;base64,${btoa(binary)}`;link.download=name;link.textContent=`下载 ${name}`;results.append(link);return link.href}
run.onclick=async()=>{
 run.disabled=true;results.replaceChildren();const records:unknown[]=[];let failures=0
 const record=(name:string,data:object)=>{records.push({name,...data});const s=document.createElement('section'),h=document.createElement('h2'),p=document.createElement('pre');h.textContent=name;p.textContent=JSON.stringify(data,null,2);s.append(h,p);results.append(s)}
 try{
  await initializePicking()
  const large=largeScene(),deep=deepScene(),copies=[copiedScene(large),copiedScene(deep)]
  for(const backend of ['cpu','webgpu','webgl2'] as const){
   const client=new KernelClient()
   try{
    for(const [i,doc] of [large,deep].entries()){
     status.textContent=`${backend} / ${doc.name}`
     const options:KernelOptions={pageId:doc.pages[0].id,width:i?192:320,height:192,view:i?{x:8,y:8,zoom:1}:{x:-6400,y:3200,zoom:0.0032},transparent:true,grid:false,rasterProfile:'figma'}
     const a=await client.render(doc,options,false,backend,true);a.bitmap?.close()
     if(backend!=='cpu' && i===0 && a.drawCalls>100)throw new Error('大场景未使用批量光栅化');
     if(a.backend!==backend)throw new Error(`实际后端 ${a.backend} 与请求 ${backend} 不同`)
     const copy=await client.render(copies[i],{...options,pageId:copies[i].pages[0].id,view:{...options.view,x:options.view.x-24*options.view.zoom,y:options.view.y-24*options.view.zoom}},false,backend,true);copy.bitmap?.close()
     const copyDiff=different(a.bytes,copy.bytes)
     if(copyDiff.pixels)throw new Error(`复制场景改变了 ${copyDiff.pixels} 个像素，最大 ${copyDiff.max}/255`)
     for(const zoom of i?[0.25,4,32]:[0.0064,0.0128]){
      const view=i?{x:8,y:8,zoom}:{x:-2_000_000*zoom,y:1_000_000*zoom,zoom}
      const moved=await client.render(doc,{...options,view},false,backend,true).catch(error=>{throw new Error(`缩放 ${zoom} 倍: ${error}`)});moved.bitmap?.close()
     }
     const restored=await client.render(doc,options,false,backend,true);restored.bitmap?.close()
     const restoreDiff=different(a.bytes,restored.bytes)
     if(restoreDiff.pixels)throw new Error('缩放还原后残留旧像素')
     record(`${backend} / ${doc.name}`,{passed:true,nodes:Object.keys(doc.nodes).length,copyDiff,restoreDiff,coldMs:a.milliseconds,restoreMs:restored.milliseconds,actualBackend:a.backend,peakLayerPixels:a.stats.peakLayerPixels,drawCalls:a.drawCalls,commandSubmissions:a.commandSubmissions})
     if(backend==='webgpu'){const c=document.createElement('canvas');c.width=options.width;c.height=options.height;c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(a.bytes),c.width,c.height),0,0);results.append(c)}
    }
    const ramp=rampScene(),r=await client.render(ramp,{pageId:ramp.pages[0].id,width:256,height:16,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'figma'},false,backend,true);r.bitmap?.close()
    for(let y=0;y<16;y++)for(let x=0;x<256;x++){const p=(y*256+x)*4;if(r.bytes[p]!==x||r.bytes[p+1]!==x||r.bytes[p+2]!==x||r.bytes[p+3]!==255)throw new Error(`灰阶 ${x} 未保持原值`)}
    record(`${backend} / 256 灰阶`,{passed:true,levels:256,exact:true})
   }catch(error){failures++;record(backend,{passed:false,error:String(error)})}finally{client.dispose()}
  }
  status.textContent='CPU / 大尺寸 PNG 流式导出'
  const doc=blank('large-export'),n=node('rectangle',0,0,4096,3072)
  n.fills=[paint('#4477cc','linear')];doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
  const start=performance.now(),exported=await exportImage(doc,doc.pages[0].id,'png',1),bytes=new Uint8Array(await exported.blob.arrayBuffer())
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=view.getUint32(16),height=view.getUint32(20)
  if(width!==4176||height!==3152||exported.backend!=='cpu')throw new Error('大图尺寸或软件渲染路径不正确')
  let srgb=false;for(let at=8;at+12<=bytes.length;){const len=view.getUint32(at),name=String.fromCharCode(...bytes.subarray(at+4,at+8));if(name==='sRGB')srgb=true;at+=len+12}
  if(!srgb)throw new Error('导出缺少 sRGB 色彩标记')
  const url=pngLink(bytes,'Core-large-export.png'),img=document.createElement('img');img.src=url;img.alt='大画布 PNG 导出预览';results.append(img)
  record('大尺寸 PNG 导出',{passed:true,width,height,pixels:width*height,bytes:bytes.length,srgb,backend:exported.backend,ms:performance.now()-start})
 }catch(error){failures++;record('检查中断',{passed:false,error:String(error)})}
 finally{status.textContent=`完成：${records.length} 项，${failures} 项失败`;status.setAttribute('data-results',JSON.stringify(records));run.disabled=false}
}
