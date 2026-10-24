import {test,expect} from '../../frontend/design-client/node_modules/vitest/dist/index.js'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {importFig} from '../../frontend/design-client/src/import-fig'
import {Editor} from '../../frontend/design-client/src/engine'
import {ResidentDocumentEncoder} from '../../frontend/design-client/src/resident-document-encoder'
import {forma_encode_json,forma_decode_json} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {NativePreparation} from '../../frontend/design-desktop/src/preparation.mjs'
test('real downloaded FIG preserves property edits, history and full FD bytes with a resident native codec',async()=>{
 const file=process.env.REAL_FIG_INPUT;if(!file)throw Error('REAL_FIG_INPUT required for this explicit local regression')
 const bytes=readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex'),started=performance.now(),result=importFig(new Uint8Array(bytes),'Actual FIG regression')
 const importedMs=performance.now()-started,editor=new Editor(result.document),codec=new NativePreparation(undefined,undefined,true),requests:any[]=[]
 const encoder=new ResidentDocumentEncoder(async request=>{requests.push({install:request.install,bytes:Buffer.byteLength(JSON.stringify(request)),nodes:request.nodes.length});const response=await codec.request({lane:'canvas',method:'serialize_delta',args:[request]});if(response.error)throw Error(response.error);return response.value})
 try{
  const before=editor.authoredDocument,baseline=await encoder.encode(before),target=Object.values(before.nodes).find(n=>n.visible&&!n.instanceOrigin&&!n.instance&&!n.component&&n.kind==='rectangle')
  if(!target)throw Error('No ordinary rectangle in real fixture')
  const at=performance.now();editor.updateProperties([target.id],{opacity:target.opacity===.875?.75:.875});const editedMs=performance.now()-at
  expect(editor.state.version).toBe(1);const changed=editor.authoredDocument,saved=await encoder.encode(changed);expect(saved).toBe(JSON.stringify(changed));expect(saved).not.toBe(baseline)
  editor.undo();expect(await encoder.encode(editor.authoredDocument)).toBe(baseline)
  editor.redo();expect(await encoder.encode(editor.authoredDocument)).toBe(saved)
  const fd=forma_encode_json(saved),reopened=forma_decode_json(fd);expect(JSON.parse(reopened)).toEqual(changed)
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha256)
  writeFileSync(new URL('./actual-fig-results.json',import.meta.url),JSON.stringify({status:'passed',scope:'actual FIG bytes; actual Editor/Rust/WASM history and FD codec; actual Node worker admission. No GUI/GPU or physical-presentation claim.',file,sha256,bytes:bytes.length,nodes:Object.keys(before.nodes).length,pages:before.pages.length,warnings:result.warnings,importedMs,editedMs,requests,fdBytes:fd.length},null,2))
 }finally{editor.dispose();await codec.close()}
})
test('inspect real FIG geometry rejection',async()=>{
 const {decodeFig}=await import('../../frontend/design-client/src/import-fig')
 const {decode_fig_network_json}=await import('../../frontend/design-client/src/generated/design-kernel/design_kernel')
 const {data}=decodeFig(new Uint8Array(readFileSync(process.env.REAL_FIG_INPUT!))),records=new Map<string,any>()
 for(const n of data.nodeChanges||[]){const id=JSON.stringify(n.guid);if(n.phase==='REMOVED')records.delete(id);else records.set(id,{...records.get(id),...n})}
 const blobs:Record<string,string>={}
 for(const r of records.values())if(!r.internalOnly&&r.vectorData?.vectorNetworkBlob!==undefined){const i=r.vectorData.vectorNetworkBlob;blobs[String(i)]=Buffer.from(data.blobs[i].bytes).toString('base64')}
 writeFileSync(new URL('./fig-networks.json',import.meta.url),JSON.stringify(blobs))
 const errors:any[]=[]
 for(const r of records.values()){
  if(r.internalOnly||r.vectorData?.vectorNetworkBlob===undefined)continue
  const bytes=data.blobs[r.vectorData.vectorNetworkBlob].bytes
  try{decode_fig_network_json(bytes,1,1)}catch(error){
   errors.push({guid:r.guid,name:r.name,type:r.type,size:r.size,vectorData:r.vectorData,fillGeometry:r.fillGeometry,strokeGeometry:r.strokeGeometry,error:String(error)})
   if(errors.length===1)writeFileSync(new URL('./fig-rejected-network.bin',import.meta.url),bytes)
   if(errors.length>=8)break
  }
 }
 writeFileSync(new URL('./fig-rejected-networks.json',import.meta.url),JSON.stringify(errors,null,2));console.log(JSON.stringify(errors.map(r=>({guid:r.guid,name:r.name,error:r.error}))))
})
