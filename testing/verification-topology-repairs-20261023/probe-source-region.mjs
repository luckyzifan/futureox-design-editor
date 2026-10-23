import{readFileSync}from'node:fs'
import path from'node:path'
import{NativePreparation}from'../../frontend/design-desktop/src/preparation.mjs'
const fixtures=JSON.parse(readFileSync('testing/verification-topology-repairs-20261023/source-fixtures.json','utf8')).records
const item=fixtures[1],source=readFileSync(item.file,'utf8'),doc=JSON.parse(source),client=new NativePreparation(path.resolve('frontend/design-desktop/dist/bin/design-prepare'),path.resolve('frontend/design-desktop/dist/fonts/NotoSansSC.ttf'))
try{for(const[method,args]of [['warm_resources',[]],['initialize',[false]],['load_document',[source]],['compile_gpu_packet',[JSON.stringify({pageId:doc.pages[0].id,width:256,height:256,gpuViewport:{x:256,y:256,w:256,h:256},view:{x:-2200,y:250,zoom:.35},grid:false,transparent:false,rasterProfile:'figma'})]]]){console.log('start',method);const r=await client.request({lane:'canvas',method,args});console.log('result',r.error||r.compileStats||typeof r.value)}}finally{await client.close()}
