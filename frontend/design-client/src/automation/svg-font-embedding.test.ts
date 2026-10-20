import { writeFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
// @ts-expect-error test-only dependency
import { JSDOM } from 'jsdom'
import { Editor } from '../engine'
import { blank, node, defaultTextStyle } from '../model'
import { createDesignAutomation } from './core'
import { exportExtensions } from './export'
import { importSvg } from '../import-svg'
import { inspectSvgFont } from '../svg-font-embedding'
import { kernelTextLayout } from '../kernel/picking'
const font = 'AAEAAAAKAIAAAwAgT1MvMmUdmiEAAAEoAAAAYGNtYXAGO07YAAABlAAAAERnbHlm1FbUUgAAAeQAAABoaGVhZC8xsWIAAACsAAAANmhoZWEEgAKMAAAA5AAAACRobXR4AlgAAAAAAYgAAAAKbG9jYQBOADQAAAHYAAAACm1heHAABgAGAAABCAAAACBuYW1l6XaEXgAAAkwAAAFHcG9zdEGRzTYAAAOUAAAANQABAAAAAQAAY20Tj18PPPUAAQPoAAAAAOb7tuMAAAAA5vu24wBkAAABwgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYAAAA+gFeAAEAAAAAAAAAAAAAAAAAAAABAAEAAAAEAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACABCAAAAAAAAAAAAAAAPz8/PwAAAEFOLQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAAAAAAAAAAAAAAAACAAAAAwAAABQAAwABAAAAFAAEADAAAAAIAAgAAgAAAEEGJ04t//8AAABBBidOLf///8D527HWAAEAAAAAAAAAAAAAAA0AGgAnADQAAAABAGQAAAHCArwAAwAAMyERIWQBXv6iArwAAAEAZAAAAcICvAADAAAzIREhZAFe/qICvAAAAQBkAAABwgK8AAMAADMhESFkAV7+ogK8AAABAGQAAAHCArwAAwAAMyERIWQBXv6iArwAAAAACgB+AAEAAAAAAAEADwAAAAEAAAAAAAIABwAPAAEAAAAAAAMAFgAWAAEAAAAAAAQAFwAsAAEAAAAAAAYAFgAWAAMAAQQJAAEAHgBDAAMAAQQJAAIADgBhAAMAAQQJAAMALABvAAMAAQQJAAQALgCbAAMAAQQJAAYALABvQXV0b21hdGlvbiBUZXN0UmVndWxhckF1dG9tYXRpb25UZXN0LVJlZ3VsYXJBdXRvbWF0aW9uIFRlc3QgUmVndWxhcgBBAHUAdABvAG0AYQB0AGkAbwBuACAAVABlAHMAdABSAGUAZwB1AGwAYQByAEEAdQB0AG8AbQBhAHQAaQBvAG4AVABlAHMAdAAtAFIAZQBnAHUAbABhAHIAQQB1AHQAbwBtAGEAdABpAG8AbgAgAFQAZQBzAHQAIABSAGUAZwB1AGwAYQByAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAkAQIBAwZhcmFiaWMDY2prAAAA'
function changedFlags(flags: number) {
 const bytes = Buffer.from(font, 'base64')
 for (let at = 12; at < 12 + bytes.readUInt16BE(4) * 16; at += 16) if (bytes.toString('ascii', at, at + 4) === 'OS/2') bytes.writeUInt16BE(flags, bytes.readUInt32BE(at + 8) + 8)
 return bytes.toString('base64')
}
test('whole licensed font bytes and real shaped metrics survive editable SVG roundtrip', () => {
 const dom = new JSDOM(''); vi.stubGlobal('DOMParser', dom.window.DOMParser)
 const doc = blank(); doc.schemaVersion = 15
 doc.fonts = { local: { family: 'Automation Test Regular', data: changedFlags(0x108), index: 0 } }
 const text = node('text', 0, 0, 70, 120); text.text = 'AA AA\nAA'; text.fontSize = 24; text.textStyle = { ...defaultTextStyle(), fontId: 'local', wrap: true }
 doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
 const editor = new Editor(doc), api = createDesignAutomation(editor, exportExtensions)
 try {
  const before = kernelTextLayout(text)
  const result = api.execute({method:'vector.export',params:{textMode:'editable',fontMode:'embed',fontEmbeddingAllowed:true}})
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error('Export failed')
  const source = (result.result as any).content
  if (process.env.SVG_FONT_EVIDENCE) writeFileSync(process.env.SVG_FONT_EVIDENCE, source)
  expect(source).toContain('data:font/ttf;base64,'); expect(source).not.toContain('textLength'); expect(source).not.toContain('lengthAdjust')
  const imported = importSvg(source); expect(imported.document.fonts?.local.data).toBe(doc.fonts.local.data)
  const restored = Object.values(imported.document.nodes).find(n => n.kind === 'text')!
  const reopened = new Editor(imported.document)
  try { expect(kernelTextLayout(restored)).toEqual(before) } finally { reopened.dispose() }
  for (const bad of [source.replace('<defs>', '<defs><script>alert(1)</script>'), source.replace('@font-face{', '@import url(https://example.com/a);@font-face{'), source.replace('data:font/ttf;base64,', 'https://example.com/'), source.replace('white-space:pre', 'white-space:pre;filter:url(https://example.com/)')]) expect(() => importSvg(bad)).toThrow()
 } finally { editor.dispose(); vi.unstubAllGlobals(); dom.window.close() }
})
test('embedding rights are enforced and no-subsetting keeps whole font', () => {
 for (const flags of [2,4,0x200,0x208,1,0x8000]) expect(() => inspectSvgFont(changedFlags(flags))).toThrow(/rights/)
 for (const flags of [0,8,0x100,0x108]) expect(inspectSvgFont(changedFlags(flags)).flags).toBe(flags)
 for (const magic of ['ttcf','wOFF','wOF2']) { const bytes=Buffer.from(font,'base64'); bytes.write(magic,0,'ascii'); expect(()=>inspectSvgFont(bytes.toString('base64'))).toThrow() }
 expect(()=>inspectSvgFont(font,1)).toThrow(/index/)
})

test('SVG embedding requires explicit caller license attestation and preserves reference default', () => {
 const editor = new Editor(blank()), api = createDesignAutomation(editor, exportExtensions)
 try {
  expect(api.execute({method:'vector.export',params:{textMode:'editable',fontMode:'embed'}}).ok).toBe(false)
  expect(api.execute({method:'vector.export',params:{fontMode:'embed',fontEmbeddingAllowed:true}}).ok).toBe(false)
  const result = api.execute({method:'vector.export'})
  expect(result.ok).toBe(true)
  if (result.ok) expect((result.result as any).options.fontMode).toBe('references')
 } finally { editor.dispose() }
})

test('explicit RTL line uses the shaped right edge without stretching glyphs', () => {
 const dom=new JSDOM(''); vi.stubGlobal('DOMParser',dom.window.DOMParser)
 const doc=blank(), text=node('text',0,0,220,60); text.text='مرحبا שלום'; text.textStyle={...defaultTextStyle(),direction:'rtl'}; doc.nodes[text.id]=text;doc.pages[0].children=[text.id]
 const editor=new Editor(doc),api=createDesignAutomation(editor,exportExtensions)
 try {
  const layout=kernelTextLayout(text), result=api.execute({method:'vector.export',params:{textMode:'editable'}})
  expect(result.ok,JSON.stringify(result)).toBe(true); if(!result.ok) throw new Error('Export failed')
  const parsed=new dom.window.DOMParser().parseFromString((result.result as any).content,'image/svg+xml')
  const line=parsed.querySelector('text > tspan')!
  expect(Number(line.getAttribute('x'))).toBe(Math.max(...layout.glyphs.map(g=>g.x+g.advance)))
  expect(parsed.querySelector('[textLength],[lengthAdjust]')).toBeNull()
  expect(Object.values(importSvg((result.result as any).content).document.nodes).find(n=>n.kind==='text')?.textStyle?.direction).toBe('rtl')
 } finally {editor.dispose();vi.unstubAllGlobals();dom.window.close()}
})
