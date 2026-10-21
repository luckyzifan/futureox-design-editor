import test from 'node:test'
import assert from 'node:assert/strict'
import {ArtifactResources} from '../src/artifacts.mjs'
import {OperationBackend} from '../src/operation-backend.mjs'
const response=()=>({ok:true,method:'clipboard.export',documentId:'source-doc',session:2,revision:3,result:{format:'futureox.design-clipboard.v1',mimeType:'application/vnd.futureox.clipboard',encoding:'text',kind:'nodes',byteLength:2,rootCount:1,nodeCount:1,sourceDocumentId:'source-doc',session:2,revision:3,content:'{}'}})
test('dedicated projection exposes only metadata/link and exact immutable resource bytes',()=>{
 const artifacts=new ArtifactResources(),source=response(),projected=artifacts.project(source),ref=projected.value.result.resources[0]
 assert.equal(projected.value.result.content,undefined);assert.equal(projected.value.result.resourceOnly,true);assert.equal(ref.field,'content');assert.equal(ref.encoding,'text');assert.equal(projected.links.length,1)
 source.result.content='changed';assert.equal(artifacts.read(ref.uri).contents[0].text,'{}');artifacts.clear();assert.equal(artifacts.read(ref.uri),undefined)
})
for(const [name,mutate]of Object.entries({nonobjectResult:r=>r.result='PRIVATE',missingContent:r=>delete r.result.content,unknownFormat:r=>r.result.format='other',extraPayload:r=>r.result.base64='PRIVATE',wrongBytes:r=>r.result.byteLength=5,wrongMime:r=>r.result.mimeType='application/json',wrongIdentity:r=>r.result.sourceDocumentId='other',sourceSession:r=>r.result.sourceSession=2,propertiesWithoutKind:r=>r.result.kind='properties'})){
 test(`clipboard projection fails closed without inline fallback: ${name}`,()=>{const a=new ArtifactResources(),r=response();mutate(r);assert.throws(()=>a.project(r),error=>error.code==='artifact_unavailable');assert.equal(a.list().length,0)})
}
test('raw content under packet limit still rejects when escaped resource/read envelope exceeds limit',()=>{
 const a=new ArtifactResources({maxResponseBytes:4096}),r=response();r.result.content='"'.repeat(3000);r.result.byteLength=3000
 assert.throws(()=>a.project(r),error=>error.code==='artifact_unavailable');assert.equal(a.list().length,0)
})
test('read-only export advertises mandatory source fences and refuses implicit target injection',async()=>{
 let calls=0;const b=new OperationBackend({capabilities:{version:1,methods:[{name:'clipboard.export',description:'Export',mutates:false,inputSchema:{type:'object'}}]},target:{documentId:'source-doc',session:2},scope:'read',execute:()=>{calls++;return response()}})
 const tool=b.listTools()[0];assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool.inputSchema.required,['documentId','session','expectedRevision'])
 const invalid=await b.callTool(tool.name,{params:{}});assert.equal(invalid.ok,false);assert.equal(calls,0)
 const valid=await b.callTool(tool.name,{params:{},documentId:'source-doc',session:2,expectedRevision:3});assert.equal(valid.ok,true);assert.equal(calls,1)
})
