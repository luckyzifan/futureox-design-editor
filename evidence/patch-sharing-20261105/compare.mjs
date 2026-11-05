// node compare.mjs BASE_NATIVE CANDIDATE_NATIVE 117.sketch FIG_DOCUMENT.json FONT.ttf
// The FIG argument is the complete authored JSON from a real editor import.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cpus, release } from 'node:os'
import { NativePreparation } from '../../frontend/design-desktop/src/preparation.mjs'
import * as wasm from '../../frontend/design-client/src/generated/design-kernel/design_kernel.js'

const [base, candidate, sketchPath, figPath, font] = process.argv.slice(2).map(p => resolve(p))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bindings = await readFile(new URL('../../frontend/design-client/src/generated/design-kernel/design_kernel_bg.wasm', import.meta.url))
wasm.initSync({module: bindings})
const sketch = await readFile(sketchPath)
const small = JSON.parse(wasm.import_sketch_json(sketch)).document
const id = 'B183DB8F-B3A8-4EDD-A642-5A4CDD4568B6'
const graph = new wasm.GraphApi(JSON.stringify(small))
let resized
try { graph.resize(graph.node_handle(id),25,20); resized = JSON.parse(graph.document_json()).nodes[id] }
finally { graph.free() }
assert.equal(small.nodes[id].name, '椭圆 66')
const fig = await readFile(figPath)
const large = JSON.parse(fig)
const leaf = '92d3c8a5-981b-483e-b8d7-e6e58872f8f4'
assert.equal(Object.keys(large.nodes).length, 20082)
assert.equal(large.nodes[leaf].opacity, 1)
function ownerPage(doc, id) {
  return doc.pages.find(p => {
    const todo = [...p.children]
    while (todo.length) {
      const key = todo.pop()
      if (key === id) return true
      todo.push(...doc.nodes[key].children ?? [])
    }
  }).id
}
const cases = [
  { name:'117-resize', doc:small, id, edited:resized, x:-1148, y:-392 },
  { name:'FIG-opacity', doc:large, id:leaf, edited:{...large.nodes[leaf],opacity:0.25}, x:439, y:54 },
]
function open(bin) {
  const child = new NativePreparation(bin, font)
  return {
    async call(method, arg) {
      const r = await child.request({lane:'canvas',method,args:[arg]})
      if (r.error) throw Error(r.error)
      return r.value
    },
    async close() { child.close(); await child.done },
  }
}
const median = xs => { const s = xs.toSorted((a,b)=>a-b); return (s[(s.length-1)>>1]+s[s.length>>1])/2 }
const report = { cpu:cpus()[0].model, os:release(), node:process.version, native:await Promise.all([base,candidate].map(async p=>hash(await readFile(p)))),
  inputHashes:{sketch:hash(sketch),figDocument:hash(fig),font:hash(await readFile(font)),inputGeneratorWasm:hash(bindings)},
  order:'ABBA', groups:6, warmups:3, cases:{} }
const selected = cases.filter(c => !process.env.COW_CASE || process.env.COW_CASE === c.name)
assert(selected.length, 'unknown case')
for (const c of selected) {
  const {name,doc,id,edited,x,y} = c
  const original = JSON.stringify(doc)
  const changed = JSON.stringify({...doc,nodes:{...doc.nodes,[id]:edited}})
  const view = JSON.stringify({pageId:ownerPage(doc,id), width:64, height:48, view:{x,y,zoom:1},rasterProfile:'figmaSubpixel'})
  const patch = n => JSON.stringify({nodes:{[id]:n},fields:{}})
  const forward = patch(edited), reverse = patch(doc.nodes[id])
  const apply = (d, p) => d.call('apply_document_patch_with_damage',p)
  const packet = d => d.call('compile_gpu_packet',view)
  const pixels = async d => Buffer.from(await d.call('render_cpu_frame',view))
  const drivers = [base,candidate].map(open)
  try {
    const checks = []
    for (const d of drivers) {
      await d.call('load_document',original)
      const before = await pixels(d), damage = await apply(d,forward), after = await pixels(d)
      assert.equal(before.length, 64*48*4); assert.equal(after.length,before.length)
      const inverse = await apply(d,reverse)
      assert(before.equals(await pixels(d)), 'inverse must restore every pixel')
      await d.call('load_document',changed)
      assert(after.equals(await pixels(d)), 'incremental pixels must match fresh load')
      let changedPixels = 0
      for (let i=0;i<before.length;i+=4) if (before.readUInt32LE(i)!==after.readUInt32LE(i)) changedPixels++
      assert(changedPixels>0, 'the chosen edit must be visible')
      checks.push({damage,inverse,before:hash(before),after:hash(after),changedPixels})
      await d.call('load_document',original); await packet(d)
    }
    assert.deepEqual(checks[1],checks[0])
    if (process.env.COW_QA_ONLY === '1') {
      report.cases[name] = {qa:checks[0],view:JSON.parse(view)}
      continue
    }
    const sample = async d => {
      const start = performance.now(), damage = await apply(d,forward), patched = performance.now()
      const frame = await packet(d), ready = performance.now()
      assert.equal(damage,checks[0].damage); assert(frame.byteLength>0)
      assert.equal(await apply(d,reverse),checks[0].inverse); await packet(d)
      return {patchMs:patched-start,packetMs:ready-start}
    }
    for(let i=0;i<report.warmups;i++) for(const driver of drivers) await sample(driver)
    const samples = [[],[]]
    for(let i=0;i<report.groups;i++) for(const arm of [0,1,1,0]) samples[arm].push(await sample(drivers[arm]))
    report.cases[name] = {nodes:Object.keys(doc.nodes).length,document:hash(original),patch:hash(forward),view:JSON.parse(view),
      qa:checks[0],medians:samples.map(a=>({patchMs:median(a.map(v=>v.patchMs)),packetMs:median(a.map(v=>v.packetMs))})),samples}
    console.error(name,JSON.stringify(report.cases[name].medians))
  } finally { for(const d of drivers) await d.close() }
}
console.log(JSON.stringify(report,null,2))
