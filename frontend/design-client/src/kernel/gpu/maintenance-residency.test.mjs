import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import {MaintenanceResidency} from './maintenance-residency.ts'
const M=1024*1024
const src=readFileSync(process.env.RENDERER_SOURCE || new URL('./renderer.ts',import.meta.url),'utf8')
const start=src.indexOf('  private async reclaimScratch('),end=src.indexOf('\n  private ',start+1)
assert(start>=0&&end>start,'Production reclaimScratch method boundaries must exist')
const body=src.slice(start,end).replaceAll("import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX", "'0'").replaceAll("import.meta.env.VITE_DESIGN_IMAGE_ASSET_RESIDENCY", "'0'")
const Renderer=Function('gpuDiagnosticsEnabled','recordGpuDiagnostic','RECLAIM_BATCH_BYTES','RECLAIM_BATCH_RESOURCES','return '+stripTypeScriptTypes('class Harness {\n'+body+'\n}'))(()=>true,(event,data)=>records.push({event,...data}),Number(src.match(/const RECLAIM_BATCH_BYTES = (\d+) \* 1024 \* 1024/)[1])*M,Number(src.match(/const RECLAIM_BATCH_RESOURCES = (\d+)/)[1]))
const records=[]
function fixture(working=272586144,pool=9844192,transient=160118336) {
 const r=new Renderer(), p={bytes:pool},t={bytes:transient},calls={wait:0,destroy:0}
 Object.assign(r,{maintenanceResidency:new MaintenanceResidency(),workingBytes:working,bytes:working,frameBudget:1024*M,
 checkFrameCurrent(){},admissionPins:new Set(),staticImageBlurs:{collect(){},discardPending(){},bytes:0,clear(){}},collectRetiredImageAssets(){},
 driver:{completedResourceEpoch:1,resourceEpoch:2,async checkpoint(){calls.wait++}},scene:{},retiredImageAssets:new Map(),constantTargets:new Map(),aliases:new Map(),free:new Map([['pool',[p]]]),coordinateMaps:new Set([t]),retiredUploads:[],hasEvictableImage(){return false},images:new Map(),lastUsed:new Map(),poolReleaseEpoch:new Map(),
 retiredImageAssetCohort(){return []},coverRetiredImageAssets(){},checkpointMs:0,retireDisplayMaterial(){},retireNestedPrefix(){},retireCoherentSubtrees(){},horizontalFilters:{clear(){}},evictImages(){},
 destroyFree(t){for(const [k,list]of this.free)this.free.set(k,list.filter(v=>v!==t));this.bytes-=t.bytes;this.workingBytes-=t.bytes;calls.destroy++},
 forgetCoordinateTexture(t){this.coordinateMaps.delete(t);this.bytes-=t.bytes;this.workingBytes-=t.bytes;calls.destroy++},
 forgetUpload(t){this.bytes-=t.bytes;this.workingBytes-=t.bytes;calls.destroy++}})
 return {r,p,t,calls}
}
test('actual req76 transient-heavy mix reclaims one completed cohort and preserves pool',async()=>{
 const {r,p,calls}=fixture();r.coordinateMaps=new Set(Array.from({length:66},(_,i)=>({bytes:Math.floor(160118336/66)+(i<160118336%66?1:0)})));const pool=r.free.get('pool');await r.reclaimScratch();assert.equal(calls.wait,1);assert.equal(r.coordinateMaps.size,2)
 assert.deepEqual(r.free.get('pool'),pool);assert.equal(r.workingBytes,272586144-[...Array(64)].reduce((sum,_,i)=>sum+Math.floor(160118336/66)+(i<160118336%66?1:0),0))
 await r.reclaimScratch();assert.equal(calls.wait,1);assert.equal(records.findLast(x=>x.maintenanceDecision===6).maintenanceRetiredBytes,160118336-[...r.coordinateMaps].reduce((sum,t)=>sum+t.bytes,0))
})
test('small transient plus large reusable pool defers without uncharging',async()=>{
 const {r,calls}=fixture(400*M,300*M,20*M);await r.reclaimScratch();assert.equal(calls.wait,0);assert.equal(calls.destroy,0);assert.equal(r.workingBytes,400*M)
})
test('large reusable pool does not relax total working watermark or transient cap',()=>{
 const d=()=>new MaintenanceResidency();assert.equal(d().decide(0,false,768*M,1024*M,650*M,64*M,2,1),0)
 assert.equal(d().decide(0,false,768*M+1,1024*M,650*M,64*M,2,1),3)
 assert.equal(d().decide(0,false,768*M,1024*M,650*M,64*M+1,2,1),4)
})
test('required allocation boundary always waits even if allocation fits',async()=>{
 const {r,calls}=fixture();await r.reclaimScratch(1);assert.equal(calls.wait,1);assert.ok(calls.destroy>0)
})
test('pressure, capture and retired-image-table boundaries are not deferred',async()=>{
 for(const setup of [r=>{r.frameBudget=260*M},r=>{r.driver.captureDisplay=()=>{}},r=>{r.driver.retiredImageTableBytes=1}]){
 const {r,calls}=fixture();setup(r);await r.reclaimScratch(r.frameBudget===260*M?64*M:0);assert.equal(calls.wait,1)
 }
})
test('eight deferrals retain bounded charge, ninth completes original retirement',async()=>{
 const {r,calls}=fixture(400*M,300*M,20*M);for(let i=0;i<8;i++)await r.reclaimScratch();assert.equal(calls.wait,0);assert.equal(r.maintenanceResidency.count,8)
 await r.reclaimScratch();assert.equal(calls.wait,1);assert.ok(calls.destroy>0);assert.equal(r.maintenanceResidency.count,0)
})
test('failed checkpoint never resets quota or destroys retained resources',async()=>{
 const {r,calls}=fixture(400*M,300*M,20*M);for(let i=0;i<8;i++)await r.reclaimScratch();r.driver.checkpoint=async()=>{calls.wait++;throw Error('device lost')}
 await assert.rejects(r.reclaimScratch(),/device lost/);assert.equal(calls.destroy,0);assert.equal(r.maintenanceResidency.count,8)
})
test('invalid ledger or epochs fail closed',()=>{
 for(const value of [NaN,Infinity,-1,.5,undefined])assert.equal(new MaintenanceResidency().decide(0,false,400*M,1024*M,300*M,20*M,value,1),1)
 assert.equal(new MaintenanceResidency().decide(0,false,400*M,1024*M,300*M,20*M,1,2),1)
 assert.equal(new MaintenanceResidency().decide(0,false,400*M,1024*M,390*M,20*M,2,1),1)
 assert.equal(new MaintenanceResidency().decide(0,false,0,0,0,0,0,0),1)
})
test('conflicting pool/transient ownership fails before any destroy or completion',async()=>{
 const {r,p,calls}=fixture(400*M,100*M,20*M);r.coordinateMaps=new Set([p]);await assert.rejects(r.reclaimScratch(),/ownership overlaps/)
 assert.equal(calls.wait,0);assert.equal(calls.destroy,0);assert.equal(r.free.get('pool')[0],p);assert.equal(r.coordinateMaps.has(p),true)
})
test('conflicting retired/coordinate ownership preserves aliases and rejects',async()=>{
 const {r,t,calls}=fixture();r.retiredUploads=[t];await assert.rejects(r.reclaimScratch(),/ownership overlaps/)
 assert.equal(calls.wait,0);assert.equal(calls.destroy,0);assert.equal(r.retiredUploads[0],t);assert.equal(r.coordinateMaps.has(t),true)
})
test('completed cohort disposal remains bounded at the production64 handles',async()=>{
 const {r,calls}=fixture(600*M,200*M,100*M);r.coordinateMaps=new Set(Array.from({length:300},()=>({bytes:M})))
 await r.reclaimScratch();assert.equal(calls.wait,1);assert.equal(calls.destroy,64);assert.equal(r.coordinateMaps.size,236);assert.equal(r.free.get('pool').length,1)
})
test('new coordinate inserted during checkpoint does not borrow old completion',async()=>{
 const {r,calls}=fixture();const late={bytes:M};r.driver.checkpoint=async()=>{calls.wait++;r.coordinateMaps.add(late);r.bytes+=M;r.workingBytes+=M}
 await r.reclaimScratch();assert.equal(calls.wait,1);assert.deepEqual([...r.coordinateMaps],[late]);assert.equal(calls.destroy,1)
})
test('failed large-cohort completion destroys nothing',async()=>{
 const {r,calls}=fixture();r.driver.checkpoint=async()=>{calls.wait++;throw Error('device lost')}
 await assert.rejects(r.reclaimScratch(),/device lost/);assert.equal(calls.destroy,0);assert.equal(r.coordinateMaps.size,1)
})
test('newly pinned selected coordinate survives completed maintenance',async()=>{
 const {r,t,calls}=fixture();r.driver.checkpoint=async()=>{calls.wait++;r.filterImageFields={pinned:new Set([t])}}
 await r.reclaimScratch();assert.equal(calls.destroy,0);assert.equal(r.coordinateMaps.has(t),true)
})
