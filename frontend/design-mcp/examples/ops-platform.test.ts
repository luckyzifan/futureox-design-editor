import { expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync, gunzipSync, strFromU8 } from 'fflate'
// @ts-expect-error Installed XML host, no browser or layout rendering.
import { JSDOM } from 'jsdom'
import { blank, defaultTextStyle, paint, validateDocument, type DesignDocument } from '../../design-client/src/model'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { VectorEngine } from '../../design-client/src/generated/design-kernel/design_kernel'
import { importSvg } from '../../design-client/src/import-svg'
import { connect, sha256, type Json } from './ai-generation-client'
import { composeOps } from './ops-platform-design'

it('generates a management platform and analytics wall through real MCP and verifies exported carriers', async () => {
  const destination = process.env.FUTUREOX_OPS_GENERATION_DIR
  if (!destination || !path.isAbsolute(destination)) throw new Error('Set absolute FUTUREOX_OPS_GENERATION_DIR')
  const save = async (file: string, value: any) => { const target = path.join(destination, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)) }
  const client = await connect(blank('Futureox Ops / management platform and analytics wall'))
  const clients = [client], host = new JSDOM('')
  vi.stubGlobal('DOMParser', host.window.DOMParser); vi.stubGlobal('document', host.window.document)
  const checks: Json[] = [], outputs: Json[] = [], reimports: Json[] = []
  try {
    const font = await readFile(new URL('../../design-client/public/fonts/NotoSansSC.ttf', import.meta.url))
    await client.mutate('font.import', { id: 'ops-noto', data: font.toString('base64'), embeddingAllowed: true })
    expect((await client.read('font.validate')).result.valid).toBe(true)
    const plan = composeOps(client.editor.state.page)
    await save('authored-operations.json', plan.operations)
    for (let i = 0; i < plan.operations.length; i += 200) await client.mutate('batch.apply', { operations: plan.operations.slice(i, i+200), label: `Compose Ops ${i+1}-${Math.min(i+200,plan.operations.length)}` })
    expect(client.editor.state.doc.pages.map(p=>p.name)).toEqual(plan.names)
    expect(Object.keys(client.editor.state.doc.nodes)).toHaveLength(plan.designedNodeCount)
    await client.mutate('style.create', { id:'ops-body', name:'Ops / body', kind:'text', value:{...defaultTextStyle(),fontId:'ops-noto',weight:400,lineHeight:1.25} })
    await client.mutate('style.create', { id:'ops-accent', name:'Ops / translucent accent', kind:'paint', value:[{...paint('#68def1'),opacity:0.5}] })
    await client.mutate('style.apply', { nodeId:plan.refs.title, field:'textStyle', styleId:'ops-body' })
    await client.mutate('style.apply', { nodeId:plan.refs.alpha, field:'fills', styleId:'ops-accent' })
    const made = await client.mutate('component.create',{nodeIds:[plan.refs.badge],pageId:plan.pages[1],name:'Status / Active'})
    const componentId = made.structuredContent.result.operations[0].result.id
    await client.mutate('component.instantiate',{componentId,pageId:plan.pages[1],parentId:plan.roots[1],x:1298,y:169})
    const beforeEdit=client.editor.state.doc
    await client.mutate('text.set',{ids:[plan.refs.title],text:'October performance · 2026'})
    expect(Object.keys(beforeEdit.nodes).filter(id=>JSON.stringify(beforeEdit.nodes[id])!==JSON.stringify(client.editor.state.doc.nodes[id]))).toEqual([plan.refs.title])
    await client.mutate('history.undo',{});expect(client.editor.state.doc.nodes[plan.refs.title].text).toBe('October performance')
    await client.mutate('history.redo',{});expect(client.editor.state.doc.nodes[plan.refs.title].text).toBe('October performance · 2026')
    const source=client.editor.state.doc
    await save('node-references.json',{pages:plan.pages,roots:plan.roots,refs:plan.refs,componentId})
    await save('fonts/NotoSansSC.ttf',font)
    await copyFile(new URL('../../design-client/public/fonts/OFL.txt',import.meta.url),path.join(destination,'fonts/OFL.txt'))
    await copyFile(new URL('../../design-client/public/fonts/source.json',import.meta.url),path.join(destination,'fonts/source.json'))
    for(const [i,pageId] of plan.pages.entries()) {
      const name=plan.names[i].toLowerCase().replaceAll(' ','-'), nodeIds=[plan.roots[i]]
      const context=(await client.read('context.get',{pageId,nodeIds,limit:500,maxDepth:64})).result
      expect(context.pagination.nextCursor).toBeNull()
      const check=(await client.read('design.check',{pageId,nodeIds,limit:500,maxDepth:64})).result
      expect(check.complete).toBe(true); expect(check.issues,JSON.stringify(check.issues)).toHaveLength(0)
      checks.push({name,...check});await save(`${name}/context.json`,context)
      const vector=(await client.read('vector.export',{pageId,nodeIds,maxNodes:500})).result
      expect(vector.content).toContain('<svg');expect(vector.content).toContain('<path')
      await save(`${name}/design.svg`,vector.content)
      const code=(await client.read('code.export',{pageId,nodeIds,maxNodes:500})).result
      await save(`${name}/index.html`,code.html);await save(`${name}/styles.css`,code.css)
      await save(`${name}/export-metadata.json`,{vector:{...vector,content:undefined},code:{...code,html:undefined,css:undefined}})
      // Native software renderer, not a SVG/browser rasterizer or GPU screenshot.
      const engine=new VectorEngine(), width=i===4?960:720,height=i===4?540:500
      try {engine.load_document(JSON.stringify(source));const rgba=engine.render_rgba(JSON.stringify({pageId,width,height,view:{x:0,y:0,zoom:0.5},transparent:false,grid:false,rasterProfile:'analytic'})).slice();expect(rgba.length).toBe(width*height*4);await save(`${name}/native-cpu.rgba`,Buffer.from(rgba));await save(`${name}/native-cpu.json`,{width,height,renderer:'Actual repository VectorEngine.render_rgba / analytic CPU',sha256:sha256(rgba),gpu:false,browser:false})}finally{engine.free()}
      const restored=importSvg(vector.content,plan.names[i]+' SVG reimport');validateDocument(restored.document)
      expect(Object.keys(restored.document.nodes).length).toBeGreaterThan(0)
      const svgClient=await connect(blank('SVG append verification'));clients.push(svgClient)
      const appended=await svgClient.mutate('svg.import',{format:'svg',content:vector.content,name:plan.names[i]+' SVG reimport'})
      expect(appended.isError).toBe(false)
      const textCount=Object.values(restored.document.nodes).filter(n=>n.kind==='text').length
      reimports.push({format:'svg',name,path:'Actual MCP svg.import → shared importSvg XML/vector parser → native append → Editor/WASM',sourceNodes:context.nodes.length,importedNodes:Object.keys(restored.document.nodes).length,editableTextNodes:textCount,warnings:restored.warnings,losses:['Native SVG export outlines text; text content and font editability are not retained.','Components, shared styles, interactions, and native page structure are not represented as equivalent SVG semantics.']})
      await save(`${name}/svg-reimport-transcript.json`,svgClient.transcript); await svgClient.close();clients.pop()
      outputs.push({name,pageId,nodeCount:context.nodes.length,width:i===4?1920:1440,height:i===4?1080:1000,svgSha256:sha256(vector.content),svgBytes:Buffer.byteLength(vector.content)})
    }
    const compressed=(await client.read('vector.export',{pageId:plan.pages[4],nodeIds:[plan.refs.alpha],precision:3,scale:2,compression:'gzip'})).result
    const svgzBytes=Buffer.from(compressed.base64,'base64');expect(svgzBytes[0]).toBe(0x1f);expect(svgzBytes[1]).toBe(0x8b)
    expect(strFromU8(gunzipSync(svgzBytes))).toContain('<svg');await save('assets/translucent-accent.svgz',svgzBytes)
    const svgzClient=await connect(blank('SVGZ import'));clients.push(svgzClient)
    await svgzClient.mutate('svg.import',{format:'svgz',base64:compressed.base64,name:'Translucent accent'})
    expect(Object.keys(svgzClient.editor.state.doc.nodes).length).toBeGreaterThan(0)
    await save('svgz-import-transcript.json',svgzClient.transcript)
    reimports.push({format:'svgz',lossless:false,options:compressed.options,precisionLossy:compressed.precisionLossy,gzipHeaderVerified:true,sharedMcpImportPassed:true})
    await save('design-checks.json',checks)
    const binary=(await client.read('document.export',{format:'fd'})).result
    const bytes=Buffer.from(binary.base64,'base64');expect(bytes.subarray(0,4).toString()).toBe('FXDK');await save('futureox-ops.fd',bytes)
    const decoded=decodeDocumentBinary(new Uint8Array(bytes)) as DesignDocument;expect(decoded).toEqual(source)
    const reopened=await connect(decoded);clients.push(reopened)
    await reopened.mutate('text.set',{ids:[plan.refs.title],text:'Reopened native FD remains editable'})
    expect(reopened.editor.state.doc.nodes[plan.refs.title].text).toBe('Reopened native FD remains editable')
    await reopened.mutate('history.undo',{});expect(reopened.editor.state.doc).toEqual(source)
    await save('fd-reopen-transcript.json',reopened.transcript)
    const fdImport=await connect(blank('FD import'));clients.push(fdImport)
    const imported=await fdImport.mutate('document.import',{format:'fd',base64:binary.base64})
    const mapping=imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(Object.keys(mapping)).toHaveLength(Object.keys(source.nodes).length)
    for(const [oldId,newId] of Object.entries(mapping)){const a=source.nodes[oldId],b=fdImport.editor.state.doc.nodes[newId as string];expect(b.text).toBe(a.text);expect(b.kind).toBe(a.kind);expect(b.children).toEqual(a.children.map(id=>mapping[id]));expect(b.width).toBe(a.width);expect(b.height).toBe(a.height)}
    await save('fd-import-transcript.json',fdImport.transcript)
    reimports.push({format:'fd',lossless:true,exactDecodedDocumentEquality:true,checkedNodes:Object.keys(mapping).length,editableTextUndoVerified:true,fontsAndDesignSystemEquality:true})
    const sketch=(await client.read('sketch.export')).result;const sketchBytes=Buffer.from(sketch.base64,'base64');expect(sketchBytes.subarray(0,2).toString()).toBe('PK');await save('futureox-ops.sketch',sketchBytes)
    const zip=unzipSync(sketchBytes), entries=Object.keys(zip);expect(entries).toContain('document.json');expect(entries.filter(n=>/^pages\/.+\.json$/.test(n))).toHaveLength(5)
    const sketchClient=await connect(blank('Sketch compatibility import'));clients.push(sketchClient)
    const sketchImported=await sketchClient.mutate('sketch.import',{base64:sketch.base64,name:'futureox-ops.sketch'})
    const sketchResult=sketchImported.structuredContent.result.operations[0].result
    const restoredTexts=Object.values(sketchClient.editor.state.doc.nodes).filter(n=>n.kind==='text').map(n=>n.text)
    const originalTexts=Object.values(source.nodes).filter(n=>n.kind==='text').map(n=>n.text)
    for(const text of new Set(originalTexts))expect(restoredTexts.filter(value=>value===text).length).toBeGreaterThanOrEqual(originalTexts.filter(value=>value===text).length)
    const reopenedTitle=Object.values(sketchClient.editor.state.doc.nodes).find(n=>n.text===source.nodes[plan.refs.title].text)!
    await sketchClient.mutate('text.set',{ids:[reopenedTitle.id],text:'Sketch reimport remains editable'});expect(sketchClient.editor.state.doc.nodes[reopenedTitle.id].text).toBe('Sketch reimport remains editable')
    await save('sketch-import-transcript.json',sketchClient.transcript)
    reimports.push({format:'sketch',lossless:false,zipEntries:entries,sourceTextNodes:originalTexts.length,restoredTextNodes:restoredTexts.length,allSourceTextPresent:true,targetedTextEditVerified:true,exportWarnings:sketch.warnings,importWarnings:sketchResult.warnings,fontsEmbedded:false,realSketchApplicationOpened:false})
    await save('feature-loss-report.json',reimports)
    await save('manifest.json',{title:source.name,syntheticData:true,pages:5,nodeCount:Object.keys(source.nodes).length,authoredOperations:plan.operations.length,outputs,files:{fd:{bytes:bytes.length,sha256:sha256(bytes)},sketch:{bytes:sketchBytes.length,sha256:sha256(sketchBytes)}},path:'JSON-RPC NDJSON → DesignMcpServer → OperationBackend → operation API → actual Editor/WASM',inMemoryTransport:true,externalCloud:false,gui:false,gpu:false,font:{file:'fonts/NotoSansSC.ttf',sha256:sha256(font),license:'Bundled OFL.txt, unmodified'},assertions:['Five pages and every expected authored node','Actual native CPU previews','Single-node edit and undo/redo','Shared styles and component instance','FD exact decoded equality and all-node remapped import','Sketch ZIP with five pages, every text retained and editable','Each SVG parsed by actual importer and appended via MCP']})
  } finally {await save('mcp-transcript.json',client.transcript);for(const c of clients.reverse())await c.close();host.window.close();vi.unstubAllGlobals()}
},600000)

