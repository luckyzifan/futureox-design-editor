import test from 'node:test'
import assert from 'node:assert/strict'
import { PoseFeedback } from './pose-feedback.ts'
test('submitted input cannot move feedback before the matching accepted pose',()=>{
 const p=new PoseFeedback();p.submit(1,{x:4,y:0});p.submit(2,{x:12,y:0})
 assert.equal(p.present(3),undefined);assert.deepEqual(p.present(1),{x:4,y:0});assert.equal(p.present(1),undefined)
 assert.deepEqual(p.present(2),{x:12,y:0});assert.equal(p.present(1),undefined)
})
test('coalescing, reset and bounded records reject missing/stale completions',()=>{
 const p=new PoseFeedback();for(let i=1;i<=300;i++)p.submit(i,{x:i,y:-i})
 assert.equal(p.present(1),undefined);assert.deepEqual(p.present(299),{x:299,y:-299});p.clear();assert.equal(p.present(300),undefined)
 p.submit(301,{x:0,y:0});assert.deepEqual(p.present(301),{x:0,y:0})
})

test('opaque submission ownership cannot be relabeled by the accepting document',()=>{
 const p=new PoseFeedback(),a={},b={};p.submit(1,{x:5,y:9},a)
 assert.equal(p.present(1,b),undefined);assert.deepEqual(p.present(1,a),{x:5,y:9})
})
