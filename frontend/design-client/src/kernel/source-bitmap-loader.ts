import {sourceBitmap} from '../source-bitmap'
// Called only from the raster worker. The document, per-frame IPC and history
// retain the small immutable address; only images actually sampled are read.
declare const FileReaderSync: {new():{readAsDataURL(blob:Blob):string}}
const compressed=new Map<string,string>()
let bytes=0
export function sourceBitmapPayload(uri:string):string{
 if(!sourceBitmap(uri))return uri
 const cached=compressed.get(uri)
 if(cached){compressed.delete(uri);compressed.set(uri,cached);return cached}
 const request=new XMLHttpRequest();request.open('GET',uri,false);request.responseType='blob';request.send()
 if(request.status!==200||!(request.response instanceof Blob))throw Error('原图读取失败，请重新打开源文件')
 const data=new FileReaderSync().readAsDataURL(request.response)
 if(!data.startsWith('data:image/png;base64,'))throw Error('无效的 Sketch 图片资源')
 const limit=48*1024*1024
 if(data.length<=limit){while(bytes+data.length>limit&&compressed.size){const oldest=compressed.keys().next().value!;bytes-=compressed.get(oldest)!.length;compressed.delete(oldest)}compressed.set(uri,data);bytes+=data.length}
 return data
}
