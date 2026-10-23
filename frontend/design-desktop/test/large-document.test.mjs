import test from 'node:test'
import assert from 'node:assert/strict'
import { LargeDocumentHost, admitLargeStatus } from '../src/large-document.mjs'
const owner={documentId:'known-document',sessionEpoch:1}
const status=(owner,revision=0)=>({owner,revision,name:'sample.json',format:'json',expandedBytes:4*1024**3,maxExpandedBytes:4*1024**3,indexedObjects:625000,dirty:revision>0,undoCount:revision,redoCount:0})
function fixture(){
  const window={isDestroyed:()=>false},calls=[];let current=window,live
  const request=async(method,params)=>{calls.push({method,params});if(method==='large.open')return live=status({documentId:params.documentId,sessionEpoch:params.sessionEpoch});if(method==='large.status')return live;if(method==='large.children')return {items:[],total:0};if(method==='large.apply')return live=status(live.owner,live.revision+1);if(method==='large.export')return {exported:true,document:live};if(method==='large.close')return {};throw Error(method)}
  const dialog={showOpenDialog:async()=>({canceled:false,filePaths:['/approved/sample.json']}),showSaveDialog:async()=>({canceled:false,filePath:'/approved/exported.json'})}
  return {host:new LargeDocumentHost(request,dialog,()=>current),calls,changeWindow:()=>{current={isDestroyed:()=>false}}}
}
test('4 GiB summaries are safe Numbers and a larger forged limit/foreign owner is rejected',()=>{
  assert.equal(admitLargeStatus(status(owner)).expandedBytes,4294967296)
  assert.throws(()=>admitLargeStatus({...status(owner),expandedBytes:4294967297}))
  assert.throws(()=>admitLargeStatus(status(owner),{...owner,sessionEpoch:2}))
})
test('only native-picked paths enter open/export; renderer paths and stale edit owners fail before RPC',async()=>{
  const f=fixture(),opened=await f.host.open()
  assert.equal(f.calls[0].params.path,'/approved/sample.json')
  const request={owner:opened.owner,expectedRevision:opened.revision}
  await assert.rejects(()=>f.host.export({...request,path:'/renderer/forged.json'}))
  await assert.rejects(()=>f.host.children({...request,owner:{...opened.owner,sessionEpoch:99}}))
  assert.equal(f.calls.length,1)
  await f.host.export(request)
  assert.equal(f.calls.at(-1).params.path,'/approved/exported.json')
  assert.equal(f.calls.at(-1).method,'large.export')
})
test('property commits advance one owner revision and reject an older request without replay',async()=>{
  const f=fixture(),opened=await f.host.open();const old={owner:opened.owner,expectedRevision:0,key:'0:1',json:'{"name":"edit"}',expectedHash:'a'.repeat(64)}
  const after=await f.host.apply(old);assert.equal(after.revision,1)
  await assert.rejects(()=>f.host.apply(old),/Stale/)
  assert.equal(f.calls.filter(c=>c.method==='large.apply').length,1)
})
test('window ownership fences late reads and cannot be transferred by a document field',async()=>{
  const f=fixture(),opened=await f.host.open();f.changeWindow()
  await assert.rejects(()=>f.host.children({owner:opened.owner,expectedRevision:0,key:'0:0'}),/foreign/)
  assert.equal(f.calls.length,1)
})
test('an uncertain open retains its native owner and refresh queries status without reopening',async()=>{
  const window={isDestroyed:()=>false},calls=[];let live
  const request=async(method,params)=>{
    calls.push(method)
    if(method==='large.open'){
      live=status({documentId:params.documentId,sessionEpoch:params.sessionEpoch})
      throw Object.assign(Error('reply lost after native admission'),{outcomeUnknown:true})
    }
    if(method==='large.status')return live
    throw Error(method)
  }
  const host=new LargeDocumentHost(request,{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.json']})},()=>window)
  await assert.rejects(()=>host.open(),/reply lost/)
  const refreshed=await host.open()
  assert.deepEqual(refreshed.owner,live.owner)
  assert.deepEqual(calls,['large.open','large.status'])
})
test('an owned pending native open can be cancelled without waiting for its exclusive operation',async()=>{
  const window={isDestroyed:()=>false};let finish,entered
  const started=new Promise(resolve=>{entered=resolve})
  const request=async(method,params)=>{
    assert.equal(method,'large.open');entered()
    await new Promise(resolve=>{finish=resolve})
    return status({documentId:params.documentId,sessionEpoch:params.sessionEpoch})
  }
  let cancelled=0
  const host=new LargeDocumentHost(request,{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.json']})},()=>window,async()=>{cancelled++;return {requested:1,running:true,cancelled:false}})
  const opening=host.open();await started
  assert.equal((await host.cancel()).requested,1)
  assert.equal(cancelled,1)
  finish();await opening
})

test('page DTO chunks retain exact hash, revision and window ownership',async()=>{
  const {createHash}=await import('node:crypto')
  const bytes=Buffer.from('{"nodes":{},"padding":"'+'x'.repeat(700000)+'"}'),hash=createHash('sha256').update(bytes).digest('hex')
  const window={isDestroyed:()=>false};let live,bad=false;const offsets=[]
  const host=new LargeDocumentHost(async(method,params)=>{
    if(method==='large.open')return live={...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch'}
    if(method==='large.scene')return {bytes:bytes.length,hash,warnings:[],nodes:0}
    if(method==='large.sceneRead'){offsets.push(params.offset);return {offset:params.offset,bytes:bytes.length,hash,data:bytes.subarray(params.offset,params.offset+512*1024).toString('base64')+(bad?'YQ==':'')}}
    throw Error(method)
  },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>window)
  const opened=await host.open(),request={owner:opened.owner,expectedRevision:0,key:'1:0'}
  const scene=await host.scene(request)
  assert.equal(scene.json,bytes.toString());assert.deepEqual(offsets,[0,512*1024])
  bad=true
  await assert.rejects(()=>host.scene(request),/chunk|hash/)
  await assert.rejects(()=>host.scene({...request,expectedRevision:1}),/Stale/)
})
