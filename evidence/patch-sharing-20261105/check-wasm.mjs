// node check-wasm.mjs PORTABLE_BINDINGS_DIR 117.sketch FIG_DOCUMENT.json FONT.ttf
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [directory,sketch,fig,font] = process.argv.slice(2).map(p=>resolve(p))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const js=join(directory,'design_kernel.js'), bytes=await readFile(join(directory,'design_kernel_bg.wasm'))
const binding=await import(pathToFileURL(js)); binding.initSync({module:bytes})
const native=JSON.parse(await readFile(new URL('measurements.json',import.meta.url),'utf8'))
const fontBytes=await readFile(font)
const open=()=>{ const e=new binding.VectorEngine(); e.load_font(fontBytes); return e }
const report={wasm:hash(bytes),bindings:hash(await readFile(js)),cases:{}}
for(const [name,c] of Object.entries(native.cases)) {
  const small=name==='117-resize', doc=small ? JSON.parse(binding.import_sketch_json(await readFile(sketch))).document : JSON.parse(await readFile(fig,'utf8'))
  const original=JSON.stringify(doc), id=small?'B183DB8F-B3A8-4EDD-A642-5A4CDD4568B6':'92d3c8a5-981b-483e-b8d7-e6e58872f8f4'
  assert.equal(hash(original),c.document)
  let edited={...doc.nodes[id],opacity:0.25}
  if(small) {
    const graph=new binding.GraphApi(original)
    try { graph.resize(graph.node_handle(id),25,20); edited=JSON.parse(graph.document_json()).nodes[id] } finally { graph.free() }
  }
  const patch=n=>JSON.stringify({nodes:{[id]:n},fields:{}}), view=JSON.stringify(c.view)
  assert.equal(hash(patch(edited)),c.patch)
  const e=open()
  try {
    e.load_document(original)
    const before=Buffer.from(e.render_rgba(view))
    const damage=e.apply_document_patch_with_damage(patch(edited))
    const after=Buffer.from(e.render_rgba(view))
    const reverse=e.apply_document_patch_with_damage(patch(doc.nodes[id]))
    assert(before.equals(e.render_rgba(view)))
    e.load_document(JSON.stringify({...doc,nodes:{...doc.nodes,[id]:edited}}))
    assert(after.equals(e.render_rgba(view)))
    assert.equal(damage,c.qa.damage); assert.equal(reverse,c.qa.inverse)
    assert.equal(hash(before),c.qa.before); assert.equal(hash(after),c.qa.after)
    report.cases[name]={before:hash(before),after:hash(after),changedPixels:c.qa.changedPixels,damage}
  } finally { e.free() }
}
console.log(JSON.stringify(report,null,2))
