import { afterEach, expect, test, vi } from 'vitest'
import { Editor, type EditorEditEvent } from './engine'
import { blank, node } from './model'
const editors:Editor[]=[]
afterEach(()=>{vi.restoreAllMocks();editors.splice(0).forEach(e=>e.dispose());vi.unstubAllGlobals()})
test.each((['change','undo','redo'] as const).flatMap(kind=>([false,true] as const).map(load=>({kind,load}))))('$kind retains committed completion when subscriber throws (same-ID load=$load)',async({kind,load})=>{
 const reported:unknown[]=[];vi.stubGlobal('reportError',(error:unknown)=>reported.push(error))
 const failure=new Error('throw-once subscriber fixture')
 const document=blank(),n=node('rectangle');document.nodes[n.id]=n;document.pages[0].children.push(n.id)
 const editor=new Editor(document);editors.push(editor)
 if(kind!=='change'){editor.update([n.id],{width:120});if(kind==='redo')editor.undo()}
 const session=editor.sessionGeneration,revision=editor.state.version,documentId=editor.state.doc.id,replacement=blank();replacement.id=documentId
 const events:EditorEditEvent[]=[];let entered=false,captured:Editor['state']|undefined
 const offEdit=editor.subscribeEdits(event=>events.push(event))
 const off=editor.subscribe(()=>{if(entered||editor.state.version!==revision+1)return;entered=true;captured=editor.state;if(load)expect(editor.load(replacement)).toBe(true);throw failure})
 let result:unknown,thrown:unknown
 try{if(kind==='change')result=editor.change('width',d=>{d.nodes[n.id].width=120});else if(kind==='undo')result=editor.undo();else result=editor.redo()}catch(error){thrown=error}
 expect(entered).toBe(true);expect(captured?.version).toBe(revision+1)
 expect(captured?.doc.nodes[n.id].width).toBe(kind==='undo'?n.width:120)
 if(load)expect(editor.sessionGeneration).toBe(session+1)
 // Accepted mutations must never be represented as rejected/retryable work.
 expect(thrown).toBeUndefined();expect(result).toMatchObject({status:'committed',revision:revision+1})
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({documentId,session,revision:revision+1})
 expect(reported).toEqual([]);await Promise.resolve();expect(reported).toEqual([failure]);off();offEdit()
})
test('ordinary set still throws synchronously and does not continue later listeners',()=>{
 const editor=new Editor(blank());editors.push(editor);const failure=new Error('ordinary subscriber'),calls:string[]=[]
 editor.subscribe(()=>{calls.push('first');throw failure});editor.subscribe(()=>calls.push('later'))
 expect(()=>editor.set({message:'ordinary'})).toThrow(failure);expect(calls).toEqual(['first']);expect(editor.state.message).toBe('ordinary')
})
test('accepted change preserves stop-on-first-listener ordering, audit precedes host error report',async()=>{
 const editor=new Editor(blank());editors.push(editor);const order:string[]=[],failure=new Error('committed subscriber')
 vi.stubGlobal('reportError',(error:unknown)=>{expect(error).toBe(failure);order.push('error')})
 editor.subscribe(()=>{order.push('first');throw failure});editor.subscribe(()=>order.push('later'));editor.subscribeEdits(()=>order.push('audit'))
 const result=editor.change('name',d=>{d.name='changed'});expect(result.status).toBe('committed');expect(editor.committedEditReceipt(result)).toBeDefined();expect(order).toEqual(['first','audit'])
 await Promise.resolve();expect(order).toEqual(['first','audit','error'])
})
test('prepublication camera failure is not converted into successful subscriber completion',()=>{
 const editor=new Editor(blank());editors.push(editor);editor.addPage()
 const reported=vi.fn();vi.stubGlobal('reportError',reported)
 const failure=new Error('camera storage fixture'),before=editor.state
 vi.spyOn((editor as unknown as {cameraState:{remember:(...args:unknown[])=>unknown}}).cameraState,'remember').mockImplementation(()=>{throw failure})
 expect(()=>editor.undo()).toThrow(failure);expect(editor.state).toBe(before);expect(reported).not.toHaveBeenCalled()
})
test.each([false,true])('pointer commit does not roll back accepted history after subscriber error (same-ID load=%s)',async load=>{
 const document=blank(),n=node('rectangle');document.nodes[n.id]=n;document.pages[0].children.push(n.id)
 const editor=new Editor(document);editors.push(editor);editor.begin('resize');editor.preview({[n.id]:{width:120}})
 const session=editor.sessionGeneration,revision=editor.state.version,replacement=blank();replacement.id=document.id;const reported:unknown[]=[],events:EditorEditEvent[]=[];let entered=false
 const failure=new Error('pointer subscriber');vi.stubGlobal('reportError',(error:unknown)=>reported.push(error));editor.subscribeEdits(event=>events.push(event))
 editor.subscribe(()=>{if(entered||editor.state.version!==revision+1)return;entered=true;if(load)editor.load(replacement);throw failure})
 expect(()=>editor.commit()).not.toThrow();expect(entered).toBe(true)
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({documentId:document.id,session,revision:revision+1})
 if(!load){expect(editor.state.doc.nodes[n.id].width).toBe(120);expect(editor.canUndo).toBe(true)}else expect(editor.sessionGeneration).toBe(session+1)
 await Promise.resolve();expect(reported).toEqual([failure])
})
