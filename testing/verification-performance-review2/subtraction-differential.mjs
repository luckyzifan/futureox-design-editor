/** Direct production fragment subtraction, tested independently of GPU/device code. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const before = read('../verification-performance-publication/composite-draw-plan.before.ts')
const after = read('../../frontend/design-client/src/kernel/gpu/composite-draw-plan.ts')
const hash = text => createHash('sha256').update(text).digest('hex')
assert.equal(hash(before), 'c2299336e926a8c83ca3daeb92fde2db5b74a6770c4cf071d5c5ea84eae53f55')
assert.equal(hash(after), '8d9f7ee0a4679e7e53b2c9423b2ea0be1d4c6f4fca2d6896850edc90f02a157c')
const load = async source => (await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source + '\nexport { subtract };'))}`)).subtract
const old = await load(before), current = await load(after)
const badPrefix = await load(after.replace('pieces ??= fragments.slice(0, index)', 'pieces ??= []'))
const badSuffix = await load(after.replace('pieces?.push(a)', 'void a'))
const edges = [-1, -0, .5, 1, 2, 4]
const boxes = []
for (let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++) for(let k=0;k<edges.length;k++) for(let l=k+1;l<edges.length;l++)
  boxes.push(Object.freeze({left:edges[i],right:edges[j],top:edges[k],bottom:edges[l]}))
let comparisons=0, changedCases=0, prefixDetected=0, suffixDetected=0
const inspect = (fragments, occluder) => {
  const expected=fragments.flatMap(a=>old(a,occluder)), snapshot=fragments.slice(), actual=current(fragments,occluder)
  assert.deepStrictEqual(actual, expected); assert.deepStrictEqual(fragments,snapshot)
  assert.equal(actual.length, expected.length); comparisons++
  for(let i=0;i<actual.length;i++) if(fragments.includes(expected[i])) assert.equal(actual[i],expected[i])
  if(actual!==fragments)changedCases++
  try { assert.deepStrictEqual(badPrefix(fragments,occluder),expected) } catch { prefixDetected++ }
  try { assert.deepStrictEqual(badSuffix(fragments,occluder),expected) } catch { suffixDetected++ }
  return actual
}
// Every finite grid box is tested against every occluder with disjoint prefix
// and suffix witnesses; positive and negative signed zero are preserved.
for(const b of boxes) for(const a of boxes) inspect(Object.freeze([
  Object.freeze({left:-20,right:-10,top:-20,bottom:-10}), a,
  Object.freeze({left:10,right:20,top:10,bottom:20}),
]),b)
let seed=0x8d238a91
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/0x100000000)
for(let scene=0;scene<2000;scene++) {
  let fragments=Array.from({length:1+Math.floor(random()*8)},()=>boxes[Math.floor(random()*boxes.length)])
  for(let j=0;j<8;j++) fragments=inspect(Object.freeze(fragments),boxes[Math.floor(random()*boxes.length)])
}
assert.ok(changedCases>1000); assert.ok(prefixDetected>1000); assert.ok(suffixDetected>1000)
console.log(JSON.stringify({ status:'passed', comparisons, gridPairs: boxes.length ** 2, repeatedScenes:2000,
  changedCases, negativeControls:{droppedPrefix:prefixDetected,droppedSuffix:suffixDetected},
  precision:'deepStrictEqual including signed zero; untouched object identity; no mutation; exact old arithmetic',
  beforeSha256:hash(before),afterSha256:hash(after), device:'CPU JavaScript only; no GPU/browser claim' },null,2))
