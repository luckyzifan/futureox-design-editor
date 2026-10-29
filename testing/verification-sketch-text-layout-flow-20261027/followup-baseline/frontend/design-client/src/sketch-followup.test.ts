import {beforeAll, expect, test} from 'vitest'
import {readFileSync} from 'node:fs'
import {initializePicking} from './kernel/picking'
import {import_sketch_json, export_sketch_json, binfmt_encode, binfmt_decode} from './generated/design-kernel/design_kernel'
import {Editor} from './engine'
import {validateDocument,type DesignDocument,hasSchema20Features} from './model'
import {applyWholeTextStyle} from './text'
import {initialPrototype,prototypeEvent} from './prototype'
import {installLibrary,prepareSketchLibrary} from './design-system'
const root=new URL('../../../',import.meta.url)
const read=(path:string)=>readFileSync(new URL(path,root))
const imported=(path:string):DesignDocument=>JSON.parse(import_sketch_json(read(path))).document
const fixture=()=>imported('testing/fixtures/design/sketch-text-layout-flow.sketch')
beforeAll(async()=>{await initializePicking({wasm:readFileSync(new URL('../public/kernel/design_kernel_bg.wasm',import.meta.url)),font:readFileSync(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url))})})
test('native paragraph and vertical fields enter Editor, undo and FD without losing run ranges',()=>{
 const d=fixture();validateDocument(d);expect(hasSchema20Features(d)).toBe(true)
 const n=Object.values(d.nodes).find(n=>n.name==='text-paragraphs')!;expect(n.textRuns?.map(r=>r.paragraph?.align)).toEqual(['start','center','end'])
 const e=new Editor(d)
 try {e.change('align bottom',d=>applyWholeTextStyle(d.nodes[n.id],{verticalAlign:'bottom'}));expect(e.state.doc.nodes[n.id].textStyle?.verticalAlign).toBe('bottom');e.undo();expect((e.state.doc.nodes[n.id].textStyle?.verticalAlign ?? 'top')).toBe('top');e.redo()
 const back=JSON.parse(binfmt_decode(binfmt_encode(JSON.stringify(e.state.doc)))) as DesignDocument
 expect(back.nodes[n.id].textStyle?.verticalAlign).toBe('bottom');expect(back.nodes[n.id].textRuns).toEqual(e.state.doc.nodes[n.id].textRuns)
 const native=JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(back)))).document as DesignDocument
 expect(native.nodes[n.id].textRuns).toEqual(back.nodes[n.id].textRuns)
 } finally {e.dispose()}
})
test('modern native Fill sizing responds to parent resize and undo',()=>{
 const d=fixture(), parent=Object.values(d.nodes).find(n=>n.name==='stack')!, child=Object.values(d.nodes).find(n=>n.name==='stack-32')!
 expect(child.sizing?.width).toBe('fill');const e=new Editor(d)
 try {const before=e.state.doc.nodes[child.id].width;e.updateProperties([parent.id],n=>{n.width+=100});expect(e.state.doc.nodes[child.id].width).toBeCloseTo(before+100);e.undo();expect(e.state.doc.nodes[child.id].width).toBeCloseTo(before)}finally{e.dispose()}
})
test('native hotspots navigate, slide and return through the shared player',()=>{
 const d=fixture(), next=Object.values(d.nodes).find(n=>n.name==='Go next')!, back=Object.values(d.nodes).find(n=>n.name==='Go back')!
 expect(next.kind).toBe('rectangle');expect(next.fills).toEqual([])
 const initial=initialPrototype(d), result=prototypeEvent(d,initial,next.id,'click')
 expect(d.nodes[result.current].name).toBe('destination');expect(result.transitionStyle).toBe('slide-left');expect(result.transition).toBeUndefined();expect(result.transitionMs).toBe(300)
 const returned=prototypeEvent(d,result,back.id,'click');expect(returned.current).toBe(initial.current);expect(returned.transitionStyle).toBe('slide-right')
})
test('selected local Sketch library adopts embedded identity, preserves overrides, updates and undoes',async()=>{
 const consumer=imported('testing/verification-sketch-text-layout-flow-20261027/foreign-consumer.sketch')
 const v1=imported('testing/verification-sketch-text-layout-flow-20261027/library-v1.sketch'),v2=imported('testing/verification-sketch-text-layout-flow-20261027/library-v2.sketch')
 expect(v1.id).toBe(v2.id);const e=new Editor(consumer)
 try {
  const instance=Object.values(e.state.doc.nodes).find(n=>n.instance&&!n.instanceOrigin)!,master=instance.instance!.componentId
  const label=()=>Object.values(e.state.doc.nodes).find(n=>n.instanceOrigin?.owner===instance.id&&n.kind==='text')!
  const color=()=>label().textRuns?.[0]?.color ?? label().fills[0].color
  expect(label().text).toBe('Local label');const oldColor=color()
  const first=await prepareSketchLibrary(v1,e.state.doc);e.change('first local release',d=>installLibrary(d,first));expect(e.state.doc.nodes[instance.id].instance!.componentId).toBe(master)
  expect(label().text).toBe('Local label')
  const repeat=await prepareSketchLibrary(v1,e.state.doc);expect(repeat.version).toBe(1);expect(repeat.digest).toBe(first.digest)
  const update=await prepareSketchLibrary(v2,e.state.doc);expect(update.version).toBe(2)
  e.change('update local release',d=>installLibrary(d,update));expect(e.state.doc.designSystem?.libraries[update.id].version).toBe(2)
  expect(label().text).toBe('Local label');expect(color()).not.toBe(oldColor)
  const changed=color();e.undo();expect(color()).toBe(oldColor);e.redo();expect(color()).toBe(changed)
  validateDocument(e.state.doc)
  const nativeBack=JSON.parse(import_sketch_json(export_sketch_json(JSON.stringify(e.state.doc)))).document as DesignDocument
  validateDocument(nativeBack);expect(Object.values(nativeBack.nodes).filter(n=>n.component).length).toBe(1)
  const re=new Editor(nativeBack);try{expect(Object.values(re.state.doc.nodes).find(n=>n.instanceOrigin&&n.kind==='text')?.text).toBe('Local label')}finally{re.dispose()}
 }finally{e.dispose()}
})
