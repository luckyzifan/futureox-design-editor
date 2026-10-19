import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { worldMatrix } from './geometry'
afterEach(()=>vi.unstubAllGlobals())
const fixture=()=>{const d=blank('source'),a=node('rectangle',10,20,30,40),b=node('rectangle',70,80,10,10);d.nodes[a.id]=a;d.nodes[b.id]=b;d.pages[0].children=[a.id,b.id];const editor=new Editor(d);editor.select([a.id]);return {editor,a,b}}
describe('desktop editor commands',()=>{
  it('exports only the selected graph, never unrelated nodes',()=>{
    const f=fixture(),payload=f.editor.exportClipboard()!
    const decoded=JSON.parse(payload)
    expect(Object.keys(decoded.document.nodes)).toEqual([f.a.id])
    expect(payload).not.toContain(f.b.id)
  })
  it('clipboard roundtrip preserves world placement for paste in place and one undo',()=>{
    const f=fixture(),destination=new Editor(blank('target'))
    destination.importClipboard(f.editor.exportClipboard()!);destination.paste(true)
    const pasted=destination.state.selection[0]
    expect(worldMatrix(destination.state.doc,pasted)).toEqual(worldMatrix(f.editor.state.doc,f.a.id))
    destination.undo();expect(Object.keys(destination.state.doc.nodes)).toHaveLength(0)
  })
  it('rejects malformed clipboard before changing destination history',()=>{
    const f=fixture(),before=f.editor.state.doc
    expect(()=>f.editor.importClipboard(JSON.stringify({format:'forma-nodes',version:1,document:blank(),roots:['missing']}))).toThrow()
    expect(f.editor.state.doc).toBe(before)
  })
  it('native readable clipboard uses shape names and authored text instead of the non-text placeholder',async()=>{
    const f=fixture();let written:any
    vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{write:async(value:any)=>{written=value;return{status:'ok'}}}}})
    await dispatchEditorCommand(f.editor,'copy');expect(written.text).toBe(f.a.name)
    f.editor.update([f.a.id],{kind:'text',text:'Authored text'})
    await dispatchEditorCommand(f.editor,'copy');expect(written.text).toBe('Authored text')
    f.editor.dispose()
  })
  it('a failed OS clipboard write does not cut the original selection',async()=>{
    const f=fixture();vi.stubGlobal('window',{coreDesktop:{version:1,clipboard:{write:async()=>({status:'error',message:'unavailable'}),read:async()=>({status:'ok'})}}})
    await dispatchEditorCommand(f.editor,'cut')
    expect(f.editor.state.doc.nodes[f.a.id]).toBeDefined()
    expect(f.editor.state.message).toBe('unavailable')
  })
  it('multi-node reparent uses one history entry and keeps world transforms',()=>{
    const f=fixture(),frame=node('frame',200,300,400,400)
    f.editor.change('frame',d=>{d.nodes[frame.id]=frame;d.pages[0].children.push(frame.id)})
    const before=f.editor.state.doc
    f.editor.reparentMany([f.a.id,f.b.id],frame.id)
    expect(f.editor.state.doc.nodes[frame.id].children).toEqual([f.a.id,f.b.id])
    expect(worldMatrix(f.editor.state.doc,f.a.id)).toEqual(worldMatrix(before,f.a.id))
    f.editor.undo();expect(f.editor.state.doc.nodes[frame.id].children).toEqual([])
  })
  it('rejects a cyclic group drop without mutation',()=>{
    const f=fixture();f.editor.group();const group=f.editor.state.selection[0],before=f.editor.state.doc
    f.editor.reparentMany([group],f.a.id)
    expect(f.editor.state.doc).toBe(before)
  })
  it('native tool commands activate without mutating the document; unknown commands report an error',async()=>{
    const f=fixture()
    await dispatchEditorCommand(f.editor,'set-tool-eraser')
    expect(f.editor.state.tool).toBe('eraser')
    await dispatchEditorCommand(f.editor,'set-tool-eyedropper')
    expect(f.editor.state.tool).toBe('eyedropper')
    const before=f.editor.state.doc
    await dispatchEditorCommand(f.editor,'set-tool-sticky')
    expect(f.editor.state.tool).toBe('sticky')
    expect(f.editor.state.doc).toBe(before)
    await dispatchEditorCommand(f.editor,'set-tool-unknown')
    expect(f.editor.state.tool).toBe('sticky')
    expect(f.editor.state.message).toContain('未知工具命令')
    f.editor.dispose()
  })
})
