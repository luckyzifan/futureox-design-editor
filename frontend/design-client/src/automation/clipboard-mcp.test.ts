import {afterEach,expect,test,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {Editor} from '../engine'
import {blank,node,paint} from '../model'
import {createEditorDesignAutomation} from './index'
import {attachDesktopAutomation,type DesktopAutomationTransport,type DesktopAutomationRequest} from './bridge'
import {DesignMcpServer} from '../../../design-mcp/src/server.mjs'
// @ts-expect-error Existing production runtime JS intentionally has no TS declarations.
import {SocketDesignBackend} from '../../../design-mcp/src/socket-backend.mjs'
// @ts-expect-error Existing production desktop runtime JS intentionally has no TS declarations.
import {LocalAutomationBridge} from '../../../design-desktop/src/automation-bridge.mjs'
type Json=Record<string,any>
const cleanup:(()=>void|Promise<void>)[]=[]
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllGlobals()})
/** Only transport is in memory. Production bridge authentication/authorization,
 * socket backend, protocol, artifact projection and real Editor all execute. */
class MemorySocket extends EventEmitter{
 destroyed=false;writableLength=0;peer!:MemorySocket
 setTimeout(){}
 write(bytes:unknown,callback?:()=>void){queueMicrotask(()=>{if(!this.destroyed&&!this.peer.destroyed)this.peer.emit('data',Buffer.from(bytes as string));callback?.()});return true}
 destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('close');this.peer?.destroy()}
 end(){this.destroy()}
}
async function fixture(large=false,scope:'read'|'write'='write'){
 const document=blank(),a=node('rectangle',10,20,30,40);document.nodes[a.id]=a;document.pages[0].children=[a.id]
 if(large){const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');a.fills=[{...paint('#ffffff'),kind:'image',image:'data:image/png;base64,'+Buffer.concat([png,Buffer.alloc(7*1024*1024)]).toString('base64')}]}
 const editor=new Editor(document),api=createEditorDesignAutomation(editor),dispatched:string[]=[]
 let rendererReceive:((payload:DesktopAutomationRequest)=>void)|undefined,rendererCancel:((value:{requestId:string})=>void)|undefined,rendererSerial=0
 const rendererWaiters=new Map<string,{resolve:(value:unknown)=>void;reject:(reason:unknown)=>void}>()
 const bridge=new LocalAutomationBridge({dispatch:(payload:Json,signal:AbortSignal)=>new Promise((resolve,reject)=>{const requestId='renderer-'+(++rendererSerial);rendererWaiters.set(requestId,{resolve,reject});if(payload.kind==='execute')dispatched.push(payload.request.method);signal.addEventListener('abort',()=>rendererCancel?.({requestId}),{once:true});rendererReceive!({...payload,requestId} as DesktopAutomationRequest)})})
 const rendererTransport={register:async(value:unknown)=>{bridge.setEditor(value)},respond:async(value:{requestId:string;result?:unknown;error?:{code:string;message:string}})=>{const waiter=rendererWaiters.get(value.requestId);rendererWaiters.delete(value.requestId);if(value.error)waiter?.reject(Object.assign(Error(value.error.message),{code:value.error.code}));else waiter?.resolve(value.result)},recordEdit:async()=>({accepted:true}),onRequest:(callback:typeof rendererReceive)=>{rendererReceive=callback;return()=>{rendererReceive=undefined}},onCancel:(callback:typeof rendererCancel)=>{rendererCancel=callback;return()=>{rendererCancel=undefined}}} as unknown as DesktopAutomationTransport
 const detachRenderer=attachDesktopAutomation(editor,rendererTransport,{api})
 const state={scope,token:'a'.repeat(64),sessionId:'clipboard-test-only',editor:bridge.editor,sockets:new Set(),pending:new Set(),server:{close:(done:()=>void)=>done()}};bridge.active=state
 let client!:MemorySocket,peer!:MemorySocket
 const backend=new SocketDesignBackend({endpoint:'/test-only/clipboard.sock',sessionId:state.sessionId,token:state.token,transport:{validateEndpoint:async()=>{},createConnection(){client=new MemorySocket();peer=new MemorySocket();client.peer=peer;peer.peer=client;bridge.accept(state,peer);queueMicrotask(()=>client.emit('connect'));return client}}})
 const input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();diagnostics.resume();let buffer='',serial=0;const pending=new Map<number,(message:Json)=>void>();let orphan:((value:Json)=>void)|undefined
 output.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))!==-1){const message=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);const resolve=pending.get(message.id);pending.delete(message.id);if(resolve)resolve(message);else orphan?.(message)}})
 const server=new DesignMcpServer({backend,input,output,diagnostics}).start()
 cleanup.push(async()=>{await server.close();backend.close();detachRenderer();await bridge.close();api.dispose();editor.dispose();input.destroy();output.destroy();diagnostics.destroy()})
 const rpc=(method:string,params?:Json):Promise<Json>=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Clipboard MCP response timeout'))},20000);pending.set(id,message=>{clearTimeout(timer);resolve(message)});input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n')})
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'clipboard-live-editor',version:'1'}});input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
 const tools=(await rpc('tools/list')).result.tools as Json[]
 const fence=()=>({documentId:editor.state.doc.id,session:editor.sessionGeneration,expectedRevision:editor.state.version})
 const call=(method:string,params:Json={},guards:Json=fence())=>rpc('tools/call',{name:'design_'+method.replaceAll('.','_'),arguments:{params,...guards}})
 const exportPacket=async(kind='nodes')=>{const response=await call('clipboard.export',{nodeIds:[a.id],kind});expect(response.error).toBeUndefined();expect(response.result.isError,String(response.result.structuredContent?.error?.code || 'tool_failure')).toBe(false);const publicValue=response.result.structuredContent;expect(publicValue.result.content).toBeUndefined();expect(publicValue.result.resourceOnly).toBe(true);const uri=publicValue.result.resources[0].uri;const read=await rpc('resources/read',{uri});expect(read.error).toBeUndefined();return {uri,packet:read.result.contents[0].text as string,publicValue}}
 const oversized=()=>new Promise<Json>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Oversized response timeout')),20000);orphan=value=>{clearTimeout(timer);orphan=undefined;resolve(value)};input.write(JSON.stringify({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name:'design_clipboard_paste',arguments:{...fence(),params:{packet:'x'.repeat(32*1024*1024),pageId:editor.state.page,mode:'inPlace'}}}})+'\n')})
 return {a,editor,api,bridge,backend,server,input,client:()=>client,peer:()=>peer,rpc,tools,call,fence,exportPacket,oversized,dispatched}
}
function success(response:Json){expect(response.error).toBeUndefined();expect(response.result.isError).toBe(false);return response.result.structuredContent as Json}
test('actual NDJSON export/resource/read -> explicit packet paste -> undo/redo with one receipted edit',async()=>{
 const f=await fixture(),tool=f.tools.find(t=>t.name==='design_clipboard_export')!;expect(tool.annotations.readOnlyHint).toBe(true);expect(tool.inputSchema.required).toEqual(['documentId','session','expectedRevision','params'])
 const missing=await f.call('clipboard.export',{nodeIds:[f.a.id],kind:'nodes'},{});expect(missing.result.isError).toBe(true)
 const {packet,publicValue}=await f.exportPacket();expect(Buffer.byteLength(packet)).toBe(publicValue.result.byteLength);expect(JSON.stringify(publicValue)).not.toContain('forma-nodes')
 const before=f.editor.state.doc,owner=f.fence(),params={mutationId:'ndjson-clipboard-once',operations:[{method:'clipboard.paste',params:{packet,pageId:f.editor.state.page,mode:'inPlace'}}]}
 const pasted=success(await f.call('batch.apply',params,owner)),after=f.editor.state.doc;expect(pasted.result.operations[0].result.createdRootCount).toBe(1)
 const replay=success(await f.call('batch.apply',params,owner));expect(replay.result.receipt.replayed).toBe(true);expect(f.editor.state.doc).toBe(after)
 success(await f.call('history.undo'));expect(f.editor.state.doc).toEqual(before);success(await f.call('history.redo'));expect(f.editor.state.doc).toEqual(after)
 const property=await f.exportPacket('properties');success(await f.call('clipboard.pasteProperties',{packet:property.packet,targetIds:[f.a.id]}))
})
test.each(['revoke','same-id-reopen','disconnect'] as const)('clipboard resource expires through actual backend terminal lifetime: %s',async end=>{
 const f=await fixture(),{uri}=await f.exportPacket();if(end==='revoke')await f.bridge.close();else if(end==='same-id-reopen')f.bridge.setEditor({...f.bridge.editor,session:f.editor.sessionGeneration+1});else f.peer().destroy()
 expect(f.backend.terminalSignal.aborted).toBe(true);const response=await f.rpc('resources/read',{uri});expect(response.error.code).toBe(-32000);expect(response.result).toBeUndefined()
})
test('read-only desktop connection lists export but not clipboard writes',async()=>{
 const f=await fixture(false,'read');expect(f.tools.some(t=>t.name==='design_clipboard_export')).toBe(true);expect(f.tools.some(t=>t.name==='design_clipboard_paste')).toBe(false);await f.exportPacket();expect(f.editor.canUndo).toBe(false)
})
test('over 8MiB legal packet traverses real desktop output, projection/read and input allowlists without OS/network',async()=>{
 const forbidden=vi.fn(()=>{throw Error('Forbidden IO')});vi.stubGlobal('fetch',forbidden);vi.stubGlobal('navigator',{clipboard:{readText:forbidden,writeText:forbidden}})
 const f=await fixture(true),{packet,publicValue}=await f.exportPacket();expect(Buffer.byteLength(packet)).toBeGreaterThan(8*1024*1024);expect(Buffer.byteLength(JSON.stringify(publicValue))).toBeLessThan(4096)
 success(await f.call('clipboard.paste',{packet,pageId:f.editor.state.page,mode:'inPlace'}));expect(f.dispatched).toContain('clipboard.paste')
 const props=await f.exportPacket('properties');success(await f.call('clipboard.pasteProperties',{packet:props.packet,targetIds:[f.a.id]}));expect(f.dispatched).toContain('clipboard.pasteProperties');expect(forbidden).not.toHaveBeenCalled()
})
test('over 32MiB escaped NDJSON envelope is rejected before dispatch',async()=>{
 const f=await fixture(),before=f.editor.state.doc,count=f.dispatched.length,response=await f.oversized();expect(response.error.code).toBe(-32000);expect(f.dispatched.length).toBe(count);expect(f.editor.state.doc).toBe(before);expect(f.editor.canUndo).toBe(false)
})
test('desktop receiver rejects over-32MiB frames independently of MCP admission',async()=>{
 const f=await fixture(),before=f.editor.state.doc,count=f.dispatched.length
 f.client().write(JSON.stringify({id:'oversized-desktop-frame',method:'execute',params:{method:'clipboard.paste',...f.fence(),params:{packet:'x'.repeat(32*1024*1024),pageId:f.editor.state.page,mode:'inPlace'}}})+'\n')
 await new Promise(resolve=>setImmediate(resolve));expect(f.backend.terminalSignal.aborted).toBe(true);expect(f.dispatched.length).toBe(count);expect(f.editor.state.doc).toBe(before)
})
test('ordinary method keeps 8MiB limit independently at MCP and desktop',async()=>{
 const f=await fixture(),count=f.dispatched.length,params={ids:[f.a.id],patch:{name:'x'.repeat(8*1024*1024)}}
 const mcp=await f.call('node.update',params);expect(mcp.error.code).toBe(-32000)
 await expect(f.backend.callTool('design_node_update',{params,...f.fence()})).rejects.toMatchObject({code:'FRAME_TOO_LARGE'});expect(f.dispatched.length).toBe(count);expect(f.editor.canUndo).toBe(false)
})
