import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, exportSuffixHasForbiddenCharacters, node, uid, validateDocument } from './model'
import { exportImage, svgSource, sliceExportTarget, targetBounds } from './export'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
test('export suffix admission rejects controls and filename separators while retaining Unicode names',()=>{
 const d=blank(),n=node('rectangle');d.schemaVersion=8;d.nodes[n.id]=n;d.pages[0].children=[n.id]
 n.exportSettings=[{id:uid(),format:'png',scale:1,suffix:''}]
 const controls=[...Array.from({length:32},(_,index)=>String.fromCharCode(index)),...Array.from({length:33},(_,index)=>String.fromCharCode(index+127))]
 for(const character of [...controls,...'\\/:*?"<>|']){
  const suffix=`detail${character}2x`;n.exportSettings[0].suffix=suffix
  expect(exportSuffixHasForbiddenCharacters(suffix)).toBe(true)
  expect(()=>validateDocument(d)).toThrow('图层导出设置无效')
 }
 for(const suffix of ['-图像 @2x','-😀','_detail',String.fromCharCode(32,126,160)]){
  n.exportSettings[0].suffix=suffix
  expect(exportSuffixHasForbiddenCharacters(suffix)).toBe(false)
  expect(validateDocument(d)).toBe(d)
 }
})
test('additional raster export presets upgrade the native schema and undo without losing the document',()=>{
 const d=blank(),n=node('rectangle');d.nodes[n.id]=n;d.pages[0].children=[n.id]
 const e=new Editor(d);editors.push(e)
 for(const format of ['jpeg','webp','pdf'] as const){
  e.updateProperties([n.id],{exportSettings:[{id:uid(),format,scale:2,suffix:'-图像'}]})
  expect(e.state.doc.schemaVersion).toBe(10);expect(e.state.doc.nodes[n.id].exportSettings?.[0].format).toBe(format)
  expect(validateDocument(structuredClone(e.state.doc))).toEqual(e.state.doc)
  const older=structuredClone(e.state.doc);older.schemaVersion=9;expect(()=>validateDocument(older)).toThrow()
  e.undo();expect(e.state.doc.nodes[n.id].exportSettings).toBeUndefined()
 }
})
test('native layer export presets survive component-free duplication, undo and old-schema rejection',()=>{
 const d=blank(),n=node('ellipse',10.125,20.375,80,60);d.nodes={[n.id]:n};d.pages[0].children=[n.id]
 const e=new Editor(d);editors.push(e);e.update([n.id],{exportSettings:[{id:uid(),format:'png',scale:2.5,suffix:'@detail'}]})
 expect(e.state.doc.schemaVersion).toBe(8);e.select([n.id]);e.duplicate()
 expect(e.state.doc.nodes[e.state.selection[0]].exportSettings).toEqual(e.state.doc.nodes[n.id].exportSettings)
 const saved=JSON.parse(JSON.stringify(e.state.doc));expect(validateDocument(saved)).toEqual(e.state.doc);saved.schemaVersion=7;expect(()=>validateDocument(saved)).toThrow('版本 8')
 e.undo();expect(Object.keys(e.state.doc.nodes)).toHaveLength(1)
})
test('rotated and scaled slices retain their edge dimensions without mutating authored transforms',()=>{
 const d=blank(),slice=node('slice',100,80,80,50),shape=node('rectangle',70,90,100,30)
 d.schemaVersion=10;slice.transform=[0,2,-3,0,100,80];d.nodes={[slice.id]:slice,[shape.id]:shape};d.pages[0].children=[shape.id,slice.id]
 const saved=JSON.stringify(d),target=sliceExportTarget(d,slice.id)
 expect(targetBounds(d,d.pages[0].id,target)).toEqual({x:0,y:0,width:160,height:150})
 const svg=svgSource(d,d.pages[0].id,target,2)
 expect(svg.source).toContain('width="320"');expect(svg.source).toContain('height="300"')
 expect(JSON.stringify(d)).toBe(saved)
 slice.transform=[2,0,0,3,100,80]
 expect(sliceExportTarget(d,slice.id)).toEqual({kind:'slice',bounds:{x:100,y:80,width:160,height:150}})
})
test('SVG selection isolates descendants and parent transforms while honoring fractional region and scale',async()=>{
 const d=blank(),f=node('frame',100.125,50.375,300,200),n=node('ellipse',20.25,30.5,80,60),other=node('rectangle',200,100,50,50)
 f.children=[n.id];d.nodes=Object.fromEntries([f,n,other].map(n=>[n.id,n]));d.pages[0].children=[f.id,other.id]
 const target={kind:'selection' as const,nodeIds:[n.id]},svg=svgSource(d,d.pages[0].id,target,2)
 expect(svg.box).toEqual({x:120.375,y:80.875,width:80,height:60});expect(svg.source).toContain('width="160"');expect(svg.source).toContain('A40 30');expect(svg.source).not.toContain(other.id)
 const exported=await exportImage(d,d.pages[0].id,'svg',2,undefined,undefined,target)
 expect(await exported.blob.text()).toBe(svg.source)
 expect(svgSource(d,d.pages[0].id,{kind:'slice',bounds:{x:.125,y:.375,width:50,height:40}}).source).toContain('viewBox="0.125 0.375 50 40"')
})
