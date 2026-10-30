import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank,node,paint,validateDocument, type VectorGeometry } from './model'
import { editableNetwork,materializeEditableNetwork } from './editable-network'
import { kernelBounds,kernelHit,kernelSvgPaths } from './kernel/picking'
import { resizedNode } from './selection-properties'
import { multiply } from './geometry'
import { forma_encode_json,forma_decode_json,validate_document_json } from './generated/design-kernel/design_kernel'

const geometry=():VectorGeometry=>({fillRule:'nonzero',fill:[{move:[0,0]},{cubic:[0.12345678901234567,0,19.98765432109876,0,20,0]},{line:[20,20]},{line:[0,20]},{line:[0,0]},'close']})
function fixture(){const doc=blank('Precise paths'),shape=node('vector',5,6,20,20);shape.fills=[paint('#426bdf')];shape.vectorGeometry=geometry();doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id];doc.schemaVersion=16;return {doc,shape}}
test('existing Editor history, resize, native FD and hit testing retain render curves',()=>{
  const {doc,shape}=fixture(),editor=new Editor(doc)
  try{
    const before=editor.authoredDocument
    expect(kernelHit(before.nodes[shape.id],{x:10,y:10},0)).toBe(true)
    expect(kernelBounds(before.nodes[shape.id])).toEqual({x:0,y:0,width:20,height:20})
    editor.updateProperties([shape.id],n=>Object.assign(n,resizedNode(n,multiply(n.transform,[2,0,0,1,0,0]))))
    expect(editor.authoredDocument.nodes[shape.id].width,editor.state.message).toBe(40)
    const curves=editor.authoredDocument.nodes[shape.id].vectorGeometry!
    expect((curves.fill[1] as {cubic:number[]}).cubic[0]).toBe(0.12345678901234567*2)
    expect(editor.authoredDocument.nodes[shape.id].network).toBeUndefined()
    editor.undo();expect(editor.authoredDocument.nodes[shape.id].vectorGeometry).toEqual(geometry())
    editor.redo();expect(editor.authoredDocument.nodes[shape.id].vectorGeometry).toEqual(curves)
    const json=JSON.stringify(editor.authoredDocument)
    const reopened=validateDocument(JSON.parse(forma_decode_json(forma_encode_json(json))))
    expect(reopened.nodes[shape.id].vectorGeometry).toEqual(curves)
    validate_document_json(JSON.stringify(reopened))
    expect(kernelSvgPaths(reopened.nodes[shape.id])!.fill).toContain('C')
    expect(before.nodes[shape.id].vectorGeometry).toEqual(geometry())
  }finally{editor.dispose()}
})
test('point editing is an explicit conversion; selection and reading leave authored curves intact',()=>{
  const {shape}=fixture(),original=structuredClone(shape)
  const network=editableNetwork(shape)
  expect(shape).toEqual(original)
  expect(network.edges[0].c1?.x).toBe(0.12345678901234567)
  const edited=materializeEditableNetwork(shape,network)
  expect(edited.vectorGeometry).toBeUndefined();expect(edited.network).toEqual(network)
  expect(shape.vectorGeometry).toEqual(original.vectorGeometry)
})
test('both validators reject conflicting geometry and old schema versions',()=>{
  const {doc,shape}=fixture();doc.schemaVersion=15
  expect(()=>validateDocument(doc)).toThrow(/16/);expect(()=>validate_document_json(JSON.stringify(doc))).toThrow(/16/)
  doc.schemaVersion=16;shape.network=editableNetwork(shape)
  expect(()=>validateDocument(doc)).toThrow();expect(()=>validate_document_json(JSON.stringify(doc))).toThrow()
})
test('thin imported groups retain their precise extent in both validators',()=>{
  const doc=blank('Thin component'),shape=node('group',0,0,356,1e-6)
  doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id]
  expect(validateDocument(doc).nodes[shape.id].height).toBe(1e-6)
  validate_document_json(JSON.stringify(doc))
  for(const height of [0,-1,Infinity]){
    shape.height=height
    expect(()=>validateDocument(doc)).toThrow()
    expect(()=>validate_document_json(JSON.stringify(doc))).toThrow()
  }
})
test('curve admission still checks distinct strokes, mutations, opcodes and shared-carrier capacity',()=>{
  const {doc,shape}=fixture()
  expect(validateDocument(doc)).toBe(doc)
  shape.vectorGeometry!.stroke=[{move:[0,0]},{line:[Infinity,1]}]
  expect(()=>validateDocument(doc)).toThrow(/坐标/)
  shape.vectorGeometry!.stroke=[{move:[0,0]},{quad:[1,2,3,4]}]
  expect(validateDocument(doc)).toBe(doc)
  ;(shape.vectorGeometry!.fill[1] as {cubic:number[]}).cubic[0]=NaN
  expect(()=>validateDocument(doc)).toThrow(/坐标/)
  shape.vectorGeometry=geometry()
  for(const curve of [{move:[0,0],line:[1,1]},{unknown:[0,0]},{quad:[1,2]},{toString:[1,2]}]){
    shape.vectorGeometry.fill=[curve as any];expect(()=>validateDocument(doc)).toThrow(/曲线/)
  }
  const fill=Array.from({length:65537},()=>({line:[0,0] as [number,number]}))
  shape.vectorGeometry={fillRule:'nonzero',fill,stroke:fill}
  expect(()=>validateDocument(doc)).toThrow(/权威几何/)
})
