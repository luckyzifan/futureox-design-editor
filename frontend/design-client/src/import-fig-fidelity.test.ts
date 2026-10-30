import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { compileSchema, decodeBinarySchema } from 'kiwi-schema'
import { deflateSync, inflateSync } from 'fflate'
import { figArchive, importFig } from './import-fig'
import { uid, validateDocument } from './model'
import { kernelSvgPaths, prepareDocumentForEditing } from './kernel/picking'
import { export_sketch_json, import_sketch_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { createImportedCopy } from './import-identity'
import { Editor } from './engine'

// Generated regression files use the schema from a real Figma local export.
// They prove preservation/rejection of encoded inputs, not external image parity.
const native = new Uint8Array(readFileSync(new URL(
  '../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig', import.meta.url,
)))
const canvas = figArchive(native)['canvas.fig']
const length = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength).getUint32(12, true)
const schemaPart = canvas.slice(16, 16 + length)
const schema = decodeBinarySchema(inflateSync(schemaPart))
const encoder = compileSchema(schema)
const fields = new Set(schema.definitions.find((d) => d.name === 'NodeChange')!.fields.map((f) => f.name))
const guid = (localID: number) => ({ sessionID: 1, localID })
function encoded(layer: Record<string, unknown>, document: Record<string, unknown> = {}, blobs:Uint8Array[] = [],extra:Record<string,unknown>[] = []) {
  for (const key of [...Object.keys(layer), ...Object.keys(document)])
    expect(fields.has(key), `native schema field ${key}`).toBe(true)
  const message = encoder.encodeMessage({ blobs:blobs.map(bytes=>({bytes})), nodeChanges: [
    { guid: guid(1), type: 'DOCUMENT', name: 'Document', documentColorProfile: 'SRGB', ...document },
    { guid: guid(2), type: 'CANVAS', name: 'Page', parentIndex: { guid: guid(1), position: 'a' } },
    { guid: guid(3), type: 'RECTANGLE', name: 'Subject', parentIndex: { guid: guid(2), position: 'a' },
      size: { x: 40, y: 24 }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], ...layer },...extra,
  ] })
  const parts = [schemaPart, deflateSync(message)]
  const bytes = new Uint8Array(12 + parts.reduce((n, part) => n + 4 + part.length, 0))
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('fig-kiwi')); view.setUint32(8, 15, true)
  let offset = 12
  for (const part of parts) { view.setUint32(offset, part.length, true); bytes.set(part, offset + 4); offset += part.length + 4 }
  return bytes
}
function subject(layer: Record<string, unknown>) {
  const result = importFig(encoded(layer))
  validateDocument(result.document)
  const reopened = prepareDocumentForEditing(JSON.parse(JSON.stringify(result.document)))
  return { ...result, node: Object.values(reopened.nodes).find((n) => n.name === 'Subject')! }
}

test('a native trailing mask cannot erase content painted before it',()=>{
 const {document}=importFig(encoded({type:'FRAME',resizeToFit:true,fillPaints:[]},{},[],[
  {guid:guid(4),type:'RECTANGLE',name:'Before mask',parentIndex:{guid:guid(3),position:'!'},size:{x:40,y:24},fillPaints:[{type:'SOLID',color:{r:1,g:0,b:0,a:1}}]},
  {guid:guid(5),type:'RECTANGLE',name:'Trailing mask',parentIndex:{guid:guid(3),position:'"'},size:{x:20,y:24},mask:true,fillPaints:[{type:'SOLID',color:{r:1,g:1,b:1,a:1}}]},
 ]))
 validateDocument(document)
 const engine=new VectorEngine()
 try{engine.load_document(JSON.stringify(document));const bytes=engine.render_rgba(JSON.stringify({pageId:document.pages[0].id,width:40,height:24,view:{x:0,y:0,zoom:1},transparent:true}))
  for(const x of [5,35])expect(Array.from(bytes.slice((12*40+x)*4,(12*40+x)*4+4))).toEqual([255,0,0,255])
 }finally{engine.free()}
})

test('FIG automatic-width text stays on its authored line; fixed-width text retains wrapping',()=>{
 for(const textAutoResize of ['WIDTH_AND_HEIGHT','HEIGHT','NONE']){
  const {node}=subject({type:'TEXT',textAutoResize,textData:{characters:'Completed Tasks'},fontSize:14,size:{x:123,y:20}})
  expect(node.textStyle?.wrap).toBe(textAutoResize!=='WIDTH_AND_HEIGHT')
  expect(node.width).toBe(123);expect(node.height).toBe(20)
 }
})

test('FIG vertical fading gradient uses node-to-gradient coordinates, including alpha',()=>{
 const {document}=subject({fillPaints:[{type:'GRADIENT_LINEAR',transform:{m00:0,m01:1,m02:0,m10:-1,m11:0,m12:1},stops:[
  {position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:1,g:0,b:0,a:0}},
 ]}]})
 const engine=new VectorEngine()
 try{engine.load_document(JSON.stringify(document));const bytes=engine.render_rgba(JSON.stringify({pageId:document.pages[0].id,width:40,height:24,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'analytic'}))
  expect(bytes[(2*40+20)*4+3]).toBeGreaterThan(220)
  expect(bytes[(21*40+20)*4+3]).toBeLessThan(35)
 }finally{engine.free()}
})

