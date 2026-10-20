import { expect,it,vi } from 'vitest'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import path from 'node:path'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { validateDocument } from '../../design-client/src/model'
import { connect,sha256 } from './ai-generation-client'
import { RealCpuWorker } from './real-cpu-worker'
it('exports one actual MCP-generated page through real CPU raster in a fresh process',async()=>{
 const dir=process.env.FUTUREOX_OPS_GENERATION_DIR!,output=process.env.FUTUREOX_OPS_RASTER_OUTPUT!,index=Number(process.env.FUTUREOX_OPS_PAGE_INDEX)
 if(!dir||!output||!path.isAbsolute(dir)||!path.isAbsolute(output)||!Number.isSafeInteger(index)||index<0||index>4)throw Error('Explicit absolute inputs/output and page index 0..4 required')
 const doc=validateDocument(decodeDocumentBinary(new Uint8Array(await readFile(path.join(dir,'futureox-ops.fd')))))
 const refs=JSON.parse(await readFile(path.join(dir,'node-references.json'),'utf8'));const client=await connect(doc,true)
 vi.stubGlobal('Worker',RealCpuWorker);vi.stubGlobal('localStorage',{getItem:()=> 'webgpu'})
 const call=async(method:string,params:Record<string,unknown>)=>{const r=await client.call(method,params,{documentId:client.editor.state.doc.id,session:client.editor.sessionGeneration});expect(r.isError,JSON.stringify(r.structuredContent.error)).toBe(false);return (await client.materialize(r)).result}
 try{
  const exported=await call('raster.export',{pageId:doc.pages[index].id,nodeIds:[refs.roots[index]],format:'png',scales:[1]})
  const f=exported.files[0],chunks:Buffer[]=[];let offset=0
  while(offset<f.bytes){const r=await call('raster.read',{artifactId:f.artifactId,offset,length:65536});chunks.push(Buffer.from(r.base64,'base64'));expect(r.nextOffset).toBeGreaterThan(offset);offset=r.nextOffset}
  const png=Buffer.concat(chunks);expect(png.subarray(1,4).toString()).toBe('PNG');expect(png.readUInt32BE(16)).toBe(index===4?1920:1440);expect(png.readUInt32BE(20)).toBe(index===4?1080:1000)
  await mkdir(output,{recursive:true});await writeFile(path.join(output,`page-${index}.png`),png)
  await writeFile(path.join(output,`page-${index}.json`),JSON.stringify({page:index,name:doc.pages[index].name,kernel:process.env.FUTUREOX_EXPECT_KERNEL_SHA256,sha256:sha256(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20),bytes:png.length,path:'MCP raster.export/read; real Rust CPU; in-process Worker transport; no GPU or GUI'},null,2))
  await call('raster.release',{artifactId:f.artifactId})
 }finally{await writeFile(path.join(output,`page-${index}-transcript.json`),JSON.stringify(client.transcript,null,2));await client.close();vi.unstubAllGlobals()}
},180000)
