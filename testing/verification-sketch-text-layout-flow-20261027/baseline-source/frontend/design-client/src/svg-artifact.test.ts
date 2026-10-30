import { expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { blank, node, defaultTextStyle } from './model'
import { createSvgArtifact } from './svg-artifact'
// @ts-expect-error test-only dependency
import { JSDOM } from 'jsdom'
import { vi } from 'vitest'
import { importSvgArtifact } from './import-svg-artifact'
import { createDesignAutomation } from './automation/core'
import { exportExtensions } from './automation/export'
import { kernelTextLayout } from './kernel/picking'
import { Editor } from './engine'

test('large SVG artifact embeds exact bundled Chinese font through bounded lazy provider', async () => {
 const doc=blank(),text=node('text',0,0,160,60);text.text='中文可编辑';doc.nodes[text.id]=text;doc.pages[0].children=[text.id]
 const oldFont=readFileSync(new URL('../../../design-studio/crates/design-kernel/tests/fixtures/sketch-fonts/font-0.ttf',import.meta.url)).toString('base64')
 doc.schemaVersion=15;doc.fonts={old:{family:'Core Test Narrow',data:oldFont,index:0}}
 const oldText=node('text',200,0,120,40);oldText.text='AAA';oldText.textStyle={...defaultTextStyle(),fontId:'old'};doc.nodes[oldText.id]=oldText;doc.pages[0].children.push(oldText.id)
 const editor=new Editor(doc), bytes=new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url)))
 let loads=0
 try {
  const sourceBefore=JSON.stringify(doc)
  const artifact=await createSvgArtifact(doc,doc.pages[0].id,{kind:'selection',nodeIds:[text.id]},{textMode:'editable',fontMode:'embed',fontEmbeddingAllowed:true},new AbortController().signal,async()=>{loads++;return bytes})
  expect(loads).toBe(1);expect(artifact.decodedFontBytes).toBe(bytes.length);expect(artifact.blob.size).toBeGreaterThan(8*1024*1024);expect(artifact.blob.size).toBeLessThan(64*1024*1024)
  const svg=await artifact.blob.text(),match=/data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(svg)!
  expect(Buffer.from(match[1],'base64').equals(Buffer.from(bytes))).toBe(true)
  expect(svg).toContain('中文可编辑');expect(svg).toContain('@font-face');expect(JSON.stringify(doc)).toBe(sourceBefore)
  const dom=new JSDOM('');vi.stubGlobal('DOMParser',dom.window.DOMParser)
  try {
    const imported=importSvgArtifact(new Uint8Array(await artifact.blob.arrayBuffer()),'svg')
    const newText=Object.values(imported.document.nodes).find(n=>n.kind==='text')!
    expect(newText.textStyle?.fontId).toBe('__svg_bundled_default')
    const oldFontId=editor.state.doc.nodes[oldText.id].textStyle?.fontId,metrics=kernelTextLayout(editor.state.doc.nodes[oldText.id]),before=JSON.stringify(editor.state.doc)
    const api=createDesignAutomation(editor,exportExtensions)
    const result=api.execute({method:'document.import',documentId:doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version,params:{format:'native-json',content:JSON.stringify(imported.document)}})
    expect(result.ok,JSON.stringify(result)).toBe(true)
    expect(editor.state.doc.nodes[oldText.id].textStyle?.fontId).toBe(oldFontId)
    expect(editor.state.doc.fonts?.old.data).toBe(oldFont)
    expect(kernelTextLayout(editor.state.doc.nodes[oldText.id])).toEqual(metrics)
    expect(Object.values(editor.state.doc.fonts||{}).some(f=>Buffer.from(f.data,'base64').equals(Buffer.from(bytes)))).toBe(true)
    editor.undo();expect(JSON.stringify(editor.state.doc)).toBe(before)
  } finally {vi.unstubAllGlobals();dom.window.close()}
  if(process.env.SVG_LARGE_EVIDENCE) writeFileSync(process.env.SVG_LARGE_EVIDENCE,svg)
 } finally {editor.dispose()}
})
test('abort after bundled font load cannot produce an SVG artifact', async()=>{
 const doc=blank(),text=node('text');text.text='中文';doc.nodes[text.id]=text;doc.pages[0].children=[text.id]
 const controller=new AbortController()
 await expect(createSvgArtifact(doc,doc.pages[0].id,{kind:'page'},{textMode:'editable',fontMode:'embed',fontEmbeddingAllowed:true},controller.signal,async()=>{controller.abort();return new Uint8Array()})).rejects.toThrow()
})
