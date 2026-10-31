import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Real WASM layout and automation dispatch, no GPU or sockets.
// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node, defaultTextStyle, paint } from '../model'
import { createDesignAutomation } from './core'
import { exportExtensions } from './export'
import { importSvg } from '../import-svg'

test('editable SVG preserves wrapped rich text, entities, transforms and alpha; outline remains default', () => {
  const dom = new JSDOM(''); vi.stubGlobal('DOMParser',dom.window.DOMParser)
  const doc = blank(); doc.schemaVersion=15
  const text = node('text',17,23,180,130); text.text='A <&" 中文 😀\nSecond line wrapping words'; text.fontSize=24
  text.textStyle={...defaultTextStyle(),wrap:true,letterSpacing:1.25}; text.textRuns=[{start:0,end:1,fontSize:30,weight:700,color:'#ff0033',underline:true}]; text.opacity=.6; text.fills=[paint('#123456')]
  text.transform=[.9,.2,-.2,.9,17,23]; doc.nodes[text.id]=text; doc.pages[0].children=[text.id]
  const editor=new Editor(doc), api=createDesignAutomation(editor,exportExtensions)
  try {
    const outline=api.execute({method:'vector.export'}); expect(outline.ok).toBe(true)
    if(outline.ok) expect((outline.result as any).content).not.toContain('<text ')
    const result=api.execute({method:'vector.export',params:{textMode:'editable'}})
    expect(result.ok,JSON.stringify(result)).toBe(true); if(!result.ok)return
    const output=result.result as any; expect(output.options.textMode).toBe('editable'); expect(output.warnings.some((w:any)=>w.code==='SVG_EDITABLE_TEXT')).toBe(true)
    expect(output.content).toContain('<text '); expect(output.content).toContain('<tspan'); expect(output.content).toContain('&lt;&amp;&quot;'); expect(output.content).toContain('opacity="0.6"')
    const imported=importSvg(output.content);
    if(process.env.SVG_EDITABLE_EVIDENCE_DIR) { const dir=process.env.SVG_EDITABLE_EVIDENCE_DIR; mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'editable.svg'),output.content); writeFileSync(join(dir,'reimport.json'),JSON.stringify(imported,null,2)) }
    const texts=Object.values(imported.document.nodes).filter(n=>n.kind==='text')
    expect(texts).toHaveLength(1); expect(texts[0].text).toBe(text.text); expect(texts[0].textRuns).toEqual(text.textRuns); expect(texts[0].textStyle).toEqual(text.textStyle); expect(texts[0].width).toBe(text.width)
    expect(()=>importSvg(output.content.replace('<tspan','<tspan onclick="alert(1)"'))).toThrow()
    expect(()=>importSvg(output.content.replace('<tspan','<a href="javascript:alert(1)"'))).toThrow()
    expect(()=>importSvg(output.content.replace('Second','Changed'))).toThrow()
  } finally {editor.dispose();vi.unstubAllGlobals();dom.window.close()}
})

test('unsupported advanced editable text fails explicitly without changing source',()=>{
  const doc=blank();doc.schemaVersion=15;const text=node('text');text.text='safe';text.textStyle={...defaultTextStyle(),features:['-liga']};doc.nodes[text.id]=text;doc.pages[0].children=[text.id]
  const editor=new Editor(doc),api=createDesignAutomation(editor,exportExtensions)
  try {const before=JSON.stringify(editor.state.doc);const result=api.execute({method:'vector.export',params:{textMode:'editable'}});expect(result.ok).toBe(false);expect(JSON.stringify(result)).toContain('OpenType');expect(JSON.stringify(editor.state.doc)).toBe(before)}finally{editor.dispose()}
})

