import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { snapshotSurfaceLedger, sanitizeSurfaceLedger, surfaceAllocationTag, SurfaceAllocationSite, SURFACE_SCAN_STEPS, SURFACE_SCAN_UNIQUE } from '../src/render-surface-ledger.mjs'
import { markFailureAllocation, failureAllocationFields, inheritFailureAllocation } from '../src/render-failure-allocation.mjs'
import { sanitizeFields } from '../src/render-terminal-diagnostics.mjs'
const texture=(bytes=64,width=4,height=4,resource={})=>({bytes,width,height,resource})
const snapshot=(sources,extra={})=>snapshotSurfaceLedger({sources,aliases:()=>1,pinned:()=>false,material:()=>false,coverage:()=>false,tag:()=>undefined,poolEpoch:()=>undefined,completedEpoch:2,ledgerBytes:1024,...extra})
test('physical resource aliases deduplicate totals while overlapping membership remains explicit',()=>{
 const a=texture(),b=texture(64,4,4,a.resource),c=texture(128,8,4)
 const out=snapshot([{mask:1,items:[a,b,c]},{mask:4,items:[a,b,c]},{mask:64,items:[{texture:b}],surface:true}],{aliases:t=>t===a?3:1,material:t=>t===c,ledgerBytes:224})
 assert.equal(out.failureSurfaceUniqueCount,2);assert.equal(out.failureSurfaceUniqueBytes,192)
 assert.equal(out.failureSurfaceBusyBytes,192);assert.equal(out.failureSurfaceUsedBytes,192)
 assert.equal(out.failureSurfacePinnedBytes,64);assert.equal(out.failureSurfaceAliasProtectedCount,1)
 assert.equal(out.failureSurfaceClass1Bytes,128);assert.equal(out.failureSurfaceClass6Bytes,64)
 assert.equal(out.failureSurfaceOverlapBytes,192);assert.equal(out.failureSurfaceLedgerResidualBytes,32)
 assert.equal(out.failureSurfaceLedgerOvercountBytes,0)
})
test('size buckets, latest role, largest surface and pool epochs are bounded scalar evidence',()=>{
 const small=texture(64,4,4),large=texture(128,2607,2569),unknown=texture(32,1,1)
 const out=snapshot([{mask:2,items:[[small,large,unknown]],nested:true}],{tag:t=>t===large?surfaceAllocationTag(SurfaceAllocationSite.passOutput,22):undefined,poolEpoch:t=>t===small?1:t===large?3:undefined,ledgerBytes:224})
 assert.equal(out.failureSurfacePoolCompletedBytes,64);assert.equal(out.failureSurfacePoolPendingBytes,128);assert.equal(out.failureSurfacePoolEpochUnknownBytes,32)
 assert.equal(out.failureSurfaceSize4Bytes,128);assert.equal(out.failureSurfaceSize1Bytes,96)
 assert.equal(out.failureSurfaceRole2Bytes,128);assert.equal(out.failureSurfaceLargestCallsite,5);assert.equal(out.failureSurfaceLargestPassMode,23)
 assert.deepEqual(sanitizeFields({...out,failureAllocationSnapshotVersion:1}),{...out,failureAllocationSnapshotVersion:1})
})
test('duplicate references cannot evade the scan-step limit',()=>{
 const a=texture();let visits=0
 const endless={*[Symbol.iterator](){for(;;){visits++;yield a}}}
 const out=snapshot([{mask:1,items:endless}])
 assert.equal(visits,SURFACE_SCAN_STEPS);assert.equal(out.failureSurfaceScanSteps,SURFACE_SCAN_STEPS)
 assert.equal(out.failureSurfaceScanTruncated,1);assert.equal(out.failureSurfaceUniqueCount,1)
})
test('empty nested pool containers and unique textures have independent hard bounds',()=>{
 let emptyVisits=0
 const empty={*[Symbol.iterator](){for(;;){emptyVisits++;yield []}}}
 const a=snapshot([{mask:2,items:empty,nested:true}]);assert.equal(a.failureSurfaceScanTruncated,1)
 assert.ok(emptyVisits<=SURFACE_SCAN_STEPS);assert.equal(a.failureSurfaceScanSteps,SURFACE_SCAN_STEPS)
 const b=snapshot([{mask:1,items:Array.from({length:SURFACE_SCAN_UNIQUE+1},()=>texture())}])
 assert.equal(b.failureSurfaceUniqueCount,SURFACE_SCAN_UNIQUE);assert.equal(b.failureSurfaceScanTruncated,1)
})
test('malformed fields/getters/private content never cross the scalar allowlist',()=>{
 let reads=0;const bad={resource:{},width:4,height:4,get bytes(){reads++;throw Error('private')}}
 const out=snapshot([{mask:1,items:[bad]}]);assert.equal(reads,0);assert.equal(out.failureSurfaceInvalidCount,1)
 const dirty={failureSurfaceSnapshotVersion:1,failureSurfaceScanTruncated:1,failureAllocationCallsite:30,
 failureSurfaceUniqueBytes:Infinity,failureSurfaceLargestRole:-1,failureSurfaceRole11Bytes:99,nodeId:'private',matrix:[1],content:'private',get failureSurfaceLargestBytes(){reads++;return 1}}
 assert.deepEqual(sanitizeSurfaceLedger(dirty),{failureSurfaceSnapshotVersion:1,failureSurfaceScanTruncated:1});assert.equal(reads,0)
 assert.deepEqual(sanitizeSurfaceLedger(Object.create({failureSurfaceSnapshotVersion:1})),{})
})
test('inconsistent physical aliases and inventory failures are explicitly reported',()=>{
 const a=texture(),b=texture(128,8,4,a.resource)
 const out=snapshot([{mask:1,items:[a,b]}],{ledgerBytes:64});assert.equal(out.failureSurfaceUniqueBytes,128)
 assert.equal(out.failureSurfaceMetadataConflictCount,1);assert.equal(out.failureSurfaceLedgerOvercountBytes,64)
 const failure=snapshot([{mask:1,items:{[Symbol.iterator](){throw Error('private')}}}])
 assert.equal(failure.failureSurfaceScanError,1);assert.equal(failure.failureSurfaceScanTruncated,1);assert.ok(!JSON.stringify(failure).includes('private'))
})
test('error-owned snapshot survives wrapper inheritance and real MessageChannel scalar transport',async()=>{
 const error=new Error('private');const fields={failureAllocationSnapshotVersion:1,...snapshot([{mask:1,items:[texture()]}])}
 markFailureAllocation(error,fields);fields.failureSurfaceUniqueBytes=0
 const wrapped=inheritFailureAllocation(error,new Error('wrapper'));const owned=failureAllocationFields(wrapped)
 assert.equal(owned.failureSurfaceUniqueBytes,64)
 const {port1,port2}=new MessageChannel()
 try{const received=new Promise(resolve=>port2.once('message',resolve));port1.postMessage(sanitizeFields(owned));assert.deepEqual(sanitizeFields(await received),owned)}finally{port1.close();port2.close()}
})

test('aggregate saturation is explicit and uncategorized resource aliases still detect conflicting shape',()=>{
 const a=texture(17179869184),b=texture(17179869184)
 const capped=snapshot([{mask:1,items:[a,b]}],{ledgerBytes:17179869184})
 assert.equal(capped.failureSurfaceUniqueCount,2);assert.equal(capped.failureSurfaceUniqueBytes,17179869184);assert.equal(capped.failureSurfaceTotalsCapped,1)
 const c=texture(128,8,4,a.resource),out=snapshot([{mask:0,items:[a,c]}])
 assert.equal(out.failureSurfaceMetadataConflictCount,1)
})