it('audits saved carrier feature counts after actual Sketch MCP reimport', async () => {
  const destination=process.env.FUTUREOX_OPS_GENERATION_DIR!
  const source=decodeDocumentBinary(new Uint8Array(await readFile(path.join(destination,'futureox-ops.fd')))) as DesignDocument
  const client=await connect(blank('Saved carrier feature audit'))
  const features=(d:DesignDocument)=>({nodes:Object.keys(d.nodes).length,textNodes:Object.values(d.nodes).filter(n=>n.kind==='text').length,componentMasters:Object.values(d.nodes).filter(n=>n.component).length,componentInstances:Object.values(d.nodes).filter(n=>n.instance).length,sharedStyles:Object.keys(d.designSystem?.styles??{}).length,embeddedFonts:Object.values(d.fonts??{}).filter(f=>f.data).length,translucentFills:Object.values(d.nodes).flatMap(n=>n.fills).filter(p=>p.visible&&p.opacity>0&&p.opacity<1).length})
  try {
    await client.mutate('sketch.import',{base64:(await readFile(path.join(destination,'futureox-ops.sketch'))).toString('base64'),name:'futureox-ops.sketch'})
    const before=features(source),after=features(client.editor.state.doc)
    expect(after.textNodes).toBe(before.textNodes)
    expect(after.translucentFills).toBeGreaterThanOrEqual(before.translucentFills)
    const report={source:before,sketchReimport:after,notes:['Append creates a wrapper group per source page; total node counts are not an exact structural identity comparison.','Counts alone do not establish pixel equivalence or preserve arbitrary semantics.','FD exact source equality and SVG outlined-text losses are verified in the primary generator test.'],differences:Object.fromEntries(Object.entries(before).filter(([key,value])=>after[key as keyof typeof after]!==value).map(([key,value])=>[key,{source:value,sketch:after[key as keyof typeof after]}]))}
    await writeFile(path.join(destination,'carrier-feature-counts.json'),JSON.stringify(report,null,2))
    await writeFile(path.join(destination,'carrier-audit-transcript.json'),JSON.stringify(client.transcript,null,2))
  }finally{await client.close()}
},120000)
