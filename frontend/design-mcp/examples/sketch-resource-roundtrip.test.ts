import { expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { blank, type DesignDocument } from '../../design-client/src/model'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect, sha256 } from './ai-generation-client'

it('retains real Ops shared resources through MCP export/import and live style edit/undo', async () => {
  const input = process.env.FUTUREOX_OPS_SOURCE_DIR!, output = process.env.SKETCH_RESOURCE_EVIDENCE!
  if (!path.isAbsolute(input) || !path.isAbsolute(output)) throw new Error('Absolute input/output directories required')
  await mkdir(output,{recursive:true})
  const source = decodeDocumentBinary(new Uint8Array(await readFile(path.join(input,'futureox-ops.fd')))) as DesignDocument
  const origin = await connect(source), target = await connect(blank('Ops Sketch resource retest'))
  try {
    const exported = (await origin.read('sketch.export')).result
    const bytes = Buffer.from(exported.base64,'base64'), zip = unzipSync(bytes)
    const native = JSON.parse(new TextDecoder().decode(zip['document.json']))
    expect(native.layerStyles.objects).toHaveLength(1); expect(native.layerTextStyles.objects).toHaveLength(1)
    expect(native.layerTextStyles._class).toBe('sharedTextStyleContainer')
    for (const style of [...native.layerStyles.objects,...native.layerTextStyles.objects]) {
      expect(style._class).toBe('sharedStyle'); expect(style.value._class).toBe('style'); expect(style.style).toBeUndefined()
    }
    await writeFile(path.join(output,'futureox-ops-resources.sketch'),bytes)
    const response = await target.mutate('sketch.import',{base64:exported.base64,name:'futureox-ops-resources.sketch'})
    const result = response.structuredContent.result.operations[0].result
    const restored = target.editor.state.doc
    expect(Object.keys(restored.designSystem?.styles??{})).toHaveLength(2)
    expect(Object.keys(restored.fonts??{})).toHaveLength(Object.keys(source.fonts??{}).length)
    expect(Object.values(restored.nodes).filter(n=>n.kind==='text')).toHaveLength(265)
    expect(Object.values(restored.nodes).filter(n=>n.component)).toHaveLength(1)
    expect(Object.values(restored.nodes).filter(n=>n.instance)).toHaveLength(1)
    const styleChecks=[]
    for (const [oldId,style] of Object.entries(source.designSystem!.styles)) {
      const [id,back] = Object.entries(restored.designSystem!.styles).find(([,s])=>s.name===style.name)!
      expect(back.kind).toBe(style.kind)
      const bound = Object.values(source.nodes).filter(n=>Object.values(n.styleRefs??{}).includes(oldId))
      expect(bound.length).toBeGreaterThan(0)
      for (const node of bound) {
        const imported = restored.nodes[result.nodeIdMap[node.id]]
        expect(Object.values(imported.styleRefs??{})).toContain(id)
        if (style.kind === 'paint') expect(imported.fills[0].opacity).toBe(node.fills[0].opacity)
        else {
          expect(imported.textStyle?.lineHeight).toBe(node.textStyle?.lineHeight)
          expect(imported.textStyle?.weight).toBe(node.textStyle?.weight)
        }
      }
      const snapshot = target.editor.state.doc
      const value = structuredClone(back.value) as any
      if(style.kind==='paint') value[0].color='#ff00ff'; else value.align='end'
      await target.mutate('style.update',{styleId:id,value})
      for (const node of bound) {
        const actual = target.editor.state.doc.nodes[result.nodeIdMap[node.id]]
        if(style.kind==='paint') expect(actual.fills[0].color).toBe('#ff00ff'); else expect(actual.textStyle?.align).toBe('end')
      }
      await target.mutate('history.undo',{}); expect(target.editor.state.doc).toEqual(snapshot)
      await target.mutate('history.redo',{}); await target.mutate('history.undo',{})
      styleChecks.push({name:style.name,kind:style.kind,boundNodes:bound.length,liveEdit:true,undoRedo:true})
    }
    for (const font of Object.values(source.fonts??{})) {
      const copy = Object.values(restored.fonts??{}).find(f=>f.family===font.family)!
      expect(copy.data).toBe(font.data); expect(copy.index??0).toBe(font.index??0)
    }
    const report={path:'Actual NDJSON MCP → OperationBackend → Editor/WASM → Rust Sketch codec',sourceNodes:Object.keys(source.nodes).length,
      importedNodes:Object.keys(restored.nodes).length,textNodes:265,componentMasters:1,componentInstances:1,sharedStyles:2,
      embeddedFonts:Object.keys(restored.fonts??{}).length,exactFontBytes:true,sharedFillAlphaPreserved:true,sharedTextWeightAndLineHeightPreserved:true,styleChecks,sketchSha256:sha256(bytes),nativeFontReferences:native.fontReferences?.length,
      exportWarnings:exported.warnings,importWarnings:result.warnings,realSketchApplicationOpened:false,gui:false,gpu:false}
    await writeFile(path.join(output,'mcp-resource-results.json'),JSON.stringify(report,null,2))
  } finally {
    await writeFile(path.join(output,'mcp-export-transcript.json'),JSON.stringify(origin.transcript,null,2))
    await writeFile(path.join(output,'mcp-import-edit-transcript.json'),JSON.stringify(target.transcript,null,2))
    await origin.close(); await target.close()
  }
},120000)


