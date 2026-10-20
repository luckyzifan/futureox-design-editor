import { afterEach, expect, test, vi } from 'vitest'
import { Editor, type EditorEditEvent } from './engine'
import { blank, node } from './model'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
test.each((['change','commit','undo','redo'] as const).flatMap(kind=>(['same-id','new-id'] as const).map(replacementKind=>({kind,replacementKind}))))('$kind audit retains original committed owner after synchronous $replacementKind load',({kind,replacementKind})=>{
 const document=blank(),n=node('rectangle');document.nodes[n.id]=n;document.pages[0].children.push(n.id)
 const editor=new Editor(document);editors.push(editor);editor.select([n.id])
 if(kind==='undo'||kind==='redo'){editor.update([n.id],{width:120});if(kind==='redo')editor.undo()}
 if(kind==='commit'){editor.begin('resize');editor.preview({[n.id]:{width:120}})}
 const session=editor.sessionGeneration,revision=editor.state.version,documentId=editor.state.doc.id
 const replacement=blank();if(replacementKind==='same-id')replacement.id=documentId
 const diagnostics=vi.spyOn((editor as unknown as {operationDiagnostics:{finish:(...args:unknown[])=>void}}).operationDiagnostics,'finish')
 const events:EditorEditEvent[]=[],order:string[]=[];let entered=false
 const off=editor.subscribeEdits(event=>{events.push(event);order.push('audit')})
 const unsubscribe=editor.subscribe(()=>{if(entered||editor.state.version!==revision+1)return;entered=true;expect(editor.load(replacement)).toBe(true);order.push('load')})
 let result:ReturnType<Editor['change']>|undefined
 if(kind==='change')result=editor.change('resize',d=>{d.nodes[n.id].width=120},undefined,undefined,'automation')
 else if(kind==='commit')editor.commit();else if(kind==='undo')result=editor.undo('automation');else result=editor.redo('automation')
 expect(entered).toBe(true);expect(editor.sessionGeneration).toBe(session+1);expect(editor.state.doc.id).toBe(replacement.id)
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({documentId,session,revision:revision+1,kind:kind==='change'||kind==='commit'?'edit':kind,source:kind==='commit'?'user':'automation'})
 expect(order).toEqual(['load','audit']);const finish=diagnostics.mock.calls.filter(args=>args[1]==='committed').at(-1);expect(finish?.slice(2,4)).toEqual([session,revision+1]);expect((finish?.[4] as {id:string}).id).toBe(documentId);if(result){expect(result).toMatchObject({status:'committed',revision:revision+1});const receipt=editor.committedEditReceipt(result)!;expect(receipt).toMatchObject({documentId,session,revision:revision+1});expect(receipt.document).not.toBe(editor.state.doc)}
 unsubscribe();off();diagnostics.mockRestore()
})
