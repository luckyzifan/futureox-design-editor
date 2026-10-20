import {test,expect} from 'vitest'
import {Editor} from './engine'
import {blank,node,validateDocument} from './model'
import {createEditorDesignAutomation} from './automation'
import {encodeDocumentBinary,decodeDocumentBinary} from './kernel/binfmt'
import {initialPrototype,prototypeEvent} from './prototype'
test('real kernel MCP batch, native undo/redo, FD reopen and preview preserve nested logic',()=>{
 const d=blank(),n=node('frame');d.nodes[n.id]=n;d.pages[0].children=[n.id]
 const editor=new Editor(d),api=createEditorDesignAutomation(editor)
 const event={trigger:'click',actions:[{kind:'if',expression:{kind:'literal',value:true},thenActions:[{kind:'if',expression:{kind:'literal',value:false},thenActions:[],elseActions:[{kind:'overlay',target:n.id}]}],elseActions:[]}]}
 const call=(method:string,params:Record<string,unknown>)=>api.execute({method,params,documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
 try{
   const before=editor.state.doc
   const result=call('batch.apply',{operations:[{method:'prototype.interaction.set',params:{nodeId:n.id,index:0,interaction:event}},{method:'node.update',params:{ids:[n.id],patch:{name:'Logic target'}}}]})
   expect(result.ok,JSON.stringify(result)).toBe(true)
   const after=editor.state.doc
   expect(after.schemaVersion).toBe(15);expect(after.prototype!.interactions[n.id][0]).toEqual(event)
   editor.undo();expect(editor.state.doc).toBe(before);editor.redo();expect(editor.state.doc).toBe(after)
   const reopened=validateDocument(decodeDocumentBinary(encodeDocumentBinary(after)))
   expect(reopened.prototype).toEqual(after.prototype)
   expect(prototypeEvent(reopened,initialPrototype(reopened),n.id,'click').overlays).toEqual([n.id])
   const rejected=call('batch.apply',{operations:[{method:'node.update',params:{ids:[n.id],patch:{name:'Must rollback'}}},{method:'prototype.interaction.set',params:{nodeId:n.id,index:0,interaction:{...event,actions:[{kind:'if',expression:{kind:'literal',value:4},thenActions:[],elseActions:[]}]}}}]})
   expect(rejected.ok).toBe(false);expect(editor.state.doc).toBe(after)
 }finally{api.dispose();editor.dispose()}
})
