import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
const editors:Editor[]=[]
afterEach(()=>editors.splice(0).forEach(e=>e.dispose()))
function fixture(){const doc=blank(),n=node('rectangle');doc.nodes[n.id]=n;doc.pages[0].children.push(n.id);const editor=new Editor(doc);editors.push(editor);return {editor,n}}
test('only actual committed result resolves a frozen per-editor receipt; JSON shape is unchanged',()=>{
 const {editor,n}=fixture(),session=editor.sessionGeneration,page=editor.state.page,revision=editor.state.version
 const selection=[n.id],result=editor.change('width',d=>{d.nodes[n.id].width=120},selection)
 expect(result).toEqual({status:'committed',revision:revision+1})
 const receipt=editor.committedEditReceipt(result)!
 expect(Object.isFrozen(receipt)).toBe(true);expect(Object.isFrozen(receipt.selection)).toBe(true);expect(editor.committedEditReceipt(result)).toBe(receipt);expect(receipt).toMatchObject({canUndo:true,canRedo:false});expect(receipt.document).toBe(editor.state.doc)
 expect(receipt).toMatchObject({documentId:editor.state.doc.id,session,revision:revision+1,pageId:page});selection.length=0;expect(receipt.selection).toEqual([n.id])
 for(const copy of [JSON.parse(JSON.stringify(result)),{...result},null,undefined,'committed'])expect(editor.committedEditReceipt(copy)).toBeUndefined()
 expect(fixture().editor.committedEditReceipt(result)).toBeUndefined()
 const rejected=editor.change('invalid',()=>{throw new Error('rejected fixture')});expect(rejected.status).toBe('rejected');expect(editor.committedEditReceipt(rejected)).toBeUndefined()
 const unchanged=editor.change('unchanged',()=>{});expect(unchanged.status).toBe('unchanged');expect(editor.committedEditReceipt(unchanged)).toBeUndefined()
})
test('same-ID subscriber load cannot substitute current document into committed receipt',()=>{
 const {editor,n}=fixture(),session=editor.sessionGeneration,revision=editor.state.version,documentId=editor.state.doc.id,pageId=editor.state.page
 const replacement=blank();replacement.id=documentId;let entered=false,captured:Editor['state']['doc']|undefined
 const off=editor.subscribe(()=>{if(entered||editor.state.version!==revision+1)return;entered=true;captured=editor.state.doc;expect(editor.load(replacement)).toBe(true)})
 const result=editor.change('width',d=>{d.nodes[n.id].width=120}),receipt=editor.committedEditReceipt(result)!
 expect(entered).toBe(true);expect(receipt.document).toBe(captured);expect(receipt.document).not.toBe(editor.state.doc);expect(receipt.document.nodes[n.id].width).toBe(120)
 expect(receipt).toMatchObject({documentId,session,revision:revision+1,pageId});expect(result.revision).toBe(revision+1);expect(editor.sessionGeneration).toBe(session+1);expect(receipt.canUndo).toBe(true);expect(editor.canUndo).toBe(false);off()
})
test('history returns receipts only on committed Undo/Redo; no-op and preview cancellation remain undefined',async()=>{
 const {editor,n}=fixture();expect(editor.undo()).toBeUndefined();expect(editor.redo()).toBeUndefined()
 editor.select([n.id]);editor.update([n.id],{width:120})
 const undo=editor.undo(),undoReceipt=editor.committedEditReceipt(undo)!
 expect(undoReceipt.document.nodes[n.id].width).toBe(n.width);expect(undoReceipt).toMatchObject({canUndo:false,canRedo:true,selection:[n.id]})
 const redo=editor.redo(),redoReceipt=editor.committedEditReceipt(redo)!
 expect(redoReceipt.document.nodes[n.id].width).toBe(120);expect(redoReceipt).toMatchObject({canUndo:true,canRedo:false})
 const {ColorEditSession}=await import('./color-edit-session')
 const session=ColorEditSession.open(editor,{kind:'solid-fill',nodeId:n.id,fillIndex:0,fillId:editor.state.doc.nodes[n.id].fills[0].id})!
 expect(session.update({color:'#abcdef'})).toBe('preview');const revision=editor.state.version
 const cancelled=editor.undo();expect(cancelled).toBeUndefined();expect(editor.committedEditReceipt(cancelled)).toBeUndefined();expect(editor.state.version).toBe(revision);expect(editor.propertyPreviewActive).toBe(false)
})
