import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank,node } from './model'
import { createPresetFrame,framePlacementRight,filterFramePresets,framePresets,validFrameSize } from './frame-presets'

test('reference catalogue preserves logical sizes, category and searchable names',()=>{
  expect(framePresets).toHaveLength(32)
  expect(new Set(framePresets.map(p=>p.id)).size).toBe(32)
  expect(filterFramePresets('iPhone 13','phone')).toHaveLength(3)
  expect(filterFramePresets('375 812','phone')).toHaveLength(2)
  expect(filterFramePresets('iPhone','desktop')).toEqual([])
  expect(framePresets.find(p=>p.name==='iPhone 13 / 13 Pro')).toMatchObject({width:390,height:844})
  expect(framePresets.every(p=>validFrameSize(p.width,p.height))).toBe(true)
})
test('preset creates selected editable frame at page root with one undo/redo, even with locked hidden selection',()=>{
  const doc=blank(), parent=node('frame',500,50,1000,700);parent.locked=true;parent.visible=false;doc.nodes[parent.id]=parent;doc.pages[0].children.push(parent.id)
  const editor=new Editor(doc);editor.select([parent.id]);const before=editor.state.doc
  try {
    const result=createPresetFrame(editor,{name:'iPhone 13 / 13 Pro',width:390,height:844});expect(result.ok).toBe(true)
    const id=result.id!, created=editor.state.doc.nodes[id]
    expect(created).toMatchObject({kind:'frame',name:'iPhone 13 / 13 Pro',width:390,height:844,locked:false,visible:true,clip:true})
    expect(created.transform[4]).toBeGreaterThanOrEqual(1564)
    expect(editor.state.doc.nodes[parent.id].children).toEqual([])
    expect(editor.state.doc.pages[0].children).toContain(id);expect(editor.state.selection).toEqual([id]);expect(editor.revealSnapshot()?.ids).toEqual([id])
    editor.undo();expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
    editor.redo();expect(editor.state.doc.nodes[id].width).toBe(390)
    editor.update([id],{width:420,name:'My editable frame'},'编辑画板');expect(editor.state.doc.nodes[id].width).toBe(420)
  }finally{editor.dispose()}
})
test('invalid dimensions and busy state never insert a frame or create history',()=>{
  const editor=new Editor(blank()), before=editor.state.doc
  try {
    for(const width of [NaN,Infinity,0,-1,0.5,100001])expect(createPresetFrame(editor,{name:'x',width,height:10}).ok).toBe(false)
    editor.set({busy:true});expect(createPresetFrame(editor,{name:'x',width:100,height:100}).ok).toBe(false)
    expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  }finally{editor.dispose()}
})
test('successive creations are separated, orientation dimensions remain authored and document round-trips',()=>{
  const editor=new Editor(blank())
  try {
    const a=createPresetFrame(editor,{name:'Landscape',width:844,height:390}).id!,b=createPresetFrame(editor,{name:'Portrait',width:390,height:844}).id!
    expect(editor.state.doc.nodes[b].transform[4]).toBeGreaterThanOrEqual(editor.state.doc.nodes[a].transform[4]+844+64)
    const restored=new Editor(JSON.parse(JSON.stringify(editor.state.doc)))
    try{expect(restored.state.doc.nodes[a]).toMatchObject({kind:'frame',width:844,height:390,name:'Landscape'})}finally{restored.dispose()}
  }finally{editor.dispose()}
})

test('placement walk handles pathological import depth iteratively and rejects cycles or missing links',()=>{
  const doc=blank(),depth=15000
  for(let i=0;i<depth;i++){
    const n=node('group',1,0,1,1);n.id=`deep-${i}`;n.children=i+1<depth?[`deep-${i+1}`]:[];doc.nodes[n.id]=n
  }
  doc.pages[0].children=['deep-0']
  expect(framePlacementRight(doc,doc.pages[0].id)).toBe(depth+1)
  doc.nodes[`deep-${depth-1}`].children=['deep-0']
  expect(()=>framePlacementRight(doc,doc.pages[0].id)).toThrow('Invalid frame placement hierarchy')
  doc.nodes[`deep-${depth-1}`].children=['missing']
  expect(()=>framePlacementRight(doc,doc.pages[0].id)).toThrow('Invalid frame placement hierarchy')
})
test('placement rejects shared child references and nonfinite geometry without silently guessing',()=>{
 const doc=blank(),a=node('group'),b=node('rectangle');a.children=[b.id];doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
 expect(()=>framePlacementRight(doc,doc.pages[0].id)).toThrow('Invalid frame placement hierarchy')
 doc.pages[0].children=[a.id];b.transform[4]=Infinity
 expect(()=>framePlacementRight(doc,doc.pages[0].id)).toThrow('Invalid frame placement bounds')
})