test('actual FIG vector card radius is rendered rather than silently kept as unused rectangle radii',()=>{
 const bytes=new Uint8Array(readFileSync(new URL('../../../testing/verification-interaction-layout-20261030/fig-card-corners.bin',import.meta.url)))
 const {document,warnings}=importFig(encoded({type:'VECTOR',size:{x:548,y:409},cornerRadius:6,vectorData:{normalizedSize:{x:548,y:409},vectorNetworkBlob:0}}, {},[bytes]))
 const n=Object.values(document.nodes).find(n=>n.name==='Subject')!
 expect(n.kind).toBe('vector');expect(n.vectorGeometry).toBeDefined();expect(n.network).toBeUndefined()
 expect(warnings.some(w=>w.includes('圆角'))).toBe(false)
 const engine=new VectorEngine()
 try{engine.load_document(JSON.stringify(document));const pixels=engine.render_rgba(JSON.stringify({pageId:document.pages[0].id,width:12,height:12,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'analytic'}))
  expect(pixels[3]).toBe(0);expect(pixels[(6*12+6)*4+3]).toBe(255)
 }finally{engine.free()}
})

test('same-name repeated FIG adoption creates independent new documents, never overwriting the earlier edit',()=>{
  const bytes=encoded({name:'Repeated layer'}),source=importFig(bytes,'Same filename').document
  const first=createImportedCopy(source),editor=new Editor(first)
  try {
    const firstId=editor.state.doc.id,layerId=Object.keys(editor.state.doc.nodes)[0],session=editor.sessionGeneration
    editor.change('Retain first edit',d=>{d.nodes[layerId].name='Local edit'})
    const edited=editor.state.doc
    const second=createImportedCopy(importFig(bytes,'Same filename').document)
    expect(second.id).not.toBe(firstId);expect(second.id).not.toBe(source.id)
    expect(second.name).toBe(first.name)
    expect(editor.load(second)).toBe(true);expect(editor.sessionGeneration).toBeGreaterThan(session)
    expect(edited.nodes[layerId].name).toBe('Local edit')
    expect(Object.values(editor.state.doc.nodes).some(n=>n.name==='Local edit')).toBe(false)
    const changed=createImportedCopy(importFig(encoded({name:'Changed layer',size:{x:52,y:24}}),'Same filename').document)
    expect(new Set([source.id,firstId,second.id,changed.id]).size).toBe(4)
    expect(changed.name).toBe(first.name);expect(editor.load(changed)).toBe(true)
    expect(Object.values(editor.state.doc.nodes).find(n=>n.name==='Changed layer')?.width).toBe(52)
    expect(source.nodes[layerId]?.name).not.toBe('Local edit')
  } finally {editor.dispose()}
})
const blackStroke = { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }

test('native FIG text casing and styled ranges remain authored through WASM reopening',()=>{
  const result=subject({type:'TEXT',textData:{characters:'aßCD',characterStyleIDs:[0,1,1,0],styleOverrideTable:[
    {styleID:1,textCase:'ORIGINAL',fontSize:18,fillPaints:[{type:'SOLID',color:{r:.2,g:.4,b:.6,a:1}}]},
  ]},textCase:'UPPER',fontSize:14,fontName:{family:'Poppins',style:'SemiBold',postscript:'Poppins-SemiBold'},lineHeight:{units:'PIXELS',value:21},letterSpacing:{units:'PERCENT',value:2}})
  expect(result.document.schemaVersion).toBe(15)
  expect(result.node.text).toBe('aßCD')
  expect(result.node.textStyle).toMatchObject({textCase:'upper',weight:600,lineHeight:1.5,letterSpacing:.28})
  expect(result.node.textRuns?.[0]).toMatchObject({start:1,end:3,textCase:'original',fontSize:18})
})

test.each(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'])(
  'FIG %s retains independent stop alpha through document reopening', type => {
    const gradient = { type, opacity: .4, stops: [
      { position: 0, color: { r: .2, g: .4, b: .8, a: .0001 } },
      { position: 1, color: { r: .2, g: .4, b: .8, a: .75 } },
    ] }
    const result = subject({ fillPaints: [gradient], strokePaints: [gradient], strokeWeight: 2 })
    expect(result.document.colorManagement).toBeUndefined()
    for (const paint of [result.node.fills[0], result.node.strokes[0].paint]) {
      expect(paint.opacity).toBeCloseTo(.4, 6)
      expect(paint.stops.map(s => Number(s.color.split('/')[1].slice(0, -1))))
        .toEqual([Math.fround(.0001), .75])
    }
  },
)

