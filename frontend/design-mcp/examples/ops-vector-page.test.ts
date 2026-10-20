import { expect,it,vi } from 'vitest'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
// @ts-expect-error Installed XML host; no browser rendering.
import { JSDOM } from 'jsdom'
import { blank,validateDocument } from '../../design-client/src/model'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect,sha256,type Json } from './ai-generation-client'
it('exports and reimports one actual MCP page as outline SVG, editable SVG and SVGZ',async()=>{
 const dir=process.env.FUTUREOX_OPS_GENERATION_DIR!,output=process.env.FUTUREOX_OPS_VECTOR_OUTPUT!,index=Number(process.env.FUTUREOX_OPS_PAGE_INDEX)
 if(!dir||!output||!path.isAbsolute(dir)||!path.isAbsolute(output)||!Number.isSafeInteger(index)||index<0||index>4||!process.env.FUTUREOX_EXPECT_KERNEL_SHA256)throw Error('Absolute input/output, explicit kernel hash and page index 0..4 required')
 const fd=await readFile(path.join(dir,'futureox-ops.fd')),doc=validateDocument(decodeDocumentBinary(new Uint8Array(fd)))
 const refs=JSON.parse(await readFile(path.join(dir,'node-references.json'),'utf8')),origin=await connect(doc)
 const host=new JSDOM('');vi.stubGlobal('DOMParser',host.window.DOMParser);vi.stubGlobal('document',host.window.document)
 await mkdir(output,{recursive:true})
 const save=async(name:string,data:string|Buffer|Json)=>writeFile(path.join(output,name),typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data,null,2))
 const report:Json={page:index,name:doc.pages[index].name,kernelWasmSha256:process.env.FUTUREOX_EXPECT_KERNEL_SHA256,sourceFdSha256:sha256(fd),path:'Actual NDJSON MCP → OperationBackend → Editor/WASM; XML host only; no GUI/GPU',modes:[]}
 const params={pageId:doc.pages[index].id,nodeIds:[refs.roots[index]]};let editable=''
 try{
  for(const textMode of ['outlines','editable']){
   const exported=(await origin.read('vector.export',{...params,textMode})).result
   const filename=textMode==='outlines'?'visual-outline.svg':'editable-text.svg';await save(filename,exported.content)
   if(textMode==='outlines')await save('design.svg',exported.content);else editable=exported.content
   const imported=await connect(blank(`${doc.pages[index].name} ${textMode}`))
   try{
    const result=await imported.mutate('svg.import',{format:'svg',content:exported.content,name:doc.pages[index].name})
    const texts=Object.values(imported.editor.state.doc.nodes).filter(n=>n.kind==='text')
    expect(texts.length).toBe(textMode==='outlines'?0:[52,72,50,38,53][index])
    if(textMode==='editable'){const original=texts[0].text;await imported.mutate('text.set',{ids:[texts[0].id],text:'Verified editable vector text'});expect(imported.editor.state.doc.nodes[texts[0].id].text).toBe('Verified editable vector text');await imported.mutate('history.undo',{});expect(imported.editor.state.doc.nodes[texts[0].id].text).toBe(original)}
    report.modes.push({textMode,file:filename,sha256:sha256(exported.content),editableTextNodes:texts.length,textEditUndo:textMode==='editable',exportWarnings:exported.warnings,importWarnings:result.structuredContent.result.operations[0].result.warnings})
   }finally{await save(`${textMode}-import-transcript.json`,imported.transcript);await imported.close()}
  }
  const compressed=(await origin.read('vector.export',{...params,textMode:'editable',compression:'gzip'})).result,svgz=Buffer.from(compressed.base64,'base64')
  expect(gunzipSync(svgz).toString()).toBe(editable);await save('editable-text.svgz',svgz)
  const imported=await connect(blank(`${doc.pages[index].name} SVGZ`))
  try{const result=await imported.mutate('svg.import',{format:'svgz',base64:compressed.base64,name:doc.pages[index].name});const count=Object.values(imported.editor.state.doc.nodes).filter(n=>n.kind==='text').length;expect(count).toBe([52,72,50,38,53][index]);report.svgz={file:'editable-text.svgz',sha256:sha256(svgz),decompressedMatchesEditableSvg:true,editableTextNodes:count,exportWarnings:compressed.warnings,importWarnings:result.structuredContent.result.operations[0].result.warnings}}finally{await save('svgz-import-transcript.json',imported.transcript);await imported.close()}
  report.complete=true
 }finally{await save('vector-report.json',report);await save('vector-export-transcript.json',origin.transcript);await origin.close();host.window.close();vi.unstubAllGlobals()}
},180000)
