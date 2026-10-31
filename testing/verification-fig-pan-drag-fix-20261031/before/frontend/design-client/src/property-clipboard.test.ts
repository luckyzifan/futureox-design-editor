import {expect,test,vi,afterEach} from 'vitest'
import {blank,node,paint,defaultTextStyle,validateDocument,uid} from './model'
import {copyProperties,pasteProperties,readProperties} from './property-clipboard'
import {Editor} from './engine'
import {dispatchEditorCommand} from './editor-commands'
import {emptySystem} from './design-system'
import {encodeDocumentBinary,decodeDocumentBinary} from './kernel/binfmt'
afterEach(()=>vi.unstubAllGlobals())
test('style clipboard copies reachable resources without copying source text, children, or geometry',()=>{
 const source=blank('Secret document'),a=node('text',123,456,200,50),unrelated=node('rectangle',0,0,1,1)
 a.text='PRIVATE TEXT';a.fills=[paint('#13579b')];a.fontSize=24;a.textStyle=defaultTextStyle();source.nodes={[a.id]:a,[unrelated.id]:unrelated};source.pages[0].children=[a.id,unrelated.id]
 const encoded=copyProperties(source,a.id),packet=readProperties(encoded)
 expect(encoded).not.toContain('PRIVATE TEXT');expect(encoded).not.toContain('Secret document');expect(encoded).not.toContain(unrelated.id)
 const target=blank(),b=node('text',10,20,300,60);b.text='保留我的文字 😀';target.nodes[b.id]=b;target.pages[0].children=[b.id]
 const editor=new Editor(target),before=editor.state.doc
 editor.change('paste',d=>pasteProperties(d,[b.id],packet));const result=editor.state.doc.nodes[b.id]
 expect(result.text).toBe(b.text);expect(result.transform).toEqual(b.transform);expect(result.width).toBe(300);expect(result.fontSize).toBe(24);expect(result.fills).toEqual(a.fills)
 expect(decodeDocumentBinary(encodeDocumentBinary(editor.state.doc))).toEqual(editor.state.doc)
 editor.undo();expect(editor.state.doc).toEqual(before);editor.dispose()
})
test('cross-document variable/style collisions remap and single-property paste preserves other appearance',()=>{
 const source=blank(),a=node('rectangle',0,0,30,40);source.schemaVersion=6;source.designSystem=emptySystem()
 source.designSystem.collections.colors={name:'Colors',modes:['Light','Dark'],defaultMode:'Light'};source.designSystem.activeModes.colors='Light'
 source.designSystem.variables.brand={name:'Brand',kind:'color',collection:'colors',values:{Light:'#ff0000',Dark:'#0000ff'}}
 a.variableModes={colors:'Dark'};a.bindings={'fills.0.color':'brand'};source.nodes[a.id]=a;source.pages[0].children=[a.id]
 const target=structuredClone(source);target.id=uid();target.designSystem!.variables.brand.values.Dark='#00ff00';target.nodes[a.id].opacity=.5
 const packet=readProperties(copyProperties(source,a.id,'fills'));pasteProperties(target,[a.id],packet);validateDocument(target)
 expect(target.designSystem!.variables.brand.values.Dark).toBe('#00ff00');expect(target.nodes[a.id].bindings!['fills.0.color']).not.toBe('brand');expect(target.nodes[a.id].opacity).toBe(.5)
 const editor=new Editor(target);expect(editor.state.doc.nodes[a.id].fills[0].color).toBe('#0000ff');editor.dispose()
})
test('polygon corner properties are copied only to eligible polygon/star targets',()=>{
 const d=blank(),a=node('polygon',0,0,50,50),b=node('rectangle',0,0,20,20);a.cornerRadius=8;d.schemaVersion=7;d.nodes[a.id]=a;d.nodes[b.id]=b;d.pages[0].children=[a.id,b.id]
 const packet=readProperties(copyProperties(d,a.id));pasteProperties(d,[b.id],packet);expect(d.nodes[b.id].cornerRadius).toBeUndefined();validateDocument(d)
})
test('async property paste rejects stale selection and leaves locked layers unchanged',async()=>{
 const d=blank(),a=node('rectangle',0,0,10,10),b=node('rectangle',20,0,10,10);a.fills=[paint('#abcdef')];d.nodes[a.id]=a;d.nodes[b.id]=b;d.pages[0].children=[a.id,b.id]
 const e=new Editor(d),packet=copyProperties(d,a.id);e.select([b.id]);const before=e.state.doc
 let resolve!:(v:any)=>void
 vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{read:()=>new Promise(r=>{resolve=r})}}})
 const pending=dispatchEditorCommand(e,'paste-properties');e.select([a.id]);resolve({status:'ok',text:packet});await pending
 expect(e.state.doc).toBe(before);expect(e.state.message).toContain('已变化')
 e.update([b.id],{locked:true});e.select([b.id]);vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{read:async()=>({status:'ok',text:packet})}}})
 const locked=e.state.doc;await dispatchEditorCommand(e,'paste-properties');expect(e.state.doc).toBe(locked);e.dispose()
})
