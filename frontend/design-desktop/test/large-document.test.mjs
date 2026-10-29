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
test('native storage-derived capacity accepts sources above 4 GiB and rejects unsafe byte counts/foreign owners',()=>{
  assert.equal(admitLargeStatus(status(owner)).expandedBytes,4294967296)
  assert.throws(()=>admitLargeStatus({...status(owner),expandedBytes:4294967297}))
  assert.equal(admitLargeStatus({...status(owner),expandedBytes:5*1024**3,maxExpandedBytes:64*1024**3}).expandedBytes,5*1024**3)
  for(const maxExpandedBytes of [0,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>admitLargeStatus({...status(owner),maxExpandedBytes}))
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
test('canvas listing scope is a bounded boolean forwarded with its source owner',async()=>{
  const f=fixture(),opened=await f.host.open()
  const request={owner:opened.owner,expectedRevision:0,canvasOnly:true,key:'1:0',query:'board'}
  await f.host.children(request)
  assert.deepEqual(f.calls.at(-1),{method:'large.children',params:request})
  const count=f.calls.length
  await assert.rejects(()=>f.host.children({...request,canvasOnly:'true'}),/scope/)
  assert.equal(f.calls.length,count)
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

test('page range receipts must match the requested offset and advance within the source',async()=>{
 const {createHash}=await import('node:crypto')
 const bytes=Buffer.from('{}'),hash=createHash('sha256').update(bytes).digest('hex')
 const window={isDestroyed:()=>false};let range={offset:2,end:4,totalRoots:6,nextOffset:4}
 const calls=[]
 const host=new LargeDocumentHost(async(method,params)=>{
   calls.push({method,params})
   if(method==='large.open')return {...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch'}
   if(method==='large.scene')return {bytes:bytes.length,hash,warnings:[],nodes:0,pageRange:range}
   if(method==='large.sceneRead')return {offset:params.offset,bytes:bytes.length,hash,data:bytes.toString('base64')}
   throw Error(method)
 },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>window)
 const opened=await host.open(),request={owner:opened.owner,expectedRevision:0,key:'1:0',offset:2}
 assert.deepEqual((await host.scene(request)).pageRange,range)
 assert.equal(calls.find(c=>c.method==='large.scene').params.offset,2)
 assert.deepEqual((await host.scene({...request,limit:2})).pageRange,range)
 await assert.rejects(()=>host.scene({...request,limit:1}),/page range/)
 for(const limit of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(()=>host.scene({...request,limit}),/limit/)
 for(const bad of [{...range,offset:0},{...range,nextOffset:2},{...range,end:7},{...range,totalRoots:NaN}]){
   range=bad;await assert.rejects(()=>host.scene(request),/page range/)
 }
 await assert.rejects(()=>host.scene({...request,offset:-1}),/offset/)
})

test('whole-canvas catalogue crosses transport pages and keeps source geometry separate from placement',async()=>{
 const window={isDestroyed:()=>false};let openedOwner
 const item=i=>({key:`100000:${10000000+i}`,id:`root-${i}`,name:`Root ${i}`,kind:'frame',pageId:'source-page',pageName:'Page',source:{x:-200,y:100,width:140,height:140},placed:{x:i*268,y:0,width:140,height:140},bytes:100})
 const host=new LargeDocumentHost(async(method,params)=>{
  if(method==='large.open'){openedOwner={documentId:params.documentId,sessionEpoch:params.sessionEpoch};return {...status(openedOwner),format:'sketch'}}
  if(method==='large.canvasLayout'){
   const offset=params.offset??0,limit=params.limit??200,items=Array.from({length:Math.max(0,Math.min(limit,306-offset))},(_,i)=>item(offset+i))
   return {owner:openedOwner,revision:0,items,total:306,offset,hasMore:offset+items.length<306,bounds:{x:0,y:0,width:90000,height:300},boundsAreLayoutHints:true}
  }
  throw Error(method)
 },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>window)
 const opened=await host.open(),request={owner:opened.owner,expectedRevision:0}
 const a=await host.canvasLayout(request),b=await host.canvasLayout({...request,offset:200})
 assert.equal(a.items.length,200);assert.equal(b.items.length,106);assert.equal(b.hasMore,false)
 assert.equal(new Set([...a.items,...b.items].map(i=>i.key)).size,306)
 assert.equal(a.items[0].source.x,-200);assert.equal(a.items[0].placed.x,0)
 await assert.rejects(()=>host.canvasLayout({...request,expectedRevision:1}),/Stale/)
})

test('native canvas snapshots expose only opaque, window-and-revision-bound capabilities',async()=>{
 const window={isDestroyed:()=>false,webContents:{id:17}};let current=window,live,snapshotCalls=0
 const host=new LargeDocumentHost(async(method,params)=>{
  if(method==='large.open')return live={...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch'}
  if(method==='large.canvasSnapshot'){snapshotCalls++;return {owner:live.owner,revision:live.revision,path:`/native/cache/canvas-native-${live.revision}.scene`,bytes:600*1024**2,
   store:{generation:`${live.owner.documentId}:${live.owner.sessionEpoch}:${live.revision}`,documentId:live.owner.documentId,bytes:600*1024**2,nodes:124447,footerHash:Array(32).fill(42)},nodes:124447,roots:306,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:20000,height:30000},warnings:[],rasterProfile:'figma',colorManaged:true}}
  if(method==='large.apply')return live={...live,revision:live.revision+1}
  throw Error(method)
 },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>current)
 const opened=await host.open(),request={owner:opened.owner,expectedRevision:0}
 await assert.rejects(()=>host.canvasSnapshot({...request,path:'/renderer/forged'}),/Invalid/)
 const snapshot=await host.canvasSnapshot(request)
 assert.equal(snapshot.bytes,600*1024**2);assert.equal(Object.hasOwn(snapshot,'path'),false);assert.equal(Object.hasOwn(snapshot,'hash'),false);assert.equal(Object.hasOwn(snapshot,'store'),false)
 const grant=host.resolveCanvasSnapshot(snapshot.token,17);assert.equal(grant.descriptor.path,'/native/cache/canvas-native-0.scene');assert.equal(Object.isFrozen(grant.descriptor),true)
 assert.throws(()=>host.resolveCanvasSnapshot(snapshot.token,18),/foreign/)
 assert.throws(()=>host.resolveCanvasSnapshot({path:'/renderer/forged'},17),/foreign/)
 assert.equal((await host.canvasSnapshot(request)).token,snapshot.token);assert.equal(snapshotCalls,1)
 await host.apply({...request,key:'0:0',json:'{"name":"edit"}',expectedHash:'b'.repeat(64)})
 assert.throws(()=>grant.assertCurrent(),/Stale/);assert.throws(()=>host.resolveCanvasSnapshot(snapshot.token,17),/Stale/)
 const next=await host.canvasSnapshot({...request,expectedRevision:1});assert.notEqual(next.token,snapshot.token)
 current={isDestroyed:()=>false,webContents:{id:17}}
 assert.throws(()=>host.resolveCanvasSnapshot(next.token,17),/foreign/)
})