it('rejects duplicate shared-style identities atomically through real MCP', async () => {
  const client = await connect(blank('Duplicate identity rejection'))
  try {
    for (const mode of ['same-container','identical-definition','cross-container','two-aliases','alias-vs-wire']) {
      const style = {_class:'sharedStyle',do_objectID:'paint-id',name:'Paint',value:{_class:'style',fills:[]}}
      const document:any = {_class:'document',pages:[{_ref:'pages/p'}],
        layerStyles:{_class:'sharedStyleContainer',objects:[style]},
        layerTextStyles:{_class:'sharedTextStyleContainer',objects:[{_class:'sharedStyle',do_objectID:'text-id',name:'Text',value:{_class:'style',textStyle:{_class:'textStyle',encodedAttributes:{MSAttributedStringFontAttribute:{_class:'fontDescriptor',attributes:{name:'default',size:16}}}}}}]}}
      if (mode==='same-container'||mode==='identical-definition') document.layerStyles.objects.push({...style,name:mode==='same-container'?'Conflicting':'Paint'})
      if (mode==='cross-container') document.layerTextStyles.objects[0].do_objectID='paint-id'
      if (mode==='two-aliases') document.userInfo={'com.futureox.design-kernel':{sharedStyleIds:{'paint-id':'same','text-id':'same'}}}
      if (mode==='alias-vs-wire') document.userInfo={'com.futureox.design-kernel':{sharedStyleIds:{'paint-id':'text-id'}}}
      const bytes=zipSync({'meta.json':strToU8('{}'),'document.json':strToU8(JSON.stringify(document)),
        'pages/p.json':strToU8(JSON.stringify({_class:'page',do_objectID:'p',name:'p',layers:[]}))},{level:0})
      const before=JSON.stringify(client.editor.state.doc), revision=client.editor.state.version
      const response=await client.mutate('sketch.import',{base64:Buffer.from(bytes).toString('base64')},true)
      expect(response.isError,mode).toBe(true)
      expect(JSON.stringify(response)).toContain('duplicate')
      expect(JSON.stringify(response)).toContain('shared style')
      expect(JSON.stringify(client.editor.state.doc)).toBe(before)
      expect(client.editor.state.version).toBe(revision)
    }
    if(process.env.SKETCH_RESOURCE_EVIDENCE) await writeFile(path.join(process.env.SKETCH_RESOURCE_EVIDENCE,'duplicate-style-mcp-transcript.json'),JSON.stringify(client.transcript,null,2))
  } finally { await client.close() }
})
