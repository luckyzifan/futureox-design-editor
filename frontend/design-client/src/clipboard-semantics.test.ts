import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { createClip } from './animation'
import { emptySystem } from './design-system'
import { initialPrototype, prototypeEvent } from './prototype'
import { multiply, translate, worldMatrix } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { insertInstance, stampKeys } from './components'

afterEach(() => vi.unstubAllGlobals())
function prototypeFixture() {
  const document = blank('closed flow'), a = node('frame', 10, 20, 100, 120), b = node('frame', 200, 20, 100, 120), unrelated = node('rectangle')
  document.schemaVersion = 4
  document.nodes = Object.fromEntries([a,b,unrelated].map(n => [n.id,n])); document.pages[0].children = [a.id,b.id,unrelated.id]
  const system = document.designSystem = emptySystem()
  system.collections.theme = { name: 'Theme', modes: ['default','other'], defaultMode: 'default' }
  system.activeModes.theme = 'default'
  system.variables.level = { name:'Level',collection:'theme',kind:'number',values:{default:0.5,other:0.7} }
  system.variables.alias = { name:'Alias',collection:'theme',kind:'number',values:{default:{alias:'level'},other:{alias:'level'}} }
  system.variables.unrelated = { name:'Not copied',collection:'theme',kind:'number',values:{default:99,other:99} }
  a.bindings = { opacity:'level' }
  document.prototype = { startNode:a.id, interactions:{
    [a.id]:[{trigger:'click',actions:[{kind:'set-variable',target:'level',value:1},{kind:'navigate',target:b.id,durationMs:220}]}],
    [b.id]:[{trigger:'hover',condition:{variable:'alias',equals:0.5},actions:[{kind:'overlay',target:a.id}]}],
  } }
  const editor = new Editor(document); editor.select([a.id,b.id])
  return { editor,a,b,unrelated }
}
function animationFixture() {
  const document = blank('nested animation'), parent = node('frame',0,0,400,400), child=node('rectangle',10,20,40,60), unrelated=node('ellipse',300,200,20,20)
  parent.transform=[2,0.4,0.3,1.5,100,200]; parent.fills=[]; parent.children=[child.id,unrelated.id]
  document.nodes=Object.fromEntries([parent,child,unrelated].map(n=>[n.id,n]));document.pages[0].children=[parent.id]
  const clip=createClip(document,document.pages[0].id,[child.id,unrelated.id]);clip.name='turn and move';clip.repeat='alternate';clip.delayMs=30
  const track=clip.tracks.find(t=>t.nodeId===child.id)!
  const angle=0.9;track.keyframes[1].value.transform=[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),80,-5];track.rotationTurns=1
  document.animations=[clip]
  const editor=new Editor(document);editor.select([child.id]);return {editor,parent,child,unrelated,clip}
}

