import { expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
// @ts-expect-error Installed XML host; no browser rendering.
import { JSDOM } from 'jsdom'
import { blank, type DesignDocument } from '../../design-client/src/model'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect, sha256, type Json } from './ai-generation-client'
import { RealCpuWorker } from './real-cpu-worker'

it('refreshes the real MCP-generated Ops carriers with shared resources, dual SVG modes and MCP PNG',async()=>{
  const directory=process.env.FUTUREOX_OPS_GENERATION_DIR!
  if(!directory||!path.isAbsolute(directory))throw new Error('Absolute FUTUREOX_OPS_GENERATION_DIR required')
  const save=async(file:string,data:any)=>{const target=path.join(directory,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.isBuffer(data)||typeof data==='string'?data:JSON.stringify(data,null,2))}
  const source=decodeDocumentBinary(new Uint8Array(await readFile(path.join(directory,'futureox-ops.fd')))) as DesignDocument
  const refs=JSON.parse(await readFile(path.join(directory,'node-references.json'),'utf8'))
  const origin=await connect(source),target=await connect(blank('Ops refreshed Sketch')),raster=await connect(source,true),clients=[origin,target,raster]
  const host=new JSDOM('');vi.stubGlobal('DOMParser',host.window.DOMParser);vi.stubGlobal('document',host.window.document);vi.stubGlobal('Worker',RealCpuWorker);vi.stubGlobal('localStorage',{getItem:()=> 'webgpu'})
  const report:Json={path:'Actual NDJSON MCP → OperationBackend → Editor/WASM',kernelWasmSha256:process.env.FUTUREOX_ARTIFACT_KERNEL_SHA256??'unspecified',sourceWasPreviouslyGeneratedThroughMcp:true,gui:false,gpu:false,pages:[],styleChecks:[],geometryDifferences:[]}
  const rasterRead=async(method:string,params:Json)=>{const response=await raster.call(method,params,{documentId:raster.editor.state.doc.id,session:raster.editor.sessionGeneration});expect(response.isError,JSON.stringify(response.structuredContent.error)).toBe(false);return raster.materialize(response)}
  try {
    const native=(await origin.read('document.export',{format:'fd'})).result
    const fd=Buffer.from(native.base64,'base64');expect(decodeDocumentBinary(new Uint8Array(fd))).toEqual(source);await save('futureox-ops.fd',fd)
    const reopened=await connect(decodeDocumentBinary(new Uint8Array(fd)) as DesignDocument);clients.push(reopened)
    const textId=Object.values(source.nodes).find(n=>n.kind==='text')!.id
    await reopened.mutate('text.set',{ids:[textId],text:'Refreshed FD remains editable'});expect(reopened.editor.state.doc.nodes[textId].text).toBe('Refreshed FD remains editable');await reopened.mutate('history.undo',{});expect(reopened.editor.state.doc).toEqual(source)
    await save('refresh-fd-reopen-transcript.json',reopened.transcript);await reopened.close();clients.pop()
    const sketch=(await origin.read('sketch.export')).result,bytes=Buffer.from(sketch.base64,'base64');await save('futureox-ops.sketch',bytes)
    const response=await target.mutate('sketch.import',{base64:sketch.base64,name:'futureox-ops.sketch'}),result=response.structuredContent.result.operations[0].result
    const restored=target.editor.state.doc
    expect(Object.keys(restored.designSystem?.styles??{})).toHaveLength(2);expect(Object.keys(restored.fonts??{})).toHaveLength(1)
    for(const node of Object.values(source.nodes)) {
      const back=restored.nodes[result.nodeIdMap[node.id]];expect(back,`Mapped node ${node.id}`).toBeTruthy();expect(back.kind).toBe(node.kind);if(node.kind==='text')expect(back.text).toBe(node.text);expect(back.children).toEqual(node.children.map(id=>result.nodeIdMap[id]));if(Math.abs(back.width-node.width)>1e-6||Math.abs(back.height-node.height)>1e-6)report.geometryDifferences.push({sourceId:node.id,kind:node.kind,name:node.name,source:{width:node.width,height:node.height},restored:{width:back.width,height:back.height},sourceNode:node,restoredNode:back})
    }
    await save('refresh-geometry-check.json',{geometryDifferences:report.geometryDifferences,checkedNodes:Object.keys(source.nodes).length,checkedTexts:Object.values(source.nodes).filter(n=>n.kind==='text').length})
    expect(report.geometryDifferences).toEqual([])
    for(const node of Object.values(source.nodes)){const back=restored.nodes[result.nodeIdMap[node.id]];expect(back.width).toBeCloseTo(node.width,6);expect(back.height).toBeCloseTo(node.height,6);if(node.kind==='text')expect(back.textStyle?.wrap).toBe(node.textStyle?.wrap)}
    for(const [oldId,style] of Object.entries(source.designSystem!.styles)) {
      const [id,back]=Object.entries(restored.designSystem!.styles).find(([,s])=>s.name===style.name)!
      const bound=Object.values(source.nodes).filter(n=>Object.values(n.styleRefs??{}).includes(oldId));expect(bound.length).toBeGreaterThan(0)
      for(const n of bound)expect(Object.values(restored.nodes[result.nodeIdMap[n.id]].styleRefs??{})).toContain(id)
      const snapshot=target.editor.state.doc,value=structuredClone(back.value) as any
      if(style.kind==='paint')value[0].color='#ff00ff';else value.align='end'
      await target.mutate('style.update',{styleId:id,value})
      for(const n of bound){const actual=target.editor.state.doc.nodes[result.nodeIdMap[n.id]];if(style.kind==='paint')expect(actual.fills[0].color).toBe('#ff00ff');else expect(actual.textStyle?.align).toBe('end')}
      await target.mutate('history.undo',{});expect(target.editor.state.doc).toEqual(snapshot);await target.mutate('history.redo',{});await target.mutate('history.undo',{})
      report.styleChecks.push({name:style.name,kind:style.kind,boundNodes:bound.length,liveEdit:true,undoRedo:true})
    }
    for(const font of Object.values(source.fonts??{})){const back=Object.values(restored.fonts??{}).find(f=>f.family===font.family)!;expect(back.data).toBe(font.data)}
    report.sketch={strictGeometryRoundtripPassed:report.geometryDifferences.length===0,nodeCount:Object.keys(restored.nodes).length,textNodes:Object.values(restored.nodes).filter(n=>n.kind==='text').length,sharedStyles:2,embeddedFonts:1,exactFontBytes:true,allSourceNodesMapped:true,sha256:sha256(bytes),exportWarnings:sketch.warnings,importWarnings:result.warnings,realSketchApplicationOpened:false}
    for(const [i,page] of source.pages.entries()) {
      const name=page.name.toLowerCase().replaceAll(' ','-'),nodeIds=[refs.roots[i]],pageReport:Json={name,modes:[]}
      for(const textMode of ['outlines','editable']) {
        const exported=(await origin.read('vector.export',{pageId:page.id,nodeIds,textMode})).result
        const filename=textMode==='outlines'?'visual-outline.svg':'editable-text.svg';await save(`${name}/${filename}`,exported.content)
        if(textMode==='outlines')await save(`${name}/design.svg`,exported.content)
        const imported=await connect(blank(`${name} ${textMode} SVG`));clients.push(imported)
        const importedResult=await imported.mutate('svg.import',{format:'svg',content:exported.content,name:`${page.name} ${textMode}`})
        const textNodes=Object.values(imported.editor.state.doc.nodes).filter(n=>n.kind==='text')
        if(textMode==='outlines')expect(textNodes).toHaveLength(0);else {expect(textNodes.length).toBeGreaterThan(0);const id=textNodes[0].id;await imported.mutate('text.set',{ids:[id],text:'Editable SVG text verified'});expect(imported.editor.state.doc.nodes[id].text).toBe('Editable SVG text verified');await imported.mutate('history.undo',{})}
        pageReport.modes.push({textMode,file:filename,editableTextNodes:textNodes.length,sha256:sha256(exported.content),exportWarnings:exported.warnings,importWarnings:importedResult.structuredContent.result.operations[0].result.warnings})
        await save(`${name}/${textMode}-import-transcript.json`,imported.transcript);await imported.close();clients.pop()
      }
      const compressed=(await origin.read('vector.export',{pageId:page.id,nodeIds,textMode:'editable',compression:'gzip'})).result
      const svgz=Buffer.from(compressed.base64,'base64');expect(gunzipSync(svgz).toString()).toContain('<svg');await save(`${name}/editable-text.svgz`,svgz)
      const zclient=await connect(blank(`${name} SVGZ`));clients.push(zclient)
      await zclient.mutate('svg.import',{format:'svgz',base64:compressed.base64,name:page.name+' SVGZ'})
      const ztexts=Object.values(zclient.editor.state.doc.nodes).filter(n=>n.kind==='text');expect(ztexts.length).toBeGreaterThan(0)
      pageReport.svgz={file:'editable-text.svgz',sha256:sha256(svgz),gzipVerified:true,importedEditableTexts:ztexts.length,options:compressed.options,warnings:compressed.warnings}
      await save(`${name}/svgz-import-transcript.json`,zclient.transcript);await zclient.close();clients.pop()
      const exported=(await rasterRead('raster.export',{pageId:page.id,nodeIds,format:'png',scales:[1]})).result
      const file=exported.files[0],parts:Buffer[]=[];let offset=0
      while(offset<file.bytes){const chunk=(await rasterRead('raster.read',{artifactId:file.artifactId,offset,length:65536})).result;parts.push(Buffer.from(chunk.base64,'base64'));expect(chunk.nextOffset).toBeGreaterThan(offset);offset=chunk.nextOffset}
      const png=Buffer.concat(parts);expect(png.subarray(1,4).toString()).toBe('PNG');expect(png.readUInt32BE(16)).toBe(i===4?1920:1440);expect(png.readUInt32BE(20)).toBe(i===4?1080:1000)
      await save(`${name}/mcp-native-1x.png`,png);await rasterRead('raster.release',{artifactId:file.artifactId})
      pageReport.png={file:'mcp-native-1x.png',width:png.readUInt32BE(16),height:png.readUInt32BE(20),sha256:sha256(png),renderer:'Real Rust/WASM render_region_png via product raster.export/read and in-process Worker transport',screenshot:false};report.pages.push(pageReport)
    }
    report.fd={sha256:sha256(fd),bytes:fd.length,exactDecodedEquality:true,textEditAndUndoVerified:true}
    report.limitations=['Sketch remains a compatibility mapping, not verified in real Sketch GUI; fixed no-wrap is preserved by own metadata but may wrap in external Sketch.','Editable SVG preserves text editing but does not embed fonts; external font availability, fallback, metrics, wrapping and runs can differ.','Visual outline SVG preserves rendered glyph outlines and has no editable text semantics.','SVG does not preserve native component/shared-style semantics.','PNG is actual CPU product export, not GPU/display or app-chrome screenshot equivalence.']
    await save('refresh-report.json',report)
  }finally{await save('refresh-report.json',report);await save('refresh-export-transcript.json',origin.transcript);await save('refresh-sketch-import-transcript.json',target.transcript);await save('refresh-raster-transcript.json',raster.transcript);for(const c of clients.reverse())await c.close();host.window.close();vi.unstubAllGlobals()}
},600000)
