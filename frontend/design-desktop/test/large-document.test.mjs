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
test('recovered bitmap storage remains bound to the current window and closes with its new session',async()=>{
 const window={isDestroyed:()=>false,webContents:{id:7}};let live
 const host=new LargeDocumentHost(async(method,params)=>{
  if(method==='large.open')return live={...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch',bitmapScope:'original-source-1'}
  if(method==='large.close')return {}
  throw Error(method)
 },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>window)
 const opened=await host.open()
 // The source scope is minted by native recovery, never supplied by the renderer.
 assert.equal(host.bitmapOwner('original-source-1'),true)
 assert.equal(host.bitmapOwner('unrelated-1'),false)
 assert.equal(host.bitmapGrant(8,'/cache'),undefined)
 assert.deepEqual(host.bitmapGrant(7,'/cache'),{owner:'original-source-1',directory:'/cache/large-documents/original-source-1/bitmaps'})
 await host.close({owner:opened.owner,expectedRevision:opened.revision})
 assert.equal(host.bitmapOwner('original-source-1'),false)
 for(const bitmapScope of ['../other','a/b','',3,{},'x'.repeat(161)])assert.throws(()=>admitLargeStatus({...status(owner),bitmapScope}))
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
test('choosing the imported source as the export destination never dispatches a write',async()=>{
  const calls=[],window={isDestroyed:()=>false};let live
  const request=async(method,params)=>{
    calls.push(method)
    if(method==='large.open')return live=status({documentId:params.documentId,sessionEpoch:params.sessionEpoch})
    throw Error('Unexpected write: '+method)
  }
  const host=new LargeDocumentHost(request,{
    showOpenDialog:async()=>({canceled:false,filePaths:['/approved/original.json']}),
    showSaveDialog:async()=>({canceled:false,filePath:'/approved/original.json'}),
  },()=>window)
  const opened=await host.open()
  await assert.rejects(()=>host.export({owner:opened.owner,expectedRevision:0}),/原文件保持不变/)
  assert.deepEqual(calls,['large.open'])
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
   store:{generation:`${live.owner.documentId}:${live.owner.sessionEpoch}:${live.revision}`,documentId:live.owner.documentId,bytes:600*1024**2,nodes:124447,footerHash:Array(32).fill(42)},nodes:124447,roots:306,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:20000,height:30000},warnings:[],rasterProfile:'figma',colorManaged:true,
   phases:{readNs:1,convertNs:2,windowWriteNs:0,snapshotWriteNs:3,readBytes:4,windowWriteBytes:0,storeBytes:600*1024**2,windowWrites:0}}}
  if(method==='large.canvasPreview')return {phase:'ready',image:{width:1,height:1,scale:1/30000,png:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nHoQAAAAASUVORK5CYII='}}
  if(method==='large.apply')return live={...live,revision:live.revision+1}
  throw Error(method)
 },{showOpenDialog:async()=>({canceled:false,filePaths:['/approved/source.sketch']})},()=>current)
 const opened=await host.open(),request={owner:opened.owner,expectedRevision:0}
 await assert.rejects(()=>host.canvasSnapshot({...request,path:'/renderer/forged'}),/Invalid/)
 const snapshot=await host.canvasSnapshot(request)
  assert.equal(snapshot.bytes,600*1024**2);assert.equal(Object.hasOwn(snapshot,'path'),false);assert.equal(Object.hasOwn(snapshot,'hash'),false);assert.equal(Object.hasOwn(snapshot,'store'),false)
  assert.equal(snapshot.phases.storeBytes,snapshot.bytes);assert.equal(snapshot.phases.windowWrites,0);assert.equal(snapshot.phases.readBytes,4)
 await assert.rejects(()=>host.canvasPreview({...request,token:'different'}),/Stale/)
 const preview=await host.canvasPreview({...request,token:snapshot.token})
 assert.equal(preview.phase,'ready');assert.equal(preview.width,1)
 const grant=host.resolveCanvasSnapshot(snapshot.token,17);assert.equal(grant.descriptor.path,'/native/cache/canvas-native-0.scene');assert.equal(Object.isFrozen(grant.descriptor),true)
 assert.throws(()=>host.resolveCanvasSnapshot(snapshot.token,18),/foreign/)
 assert.throws(()=>host.resolveCanvasSnapshot({path:'/renderer/forged'},17),/foreign/)
 assert.equal((await host.canvasSnapshot(request)).token,snapshot.token);assert.equal(snapshotCalls,1)
 await host.apply({...request,key:'0:0',json:'{"name":"edit"}',expectedHash:'b'.repeat(64)})
 await assert.rejects(()=>host.canvasPreview({...request,token:snapshot.token}),/Stale/)
 assert.throws(()=>grant.assertCurrent(),/Stale/);assert.throws(()=>host.resolveCanvasSnapshot(snapshot.token,17),/Stale/)
 const next=await host.canvasSnapshot({...request,expectedRevision:1});assert.notEqual(next.token,snapshot.token)
 current={isDestroyed:()=>false,webContents:{id:17}}
 assert.throws(()=>host.resolveCanvasSnapshot(next.token,17),/foreign/)
})