test.each(['', '\n\n', '  A  \n B ', 'one two three four five six seven', 'مرحبا שלום 中文 😀', 'e\u0301 & < > " \''])('editable text edge case %j roundtrips or preserves explicit limits',value=>{
  const dom=new JSDOM('');vi.stubGlobal('DOMParser',dom.window.DOMParser)
  const doc=blank();const text=node('text',0,0,80,100);text.text=value;text.textStyle={...defaultTextStyle(),wrap:true};doc.nodes[text.id]=text;doc.pages[0].children=[text.id]
  const editor=new Editor(doc),api=createDesignAutomation(editor,exportExtensions)
  try {const result=api.execute({method:'vector.export',params:{textMode:'editable'}});expect(result.ok,JSON.stringify(result)).toBe(true);if(!result.ok)return;const imported=importSvg((result.result as any).content);expect(Object.values(imported.document.nodes).find(n=>n.kind==='text')?.text).toBe(value)}finally{editor.dispose();vi.unstubAllGlobals();dom.window.close()}
})

test('editable SVG retains clipping and rejects linked text including malicious targets',()=>{
 const dom=new JSDOM('');vi.stubGlobal('DOMParser',dom.window.DOMParser)
 const doc=blank();doc.schemaVersion=15;const frame=node('frame',10,20,100,60),text=node('text',-10,5,200,30);frame.clip=true;frame.children=[text.id];text.text='clipped text';doc.nodes[frame.id]=frame;doc.nodes[text.id]=text;doc.pages[0].children=[frame.id]
 const editor=new Editor(doc),api=createDesignAutomation(editor,exportExtensions)
 try {const result=api.execute({method:'vector.export',params:{textMode:'editable'}});expect(result.ok,JSON.stringify(result)).toBe(true);if(result.ok){expect((result.result as any).content).toContain('clip-path=');const imported=importSvg((result.result as any).content);expect(Object.values(imported.document.nodes).some(n=>n.kind==='text'&&n.text==='clipped text')).toBe(true)}}finally{editor.dispose();vi.unstubAllGlobals();dom.window.close()}
 for(const link of ['https://example.com','javascript:alert(1)','data:text/html,test']) {text.textRuns=[{start:0,end:7,link}];const editor=new Editor(doc),api=createDesignAutomation(editor,exportExtensions);try{const result=api.execute({method:'vector.export',params:{textMode:'editable'}});expect(result.ok).toBe(false);if(link.startsWith('https:')) expect(JSON.stringify(result)).toContain('links')}finally{editor.dispose()}}
})


test('owned editable text charges descendants to the shared SVG depth and node budgets', () => {
  const dom = new JSDOM(''); vi.stubGlobal('DOMParser', dom.window.DOMParser)
  const model = JSON.stringify({ text: 'X', fontSize: 16, width: 80, height: 30 }).replace(/"/g, '&quot;')
  const text = (children: string) => `<text data-editable-text="1" data-text-model="${model}">${children}</text>`
  const svg = (children: string) => `<svg xmlns="http://www.w3.org/2000/svg">${children}</svg>`
  const nested = (depth: number) => '<tspan>'.repeat(depth) + 'X' + '</tspan>'.repeat(depth)
  try {
    expect(() => importSvg(svg(text(nested(64))))).not.toThrow()
    expect(() => importSvg(svg(text(nested(65))))).toThrow('SVG 节点或层级超限')
    // A surrounding group consumes one depth level too.
    expect(() => importSvg(svg('<g>' + text(nested(64)) + '</g>'))).toThrow('SVG 节点或层级超限')
    expect(() => importSvg(svg(text('<tspan/>'.repeat(19999) + 'X')))).not.toThrow()
    expect(() => importSvg(svg(text('<tspan/>'.repeat(20000) + 'X')))).toThrow('SVG 节点或层级超限')
    // Individual text subtrees fit; their aggregate must not reset the budget.
    const half = text('<tspan/>'.repeat(10000) + 'X')
    expect(() => importSvg(svg(half + half))).toThrow('SVG 节点或层级超限')
  } finally { vi.unstubAllGlobals(); dom.window.close() }
})
