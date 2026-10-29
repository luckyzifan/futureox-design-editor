import test from 'node:test'
import assert from 'node:assert/strict'
import {PassDrawWork,FastPathWork} from '../src/render-pass-work.mjs'
import {textureAllocationError,annotateTextureFailure,textureFailureFields,inheritTextureFailure} from '../src/render-texture-failure.mjs'
import {sanitizeFields} from '../src/render-terminal-diagnostics.mjs'

test('image row diagnostics keep bounded numeric progress and discard payloads',()=>{
 const progress={imageRowChunks:56,imageRowPixels:14371008,imageRowMaxBytes:4129600,imageRowReason:1,imageRowOutcome:1}
 assert.deepEqual(sanitizeFields({...progress,uri:'data:image/png;base64,private'}),progress)
 assert.deepEqual(sanitizeFields({imageRowChunks:-1,imageRowPixels:16777217,imageRowMaxBytes:4194305,imageRowReason:3,imageRowOutcome:NaN}),{})
})

test('draw decomposition accounts actual encoded channel draws without double counting clear passes',()=>{
 const work=new PassDrawWork();work.reset(true)
 for(const [mode,count]of [[31,4],[2,4],[3,4],[22,8],[0,1],[63,2],[64,1],[14,1],[51,1]])work.draw(mode,count)
 work.clear()
 const fields=work.snapshot()
 assert.equal(fields.drawCoverage,6);assert.equal(fields.drawEffect,8)
 assert.equal(Object.entries(fields).filter(([k])=>/^draw(Coverage|Paint|Merge|Effect|Copy|Present|PaintMerge|Other)$/.test(k)).reduce((n,[,v])=>n+v,0),26)
 assert.equal(fields.clearPasses,1)
 assert.deepEqual(sanitizeFields(fields),fields)
 work.reset(false);work.draw(31,100);assert.deepEqual(work.snapshot(),{})
})
test('motion/zoom shader draws never collide with the synthetic solid-batch counter',()=>{
 const work=new PassDrawWork();work.reset(true);work.draw(61);work.draw(62);work.draw(64)
 const fields=work.snapshot();assert.equal(fields.drawEffect,2);assert.equal(fields.drawPaintMerge,1)
 assert.deepEqual(sanitizeFields(fields),fields)
})
test('pixel work and rejection reasons survive the numeric privacy boundary without payloads',()=>{
 const draws=new PassDrawWork();draws.reset(true);draws.draw(65,1,4096);draws.draw(0,1,128)
 const fast=new FastPathWork();fast.reset(true);fast.add('fastRegionalUsed');fast.add('fastRegionalPixels',128);fast.add('secret-node-id',5)
 const values={...draws.snapshot(),...fast.snapshot()}
 assert.equal(values.drawPixelsPaintMerge,4096);assert.equal(values.drawPixelsCopy,128)
 assert.equal(values['secret-node-id'],undefined);assert.deepEqual(sanitizeFields(values),values)
 fast.reset(false);fast.add('fastRegionalUsed');assert.deepEqual(fast.snapshot(),{})
})
test('texture extent failures retain dimensions and site through classification without strings',()=>{
 const error=textureAllocationError(32769,32,16384,4)
 annotateTextureFailure(error,{textureAllocationSite:12,texturePass:32,textureAllocationKind:4,textureKernelRadius:1024.25,textureLogicalTexels:32769,secret:'private'})
 const copy=inheritTextureFailure(error,new Error(error.message))
 const fields=textureFailureFields(copy)
 assert.equal(fields.textureWidth,32769);assert.equal(fields.textureMaxDimension,16384)
 assert.equal(fields.textureKernelRadius,1024.25)
 assert.equal(fields.secret,undefined)
 assert.deepEqual(sanitizeFields(fields),fields)
 assert.deepEqual(textureFailureFields({textureWidth:1,stack:'untrusted'}),{})
})