describe('portable clipboard behavior preservation',()=>{
  it('copies a closed prototype, reachable variable aliases and shared binding identities without unrelated nodes/resources',()=>{
    const f=prototypeFixture(), encoded=f.editor.exportClipboard()!, payload=JSON.parse(encoded)
    expect(encoded).not.toContain(f.unrelated.id)
    expect(Object.keys(payload.document.designSystem.variables).sort()).toEqual(['alias','level'])
    const target=blank('destination');target.schemaVersion=4;target.designSystem=emptySystem()
    target.designSystem.collections.theme={name:'Existing',modes:['default'],defaultMode:'default'}
    target.designSystem.variables.level={name:'Existing level',kind:'number',collection:'theme',values:{default:0.9}}
    target.designSystem.variables.alias={name:'Existing alias',kind:'number',collection:'theme',values:{default:0.8}}
    const destination=new Editor(target), before=destination.state.doc
    destination.importClipboard(encoded);destination.paste(true)
    const [a,b]=destination.state.selection,p=destination.state.doc.prototype!
    expect(p.startNode).toBe(a)
    expect(p.interactions[a][0].actions[1].target).toBe(b)
    expect(p.interactions[b][0].actions[0].target).toBe(a)
    const variable=p.interactions[a][0].actions[0].target!
    expect(variable).not.toBe('level')
    expect(destination.state.doc.nodes[a].bindings!.opacity).toBe(variable)
    const alias=p.interactions[b][0].condition!.variable
    expect(alias).not.toBe('alias')
    expect(destination.state.doc.designSystem!.variables[alias].values.default).toEqual({alias:variable})
    const state=prototypeEvent(destination.state.doc,initialPrototype(destination.state.doc),a,'click')
    expect(state.current).toBe(b);expect(state.values[variable]).toBe(1)
    destination.undo();expect(destination.state.doc).toEqual(before)
    destination.redo();expect(destination.state.doc.prototype?.startNode).toBe(a)
  })

  it.each([true,false])('keeps nested animation curves under a static affine parent (inPlace=%s), remaps clip/node/page IDs and undoes atomically',inPlace=>{
    const f=animationFixture(), source=f.editor.state.doc, encoded=f.editor.exportClipboard()!, payload=JSON.parse(encoded)
    expect(encoded).not.toContain(f.unrelated.id)
    expect(encoded).not.toContain(f.parent.id)
    expect(payload.document.animations[0].tracks).toHaveLength(1)
    expect(payload.document.animations[0].tracks[0].keyframes).toEqual(source.animations![0].tracks.find(t=>t.nodeId===f.child.id)!.keyframes)
    const destination=new Editor(blank('target')), before=destination.state.doc
    destination.importClipboard(encoded);destination.paste(inPlace)
    const id=destination.state.selection[0], copied=destination.state.doc, clip=copied.animations![0]
    expect(copied.nodes[id].kind).toBe('rectangle')
    expect(id).not.toBe(f.child.id);expect(clip.id).not.toBe(f.clip.id);expect(clip.pageId).toBe(copied.pages[0].id)
    expect(clip.tracks[0].nodeId).toBe(id);expect(clip.delayMs).toBe(30);expect(clip.repeat).toBe('alternate')
    const engine=new VectorEngine()
    try {
      for(const timeMs of [0,30,137,500,863,1030]) {
        const a=JSON.parse(engine.animation_document(JSON.stringify(source),JSON.stringify({clipId:f.clip.id,timeMs}))) as DesignDocument
        const b=JSON.parse(engine.animation_document(JSON.stringify(copied),JSON.stringify({clipId:clip.id,timeMs}))) as DesignDocument
        const expected=multiply(translate(inPlace?0:10,inPlace?0:10),worldMatrix(a,f.child.id)), actual=worldMatrix(b,id)
        actual.forEach((value,index)=>expect(value).toBeCloseTo(expected[index],11))
      }
    } finally { engine.free() }
    destination.undo()
    // The Rust history canonically represents the removed optional animation
    // collection as []; its document graph and all behavior are restored once.
    expect({ ...destination.state.doc, animations: destination.state.doc.animations || [] }).toEqual({ ...before, animations: before.animations || [] })
    destination.redo();expect(destination.state.doc.animations![0].tracks[0].nodeId).toBe(id)
  })

  it('rejects outgoing external prototype targets before the native clipboard write or Cut deletion',async()=>{
    const f=prototypeFixture();f.editor.select([f.a.id]);const before=f.editor.state.doc,write=vi.fn(async()=>({status:'ok' as const}))
    vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{write}}})
    await dispatchEditorCommand(f.editor,'cut')
    expect(write).not.toHaveBeenCalled();expect(f.editor.state.doc).toBe(before)
    expect(f.editor.state.message).toContain('选区外目标')
  })

  it('allows ordinary copy of an incoming target but refuses Cut that would destroy an external interaction',async()=>{
    const d=blank('incoming'),a=node('frame'),b=node('frame');d.schemaVersion=4;d.nodes={[a.id]:a,[b.id]:b};d.pages[0].children=[a.id,b.id]
    d.prototype={interactions:{[a.id]:[{trigger:'click',actions:[{kind:'navigate',target:b.id}]}]}}
    const editor=new Editor(d);editor.select([b.id]);expect(editor.exportClipboard()).toBeTruthy()
    expect(()=>editor.exportClipboard(true)).toThrow('选区外的原型交互')
    const write=vi.fn(async()=>({status:'ok' as const})),before=editor.state.doc
    vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{write}}})
    await dispatchEditorCommand(editor,'cut')
    expect(write).not.toHaveBeenCalled();expect(editor.state.doc).toBe(before)
  })

  it('rejects animated ancestors that lie outside the copied graph even when the child has no own track',()=>{
    const f=animationFixture(), document=structuredClone(f.editor.state.doc)
    document.animations=[createClip(document,document.pages[0].id,[f.parent.id])]
    document.animations[0].tracks=document.animations[0].tracks.filter(track=>track.nodeId===f.parent.id)
    const editor=new Editor(document);editor.select([f.child.id]);const before=editor.state.doc
    expect(()=>editor.exportClipboard()).toThrow('动画父级')
    expect(editor.state.doc).toBe(before)
  })

  it('preserves a main component definition with its own animation instead of turning it into an instance',()=>{
    const d=blank('animated component'),root=node('frame',10,20,100,80);root.component={variants:{},properties:{}}
    d.schemaVersion=4;d.nodes={[root.id]:root};d.pages[0].children=[root.id];stampKeys(d,root.id)
    d.animations=[createClip(d,d.pages[0].id,[root.id])]
    const source=new Editor(d);source.select([root.id]);const destination=new Editor(blank())
    destination.importClipboard(source.exportClipboard()!);destination.paste(true)
    const imported=destination.state.doc.nodes[destination.state.selection[0]]
    expect(imported.component).toBeDefined();expect(imported.instance).toBeUndefined()
    expect(destination.state.doc.animations![0].tracks[0].nodeId).toBe(imported.id)
    const plain=structuredClone(d);delete plain.animations
    const simple=new Editor(plain);simple.select([root.id]);const target=new Editor(blank())
    target.importClipboard(simple.exportClipboard()!);target.paste(true)
    expect(target.state.doc.nodes[target.state.selection[0]].instance).toBeDefined()
  })

  it('explicitly rejects behavior on an unselected component dependency and conflicting destination prototype starts',()=>{
    const d=blank('component reference'),root=node('frame',10,20,100,80);root.component={variants:{},properties:{}}
    d.schemaVersion=4;d.nodes={[root.id]:root};d.pages[0].children=[root.id];stampKeys(d,root.id)
    const instance=insertInstance(d,root.id,d.pages[0].id,{x:200,y:10})
    d.prototype={interactions:{[root.id]:[{trigger:'click',actions:[{kind:'back'}]}]}}
    const editor=new Editor(d);editor.select([instance]);expect(()=>editor.exportClipboard()).toThrow('主组件带有原型或动画')
    editor.select([root.id]);expect(()=>editor.exportClipboard(true)).toThrow('选区外实例')
    const f=prototypeFixture(),destination=new Editor(f.editor.state.doc),before=destination.state.doc
    destination.importClipboard(f.editor.exportClipboard()!);destination.paste(true)
    expect(destination.state.doc).toBe(before);expect(destination.state.message).toContain('已有原型起点')
  })
})
