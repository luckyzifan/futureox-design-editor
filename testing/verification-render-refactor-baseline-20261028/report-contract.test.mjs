import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateReport, countRenderStalls, rasterMetric} from './report-contract.mjs'
const config = {viewport:{width:800,height:600},sourceRoots:306,sourceNodes:124447,guards:{minChangedPixels:1000,maxTransparentPixels:0},cases:[{id:'reference',zoom:9.5,equivalence:'fresh'},{id:'motion',zoom:9.5,motion:'fresh',equivalence:'fresh'}]}
const camera = {x:-100,y:-200,zoom:9.5}
function valid() {
  const frame = {presentationId:'current:1',view:camera,dpr:2}
  const pixels = {sha256:'a'.repeat(64),width:1600,height:1200,changedPixels:10000,transparentPixels:0,frame}
  return structuredClone({source:{roots:306,nodes:124447},runtime:{dpr:2,executionPolicy:{cpuOnly:false}},samples:config.cases.map(c=>({id:c.id,status:'complete',target:camera,initialTarget:{x:0,y:0,zoom:4},inputs:[{view:camera}],readyAt:150,finalTargetAt:100,stopToReadyMs:50,readyFrame:frame,readyPixels:pixels,quietPixels:pixels,qualityAtReady:{presented:frame,nativeCoverageComplete:true,pixelCoverageComplete:true,maxUpscale:1,nativePhaseCoverage:1},requests:[{tiles:2,backend:'webgpu'}],errors:[],visibleUiStalls:0,drained:true,activeAfterQuiet:0}))})
}
test('complete current evidence passes consistency only, not latency or fidelity',()=>{const a=evaluateReport(valid(),config);assert.equal(a.status,'PASS');assert.equal(a.latency.status,'BLOCKED');assert.equal(a.visualFidelity.status,'NOT_RUN')})
test('a sharp cached return cannot stand in for a fresh target',()=>{const r=valid();r.samples[1].initialTarget={...camera};assert.ok(evaluateReport(r,config).failures.includes('motion:fresh-target-not-exercised'))})
test('late high-quality statistics cannot certify the completion frame',()=>{const r=valid();r.samples[0].qualityAtReady.presented.presentationId='later:2';r.samples[0].readyFrame={presentationId:'first:1',view:camera,dpr:2};assert.ok(evaluateReport(r,config).failures.includes('reference:ready-quality-unproved'))})
test('missing metrics cannot silently become zero/success',()=>{const r=valid();delete r.samples[0].visibleUiStalls;delete r.samples[0].readyPixels.changedPixels;r.samples[0].qualityAtReady.maxUpscale=null;const f=evaluateReport(r,config).failures;assert.ok(f.includes('reference:ui-stall-or-missing'));assert.ok(f.includes('reference:readyPixels:blank-or-missing-pixels'));assert.ok(f.includes('reference:ready-quality-unproved'))})
test('unexpected transparent holes fail even with many nonbackground pixels',()=>{const r=valid();r.samples[0].readyPixels.transparentPixels=1;assert.ok(evaluateReport(r,config).failures.includes('reference:readyPixels:unexpected-transparency'))})
test('settling cannot alter a supposedly complete frame',()=>{const r=valid();r.samples[0].quietPixels={...r.samples[0].quietPixels,sha256:'b'.repeat(64)};assert.ok(evaluateReport(r,config).failures.includes('reference:settled-pixel-drift'))})
test('wrong camera, DPR and dimensions fail independently',()=>{const r=valid();r.samples[0].quietPixels={...r.samples[0].quietPixels,width:800,frame:{view:{...camera,zoom:4},dpr:1}};const f=evaluateReport(r,config).failures;assert.ok(f.includes('reference:quietPixels:stale-pixels'));assert.ok(f.includes('reference:quietPixels:pixel-size'))})
test('incomplete overview or missing case never counts as success',()=>{const r=valid();r.samples[1].status='failed';assert.ok(evaluateReport(r,config).failures.includes('motion:incomplete'));r.samples.pop();assert.ok(evaluateReport(r,config).failures.includes('motion:incomplete'))})
test('duplicate successful entries cannot mask a failed scenario',()=>{const r=valid();r.samples.push(structuredClone(r.samples[0]));assert.ok(evaluateReport(r,config).failures.includes('duplicate-case'))})
test('unobserved backlog and revised first-ready timestamps fail',()=>{const r=valid();r.samples[0].activeAfterQuiet=1;r.samples[0].readyAt=200;const f=evaluateReport(r,config).failures;assert.ok(f.includes('reference:queue-not-drained'));assert.ok(f.includes('reference:timing-inconsistent'))})
test('source omissions and CPU substitution fail',()=>{const r=valid();r.source.nodes--;r.samples[0].requests[0].backend='cpu';const f=evaluateReport(r,config).failures;assert.ok(f.includes('source-coverage'));assert.ok(f.includes('reference:backend-unproved'))})
test('readback and report overhead is separated from visible rendering stalls',()=>assert.equal(countRenderStalls([{visible:true,stage:'readback'},{visible:true,stage:'report'},{visible:false,stage:'render'},{visible:true,stage:'motion'}]),1))
test('initialization zero cannot make a cancelled raster appear to cost zero',()=>{
  const rows=[{tiles:0,compileMs:0,drawCalls:0},{tiles:2,error:'PREVIEW_CANCELLED'}]
  assert.equal(rasterMetric(rows,'compileMs'),null)
  assert.equal(rasterMetric(rows,'drawCalls'),null)
  assert.equal(rasterMetric([...rows,{tiles:2,compileMs:20}],'compileMs'),20)
})
