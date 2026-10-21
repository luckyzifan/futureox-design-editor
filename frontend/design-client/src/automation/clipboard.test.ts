import {afterEach,expect,test,vi} from 'vitest'
import {Editor} from '../engine'
import {blank,node,paint,defaultTextStyle} from '../model'
import {createEditorDesignAutomation} from './index'
import type {AutomationResponse} from './types'
import {serializeNodePacket,serializePropertyPacket} from '../clipboard-core'
import {registerPendingEdit} from '../pending-edits'
import {pickingGeometryEpoch,kernelTextLayout} from '../kernel/picking'
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).reverse().forEach(fn=>fn());vi.unstubAllGlobals()})
function fixture(operations?:string[],access:'read'|'write'='write'){
 const document=blank(),a=node('rectangle',10,20,30,40),b=node('text',80,20,100,30);b.text='KEEP TARGET';document.nodes={[a.id]:a,[b.id]:b};document.pages[0].children=[a.id,b.id]
 const editor=new Editor(document),api=createEditorDesignAutomation(editor,operations?{grants:[{resource:{documentId:document.id,session:editor.sessionGeneration},operations,access}]}:undefined)
 cleanup.push(()=>editor.dispose(),()=>api.dispose());const fence=()=>({documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
 const call=(method:string,params:Record<string,unknown>={},override={})=>api.execute({method,params,...fence(),...override})
 return {document,a,b,editor,api,fence,call}
}
function result(response:AutomationResponse):Record<string,any>{expect(response.ok).toBe(true);if(!response.ok)throw Error(response.error.code);return response.result as Record<string,any>}
function reject(response:AutomationResponse,code?:string){expect(response.ok).toBe(false);if(!response.ok&&code)expect(response.error.code).toBe(code)}
test('export is read-only, requires all fences, rejects pending/busy/interaction and preserves selection',()=>{
 const f=fixture(),params={nodeIds:[f.a.id],kind:'nodes'},before=f.editor.state.doc,selection=[...f.editor.state.selection],epoch=pickingGeometryEpoch()
 reject(f.api.execute({method:'clipboard.export',params}),'missing_revision');reject(f.call('clipboard.export',params,{expectedRevision:999}),'stale_revision')
 f.editor.state.busy=true;reject(f.call('clipboard.export',params),'editor_busy');f.editor.state.busy=false
 const off=registerPendingEdit(f.editor,{dirty:()=>true,commit:()=>{throw Error('Must not commit input')}});reject(f.call('clipboard.export',params),'pending_edits');off()
 f.editor.begin('pending gesture');reject(f.call('clipboard.export',params),'interaction_active');f.editor.cancel()
 const exported=result(f.call('clipboard.export',params));expect(exported.format).toBe('futureox.design-clipboard.v1');expect(exported.rootCount).toBe(1);expect(exported.byteLength).toBe(new TextEncoder().encode(exported.content).byteLength)
 expect(f.editor.state.doc).toBe(before);expect(f.editor.state.selection).toEqual(selection);expect(f.editor.canUndo).toBe(false);expect(pickingGeometryEpoch()).toBe(epoch)
})
test('node packet commits once, batch receipt replay is inert, undo/redo restore exact authored nodes',()=>{
 const f=fixture(),packet=result(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'})).content,before=f.editor.state.doc,owner=f.fence()
 const params={mutationId:'clipboard-once',operations:[{method:'clipboard.paste',params:{packet,pageId:f.editor.state.page,mode:'inPlace'}}]}
 const pasted=result(f.call('batch.apply',params)),root=pasted.operations[0].result.createdRoots[0],after=f.editor.state.doc
 expect(after.nodes[root].transform).toEqual(before.nodes[f.a.id].transform);expect(f.editor.state.version).toBe(owner.expectedRevision+1);expect(f.editor.state.selection).toEqual([root])
 const replay=result(f.api.execute({method:'batch.apply',params,...owner}));expect(replay.receipt.replayed).toBe(true);expect(f.editor.state.doc).toBe(after)
 reject(f.api.execute({method:'batch.apply',params:{...params,operations:[{method:'clipboard.paste',params:{packet,pageId:f.editor.state.page,mode:'here',position:{x:5,y:6}}}]},...owner}),'mutation_conflict')
 result(f.call('history.undo'));expect(f.editor.state.doc).toEqual(before);result(f.call('history.redo'));expect(f.editor.state.doc).toEqual(after)
})
test('whole-layer properties preserve text and geometry; second locked target fails atomically',()=>{
 const f=fixture(),source=blank(),a=node('text',0,0,100,30);a.text='DO NOT COPY';a.fills=[paint('#aabbcc')];a.fontSize=28;source.nodes[a.id]=a;source.pages[0].children=[a.id]
 const packet=serializePropertyPacket(source,[a.id]),original=f.editor.state.doc.nodes[f.b.id]
 result(f.call('clipboard.pasteProperties',{packet,targetIds:[f.b.id]}));expect(f.editor.state.doc.nodes[f.b.id].text).toBe(original.text);expect(f.editor.state.doc.nodes[f.b.id].transform).toEqual(original.transform);expect(f.editor.state.doc.nodes[f.b.id].fontSize).toBe(28)
 f.editor.change('lock',d=>{d.nodes[f.a.id].locked=true});const before=f.editor.state.doc,version=f.editor.state.version,epoch=pickingGeometryEpoch(),selection=[...f.editor.state.selection]
 reject(f.call('clipboard.pasteProperties',{packet,targetIds:[f.b.id,f.a.id]}));expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(version);expect(pickingGeometryEpoch()).toBe(epoch);expect(f.editor.state.selection).toEqual(selection)
})
test('read scope, exact leaf grants, wrapper grants and cross-session fences remain authoritative',()=>{
 const f=fixture(['clipboard.export','clipboard.paste','batch.apply'],'read');expect(f.api.methods().some(m=>m.name==='clipboard.paste')).toBe(false)
 const packet=result(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'})).content
 reject(f.call('clipboard.paste',{packet,pageId:f.editor.state.page,mode:'inPlace'}),'permission_denied')
 for(const operations of [['batch.apply'],['clipboard.paste']]){const g=fixture(operations);reject(g.call('batch.apply',{operations:[{method:'clipboard.paste',params:{packet,pageId:g.editor.state.page,mode:'inPlace'}}]}),'permission_denied');expect(g.editor.canUndo).toBe(false)}
 reject(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'},{session:f.editor.sessionGeneration+1}),'session_mismatch')
})
test('native invalid-font failure leaves document/history/selection and resident font shaping unchanged',()=>{
 const f=fixture(),source=blank(),a=node('text',0,0,50,20);a.text='font';a.textStyle={...defaultTextStyle(),fontId:'bad-font'};source.fonts={'bad-font':{family:'Bad',data:'AA=='}};source.nodes[a.id]=a;source.pages[0].children=[a.id]
 const packet=serializeNodePacket(source,[a.id]),before=f.editor.state.doc,version=f.editor.state.version,selection=[...f.editor.state.selection],epoch=pickingGeometryEpoch(),probe=node('text',0,0,100,20);probe.text='font probe'
 const shape=kernelTextLayout(probe);reject(f.call('clipboard.paste',{packet,pageId:f.editor.state.page,mode:'inPlace'}));expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(version);expect(f.editor.state.selection).toEqual(selection);expect(f.editor.canUndo).toBe(false);expect(pickingGeometryEpoch()).toBe(epoch);expect(kernelTextLayout(probe)).toEqual(shape)
})
test('committed receipt remains old-owner on reentrant same-ID reopen',()=>{
 const f=fixture(),packet=result(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'})).content,owner=f.fence();let entered=false,adopted:Editor['state']|undefined
 const off=f.editor.subscribe(()=>{if(entered||f.editor.state.version!==owner.expectedRevision+1)return;entered=true;const next=structuredClone(f.document);next.nodes[f.a.id].name='NEW OWNER';f.editor.load(next);f.editor.select([f.b.id]);adopted=f.editor.state});cleanup.push(off)
 const response=f.api.execute({method:'batch.apply',...owner,params:{mutationId:'clipboard-reentrant',operations:[{method:'clipboard.paste',params:{packet,pageId:f.editor.state.page,mode:'inPlace'}}]}}),pasted=result(response)
 expect(entered).toBe(true);expect(pasted.completion).toMatchObject({status:'committed',superseded:true,contextApplied:false,retry:'do-not-retry'});expect(response.session).toBe(owner.session);expect(f.editor.state).toBe(adopted);expect(f.editor.state.selection).toEqual([f.b.id])
})
test('strict schema, no OS/network access and full escaped Core request budget',()=>{
 const f=fixture(),fail=vi.fn(()=>{throw Error('Forbidden IO')});vi.stubGlobal('fetch',fail);vi.stubGlobal('navigator',{clipboard:{readText:fail,writeText:fail}})
 const packet=result(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'})).content
 reject(f.call('clipboard.paste',{packet,pageId:f.editor.state.page,mode:'inPlace',position:{x:1,y:1}}),'invalid_params')
 reject(f.call('clipboard.paste',{packet,pageId:'missing',mode:'inPlace'}));reject(f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes',owner:'forged'}),'invalid_params')
 reject(f.call('clipboard.paste',{packet:'x'.repeat(32*1024*1024),pageId:f.editor.state.page,mode:'inPlace'}),'request_budget');expect(fail).not.toHaveBeenCalled()
})
test('whole-layer clipboard edits capture instance overrides without editing the main component',async()=>{
 const {componentFixture,originNode}=await import('../component-fixtures');const {doc,ids}=componentFixture(),editor=new Editor(doc),api=createEditorDesignAutomation(editor);cleanup.push(()=>editor.dispose(),()=>api.dispose())
 const key=editor.state.doc.nodes[ids.label].componentKey!,target=originNode(editor.state.doc,ids.a,key),source=blank(),style=node('rectangle');style.fills=[paint('#123abc')];source.nodes[style.id]=style;source.pages[0].children=[style.id]
 const packet=serializePropertyPacket(source,[style.id],'fills'),before=editor.state.doc,master=before.nodes[ids.label].fills
 const call=(method:string,params={})=>api.execute({method,params,documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
 result(call('clipboard.pasteProperties',{packet,targetIds:[target.id]}));expect(originNode(editor.state.doc,ids.a,key).fills).toEqual(style.fills);expect(editor.state.doc.nodes[ids.label].fills).toEqual(master);expect(editor.state.doc.nodes[ids.a].instance!.overrides[key]?.fills).toEqual(style.fills)
 result(call('history.undo'));expect(editor.state.doc).toEqual(before)
})
test('node clipboard preserves internal prototype and animation through native commit and history',async()=>{
 const {createClip}=await import('../animation'),f=fixture(),source=blank(),a=node('frame',10,20,40,50),b=node('frame',100,20,40,50);source.schemaVersion=5;source.nodes={[a.id]:a,[b.id]:b};source.pages[0].children=[a.id,b.id]
 source.prototype={startNode:a.id,interactions:{[a.id]:[{trigger:'click',actions:[{kind:'navigate',target:b.id,durationMs:200}]}]}};source.animations=[createClip(source,source.pages[0].id,[a.id,b.id])]
 const before=f.editor.state.doc,packet=serializeNodePacket(source,[a.id,b.id]),pasted=result(f.call('clipboard.paste',{packet,pageId:f.editor.state.page,mode:'inPlace'})),roots=pasted.operations[0].result.createdRoots,after=f.editor.state.doc
 expect(after.prototype!.startNode).toBe(roots[0]);expect(after.prototype!.interactions[roots[0]][0].actions[0].target).toBe(roots[1]);expect(after.animations![0].tracks.map(track=>track.nodeId)).toEqual(source.animations![0].tracks.map(track=>track.nodeId===a.id?roots[0]:roots[1]))
 result(f.call('history.undo'));expect(f.editor.state.doc).toEqual(before);result(f.call('history.redo'));expect(f.editor.state.doc).toEqual(after)
})