test('detail snapshot capability includes the requested material set and cannot be reused as a full canvas', async()=>{
 const win={isDestroyed:()=>false,webContents:{id:9}}, dialog={showOpenDialog:async()=>({canceled:false,filePaths:['/fixture.sketch']})}
 const {createHash}=await import('node:crypto')
 let live,calls=0
 const host=new LargeDocumentHost(async(method,params)=>{
  if(method==='large.open')return live={...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch'}
  if(method!=='large.canvasSnapshot')throw Error(method)
  calls++
  const keys=params.materialKeys,scope=keys?createHash('sha256').update([...keys].sort().join(',')).digest('hex'):undefined
  const suffix=scope?'-'+scope:''
  return {owner:live.owner,revision:0,path:'/native/canvas-native-0'+suffix+'.scene',scope,bytes:123,
   store:{generation:live.owner.documentId+':'+live.owner.sessionEpoch+':0'+suffix,documentId:live.owner.documentId,bytes:123,nodes:2,footerHash:Array(32).fill(0)},
   pageId:'p',stageId:'s',nodes:2,roots:keys?.length??10,bounds:{x:0,y:0,width:100,height:100},rasterProfile:'figma',colorManaged:true,warnings:[]}
 },dialog,()=>win)
 const owner=(await host.open()).owner,request={owner,expectedRevision:0}
 const detail=await host.canvasSnapshot({...request,materialKeys:['1:3']})
 assert.deepEqual(detail.materialKeys,['1:3'])
 const grant=host.resolveCanvasSnapshot(detail.token,9)
 assert.equal((await host.canvasSnapshot({...request,materialKeys:['1:3']})).token,detail.token)
 await assert.rejects(()=>host.canvasSnapshot({...request,materialKeys:['1:3','1:3']}),/Duplicate/)
 const full=await host.canvasSnapshot(request)
 assert.equal(full.roots,10);assert.notEqual(full.token,detail.token);assert.throws(()=>grant.assertCurrent(),/Stale/);assert.equal(calls,2)
 const returned=await host.canvasSnapshot({...request,materialKeys:['1:3']})
 assert.equal(returned.token,detail.token);assert.equal(calls,2)
 assert.equal(host.resolveCanvasSnapshot(detail.token,9).descriptor.path,grant.descriptor.path)
 assert.throws(()=>host.resolveCanvasSnapshot(full.token,9),/Stale/)
})

test('opening preview cannot return pixels for a different source owner or accept renderer paths', async()=>{
 const win={isDestroyed:()=>false,webContents:{id:3}},dialog={showOpenDialog:async()=>({canceled:false,filePaths:['/real.sketch']})}
 const calls=[]
 const host=new LargeDocumentHost(async(method,params)=>{
   calls.push(method)
   if(method==='large.open')return {...status({documentId:params.documentId,sessionEpoch:params.sessionEpoch}),format:'sketch'}
   return {phase:'available',owner:{documentId:'other',sessionEpoch:99}}
 },dialog,()=>win)
 const {owner}=await host.open()
 await assert.rejects(()=>host.openingView({offset:0,cursor:0,path:'/arbitrary'}),/Invalid/)
 assert.equal((await host.openingView({offset:0,cursor:0,owner:{...owner,sessionEpoch:3}})).status,'cancelled')
 await assert.rejects(()=>host.openingView({offset:0,cursor:0,owner}),/Invalid opening view response/)
 assert.deepEqual(calls,['large.open','large.openingView'])
})

test('pending Sketch material only publishes its current window-bound display token', async()=>{
 const {createHash}=await import('node:crypto')
 const win={isDestroyed:()=>false,webContents:{id:29}}, box={x:0,y:0,width:120,height:100}
 let owner,finish,overrideScope,waiting
 const started=new Promise(r=>waiting=r)
 const host=new LargeDocumentHost(async(method,req)=>{
  if(method==='large.open'){owner={documentId:req.documentId,sessionEpoch:req.sessionEpoch};waiting();return new Promise(r=>finish=r)}
  assert.equal(method,'large.openingView')
  const scope=overrideScope||createHash('sha256').update('preview-0').digest('hex')
  const snapshot={owner,revision:0,path:'/native/canvas-native-0-'+scope+'.scene',scope,bytes:80,nodes:3,roots:1,pageId:'p',stageId:'s',
   colorManaged:true,rasterProfile:'figma',warnings:[],bounds:box,
   store:{bytes:80,nodes:3,documentId:owner.documentId,footerHash:Array(32).fill(1),generation:owner.documentId+':'+owner.sessionEpoch+':0-'+scope}}
  return {phase:'available',owner,revision:0,bounds:box,total:1,offset:0,items:[{key:'preview-0',id:'material',kind:'artboard',name:'a',pageId:'p',pageName:'p',source:box,placed:box}],
    pages:[['p','p',1]],nextOffset:1,cursor:0,images:[],finished:false,moreImages:false,cacheHit:false,rendered:0,
    materialSnapshot:req.material===0?snapshot:null}
 },{},()=>win)
 const opening=host.open(undefined,'/approved/input.sketch');await started
 const request={owner,offset:0,cursor:0,material:0}
 const first=await host.openingView(request)
 assert.equal(first.materialDisplay.openingMaterial,0)
 assert(!JSON.stringify(first).includes('/native/'));assert(!Object.hasOwn(first,'materialSnapshot'))
 assert.throws(()=>host.resolveCanvasSnapshot(first.materialDisplay.token,30),/foreign/)
 const grant=host.resolveCanvasSnapshot(first.materialDisplay.token,29);grant.assertCurrent()
 assert.equal((await host.openingView(request)).materialDisplay.token,first.materialDisplay.token)
 await host.openingView({owner,offset:0,cursor:0});assert.throws(()=>grant.assertCurrent(),/Stale/)
 overrideScope='a'.repeat(64);await assert.rejects(host.openingView(request),/Invalid native canvas snapshot/)
 finish({...status(owner),format:'sketch'});await opening
 assert.equal((await host.openingView(request)).materialDisplay,undefined)
})

test('multi-material detail images are bounded and must match the opening catalogue',async()=>{
 const win={isDestroyed:()=>false,webContents:{id:3}},dialog={showOpenDialog:async()=>({canceled:false,filePaths:['/example.sketch']})}
 const h=Buffer.alloc(24);h.writeUInt32BE(0x89504e47,0);h.writeUInt32BE(0x0d0a1a0a,4);h.write('IHDR',12);h.writeUInt32BE(384,16);h.writeUInt32BE(240,20)
 const rect={x:0,y:0,width:1000,height:500};let detailIndex=0
 const host=new LargeDocumentHost(async(method,p)=>{
   if(method==='large.open')return {...status({documentId:p.documentId,sessionEpoch:p.sessionEpoch}),format:'sketch'}
   return {phase:'available',owner:p.owner,revision:0,bounds:rect,offset:1,nextOffset:1,total:1,items:[],images:[],cursor:1,moreImages:false,finished:true,
     detail:{index:detailIndex,png:h.toString('base64')}}
 },dialog,()=>win)
 const owner=(await host.open()).owner,arg={owner,offset:1,cursor:1,detailCursor:0}
 assert.equal((await host.openingView(arg)).detail.index,0)
 detailIndex=1;await assert.rejects(()=>host.openingView(arg),/Invalid material thumbnail/)
 detailIndex=0;h.writeUInt32BE(769,16);await assert.rejects(()=>host.openingView(arg),/Invalid material PNG/)
})
