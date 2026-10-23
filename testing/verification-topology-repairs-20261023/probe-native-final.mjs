import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
const plan=JSON.parse(readFileSync(new URL('../analysis-topology-render-causes-20261023/probe-plan.json',import.meta.url),'utf8'))
const dir=path.dirname(plan.privateCopy),source=readFileSync(path.join(dir,'prepared-before.json'),'utf8'),patch=readFileSync(path.join(dir,'instance-patch.json'),'utf8'),doc=JSON.parse(source)
const binary=path.resolve('frontend/design-desktop/dist/bin/design-prepare'),font=path.resolve('frontend/design-desktop/dist/fonts/NotoSansSC.ttf')
const client=new NativePreparation(binary,font),results=[]
async function invoke(label,method,args){const at=performance.now();const reply=await client.request({lane:'canvas',method,args});if(reply.error)throw Error(reply.error);results.push({label,method,ms:performance.now()-at,replyBytes:ArrayBuffer.isView(reply.value)?reply.value.byteLength:undefined,packetSha256:ArrayBuffer.isView(reply.value)?createHash('sha256').update(reply.value).digest('hex'):undefined,compileStats:reply.compileStats,...(method==='apply_document_patch_with_damage'?{damage:JSON.parse(reply.value)}:{})});return reply}
const view={x:-939.1668676334866,y:-90.54515827367436,zoom:.46712055421073106},options=JSON.stringify({pageId:doc.pages.find(p=>p.children.length)?.id,width:963,height:799,view,grid:false,transparent:false,rasterProfile:'figma'})
try{
 await invoke('warm','warm_resources',[]);await invoke('initialize','initialize',[false]);await invoke('load','load_document',[source]);
 await invoke('compile-before','compile_gpu_packet',[options]);await invoke('patch-instance-width','apply_document_patch_with_damage',[patch]);await invoke('compile-after','compile_gpu_packet',[options]);await invoke('same-camera-repeat','compile_gpu_packet',[options]);
 writeFileSync(new URL('./native-probe-final.json',import.meta.url),JSON.stringify({scope:'CPU isolated: production Node worker and Rust design-prepare; no GPU execution; timings under concurrent system activity, no benchmark acceptance',inputSourceCodeUnits:source.length,inputSha256:plan.inputSha256,preparedSha256:createHash('sha256').update(source).digest('hex'),patchBytes:Buffer.byteLength(patch),nativeSha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),results},null,2)+'\n');console.log(JSON.stringify(results))
}finally{await client.close()}
