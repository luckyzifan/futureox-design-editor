import { expect, test } from 'vitest'
import { blank, node, paint } from '../../frontend/design-client/src/model'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { planPasteOverSelection } from '../../frontend/design-client/src/paste-over-selection'
function pixel(document: ReturnType<typeof blank>, x: number, y: number) {
  const core=new VectorEngine()
  try {
    core.load_document(JSON.stringify(document))
    const bytes=core.render_rgba(JSON.stringify({pageId:document.pages[0].id,width:8,height:8,transparent:true,rasterProfile:'analytic',view:{x:4.5-x,y:4.5-y,zoom:1}}))
    return Array.from(bytes.slice((4*8+4)*4,(4*8+4)*4+4))
  } finally {core.free()}
}
function fixture(nested:boolean,grouped:boolean){
  const before=blank('Destination mask boundary'),target=node('rectangle',0,0,20,20),later=node('rectangle',100,100,20,20)
  target.fills=[paint('#00ff00')];later.fills=[paint('#ff0000')]
  before.nodes[target.id]=target;before.nodes[later.id]=later;before.pages[0].children=[target.id,later.id]
  if(nested){const parent=node('frame',0,0,200,200);parent.fills=[];parent.children=[target.id,later.id];before.nodes[parent.id]=parent;before.pages[0].children=[parent.id]}
  const source=blank('Source masked pair'),mask=node('rectangle',0,0,20,20),content=node('rectangle',0,0,40,20)
  mask.mask=true;mask.fills=[paint('#ffffff')];content.fills=[paint('#0000ff')]
  source.nodes[mask.id]=mask;source.nodes[content.id]=content;source.pages[0].children=[mask.id,content.id]
  if(grouped){const group=node('group',0,0,40,20);group.fills=[];group.children=[mask.id,content.id];source.nodes[group.id]=group;source.pages[0].children=[group.id]}
  const packet=JSON.stringify({format:'forma-nodes',version:1,document:source,roots:source.pages[0].children})
  return {before,target,later,source,packet}
}
test.each([false,true])('raw root masks reject atomically without changing existing pixels, nested parent=%s',nested=>{
  const {before,target,later,packet}=fixture(nested,false),snapshot=structuredClone(before),original=before.nodes[later.id]
  const baseline=pixel(before,110,110);expect(baseline).toEqual([255,0,0,255])
  expect(()=>planPasteOverSelection(before,before.pages[0].id,[target.id],packet,'figma-like')).toThrow(/蒙版|遮罩/)
  expect(before).toEqual(snapshot);expect(before.nodes[later.id]).toBe(original)
  expect(pixel(before,110,110)).toEqual(baseline);expect(pixel(before,10,10)).toEqual([0,255,0,255])
})
test.each([false,true])('grouped masks retain actual clip pixels and later siblings, nested parent=%s',nested=>{
  const {before,target,later,source,packet}=fixture(nested,true),snapshot=structuredClone(before)
  expect(pixel(source,10,10)).toEqual([0,0,255,255]);expect(pixel(source,30,10)).toEqual([0,0,0,0])
  const planned=planPasteOverSelection(before,before.pages[0].id,[target.id],packet,'figma-like')
  expect(before).toEqual(snapshot);expect(planned.document.nodes[later.id]).toBe(before.nodes[later.id])
  expect(pixel(planned.document,10,10)).toEqual([0,0,255,255])
  expect(pixel(planned.document,30,10)).toEqual([0,0,0,0])
  expect(pixel(planned.document,110,110)).toEqual([255,0,0,255])
})
