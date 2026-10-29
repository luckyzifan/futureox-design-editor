import test from 'node:test'
import assert from 'node:assert/strict'
import {canReusePresented,evaluateStrict} from './strict-report.mjs'
const camera={x:0,y:0,zoom:4},frame={presentationId:'a',view:camera,width:800,height:600,dpr:2}
test('no-op target reuses only a current, complete ACK after the latest real camera change',()=>{
 const last={at:40,frame,complete:true}
 assert(canReusePresented(last,camera,30,frame,800,600,2))
 assert(!canReusePresented(last,camera,50,frame,800,600,2))
 assert(!canReusePresented(last,camera,30,{...frame,presentationId:'newer'},800,600,2))
 assert(!canReusePresented({...last,complete:false},camera,30,frame,800,600,2))
 assert(!canReusePresented(last,{...camera,x:1},30,frame,800,600,2))
 assert(!canReusePresented(last,camera,30,frame,800,600,1))
})
const config={latencyAcceptance:{latestVisibleFrameP95Ms:33,stopToNativeReadyMs:100,maximumMotionUpscale:1},cases:[{id:'return',motion:'return'}]}
const row={id:'return',status:'complete',effectiveFinalInputAt:30,finalTargetAt:60,readyPixels:{pixelsAvailableAt:80},
 motionQuality:{samples:3,maxUpscale:1},inputs:[{at:30,view:camera,changed:true},{at:60,view:camera,changed:false}],presentations:[{at:40,presented:frame}]}
test('readback uses last changed input, excludes PNG IO and never promotes an ACK proxy to visible-pixel PASS',()=>{
 const result=evaluateStrict({assessment:{status:'PASS'},samples:[row]},config)
 assert.equal(result.cases[0].stopToNativePixelReadbackMs,50)
 assert.equal(result.cases[0].acknowledgementProxy.p95Ms,10)
 assert.equal(result.status,'INCOMPLETE')
})
test('a 101 ms readback and an 8x texture remain explicit failures',()=>{
 const result=evaluateStrict({assessment:{status:'PASS'},samples:[{...row,readyPixels:{pixelsAvailableAt:131},motionQuality:{samples:4,maxUpscale:8}}]},config)
 assert.equal(result.status,'FAIL');assert.equal(result.failures.length,2)
})
test('threshold edits or missing approval data cannot silently change the gate',()=>{
 assert.throws(()=>evaluateStrict({samples:[]},{...config,latencyAcceptance:{...config.latencyAcceptance,stopToNativeReadyMs:150}}))
})