test('FIG transparent gradient survives Sketch export/import and encoded GPU constants keep alpha', () => {
  const result = subject({ fillPaints: [{ type: 'GRADIENT_LINEAR', opacity: .5,
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, stops: [
    { position: 0, color: { r: 0, g: 0, b: 1, a: .0001 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: .75 } },
  ] }] })
  const reopen = JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(result.document)))).document
  reopen.id = uid()
  validateDocument(reopen)
  const paint = Object.values(reopen.nodes).find((n: any) => n.name === 'Subject') as any
  expect(paint.fills[0].stops).toEqual(result.node.fills[0].stops)
  expect(paint.fills[0].opacity).toBe(.5)
  expect(reopen.colorManagement).toBeUndefined()
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(result.document))
    const options = { pageId: result.document.pages[0].id, width: 40, height: 24,
      view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' }
    const scene = JSON.parse(engine.compile_gpu(JSON.stringify(options)))
    const stop = result.node.fills[0].stops[0].color
    expect(scene.colors[stop].map(Math.fround)).toEqual([0, 0, 1, Math.fround(.0001)])
    const pixels = engine.render_rgba(JSON.stringify(options))
    const alpha = (x: number) => pixels[(12 * 40 + x) * 4 + 3]
    expect(alpha(2)).toBeLessThan(alpha(20))
    expect(alpha(20)).toBeLessThan(alpha(37))
    expect(alpha(37)).toBeLessThanOrEqual(96)
  } finally { engine.free() }
})

test.each([{ x: 40, y: 0 }, { x: 0, y: 24 }])('FIG zero-dimension line %j keeps its exact endpoints through Rust reopening', (size) => {
  const result = subject({ type: 'LINE', size, fillPaints: [], strokePaints: [blackStroke], strokeWeight: 2 })
  expect(result.node.network?.vertices.map((v) => [v.x, v.y])).toEqual([[0, 0], [size.x, size.y]])
  const paths = kernelSvgPaths(result.node)!
  expect(paths.stroke).toContain(`L${size.x} ${size.y}`)
  expect(result.warnings.some((w) => w.includes('零尺寸线条'))).toBe(true)
})

test('FIG polygon and star retain authored point counts and inner radius', () => {
  expect(subject({ type: 'REGULAR_POLYGON', count: 7 }).node.points).toBe(7)
  const star = subject({ type: 'STAR', count: 8, starInnerScale: 0.25 }).node
  expect(star.points).toBe(8)
  expect(star.innerRadius).toBe(0.25)
})

test('FIG dash pattern and a zero-width stroke are not replaced with a solid one-pixel stroke', () => {
  const dashed = subject({ strokePaints: [blackStroke], strokeWeight: 3, dashPattern: [4, 2] }).node
  expect(dashed.strokes[0].dash).toBe('4 2')
  expect(subject({ strokePaints: [blackStroke], strokeWeight: 0 }).node.strokes[0].width).toBe(0)
})

test('unsupported FIG document gamut is rejected instead of silently interpreted as sRGB', () => {
  expect(() => importFig(encoded({}, { documentColorProfile: 'DISPLAY_P3' }))).toThrow(/色域|色彩/)
})

test('unsupported FIG gradient interpolation is rejected before returning a document', () => {
  expect(() => importFig(encoded({ fillPaints: [{ type: 'GRADIENT_LINEAR', interpolationColorSpace: 'OKLAB',
    stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }] })))
    .toThrow(/插值/)
})

test('unsupported FIG independent border weights do not silently become a uniform stroke', () => {
  expect(() => importFig(encoded({ strokePaints: [blackStroke], strokeWeight: 2,
    borderStrokeWeightsIndependent: true, borderTopWeight: 1, borderRightWeight: 2,
    borderBottomWeight: 3, borderLeftWeight: 4 }))).toThrow(/独立|非均匀/)
})

test('FIG glass bevel width survives import and Rust reopening', () => {
  const glass = { type: 'GLASS', radius: 1, bevelSize: 2.5, refractionRadius: 8,
    refractionIntensity: 0.5, chromaticAberration: 0.2, specularAngle: 45, specularIntensity: 0.5 }
  expect(subject({ effects: [glass] }).node.effects[0].glass?.bevelSize).toBe(2.5)
  expect(() => importFig(encoded({ effects: [{ ...glass, bevelSize: -1 }] }))).toThrow(/倒角/)
})

test('native v106 XOR and OUTLINE retain their executable semantics', () => {
  const node=Object.values(importFig(encoded({type:'BOOLEAN_OPERATION',booleanOperation:'XOR'})).document.nodes)[0]
  expect(node.booleanOperation).toBe('exclude')
  expect(subject({mask:true,maskType:'OUTLINE'}).node.maskType).toBe('outline')
})


test('native resizeToFit frames without a stack are un-clipped groups, while auto-layout and component sets stay frames',()=>{
 const {node:group}=subject({type:'FRAME',resizeToFit:true,frameMaskDisabled:false,fillPaints:[]})
 expect(group.kind).toBe('group');expect(group.clip).toBe(false)
 expect(subject({type:'FRAME',resizeToFit:false,frameMaskDisabled:false}).node).toMatchObject({kind:'frame',clip:true})
 expect(subject({type:'FRAME',resizeToFit:true,stackMode:'HORIZONTAL'}).node.kind).toBe('frame')
 expect(subject({type:'FRAME',resizeToFit:true,isStateGroup:true}).node.kind).toBe('frame')
})
