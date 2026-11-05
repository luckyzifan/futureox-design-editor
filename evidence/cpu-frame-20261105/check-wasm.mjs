// node check-wasm.mjs WORKDIR -- WORKDIR contains the fixtures, qa.json and wasm/ bindings.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const dir = resolve(process.argv[2])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = await import(pathToFileURL(join(dir,'wasm/design_kernel.js')))
const binary = await readFile(join(dir,'wasm/design_kernel_bg.wasm'))
binding.initSync({module:binary})
const native = JSON.parse(await readFile(join(dir,'qa.json'),'utf8'))
const results = {}
for (const name of ['blur','backdrop','mask','zoom','hdr']) {
  const engine = new binding.VectorEngine()
  try {
    engine.load_document(await readFile(join(dir,name+'.json'),'utf8'))
    const view = await readFile(join(dir,name+'-view.json'),'utf8')
    const linear = engine.render_linear(view)
    const digest = hash(new Uint8Array(linear.buffer,linear.byteOffset,linear.byteLength))
    assert.equal(digest,native[name].floatHash,name)
    results[name] = {floatHash:digest,channels:linear.length}
    if (name==='hdr') {
      const png = engine.render_color_png(view,JSON.stringify({space:'rec2100-pq',toneMap:'none'}))
      results[name].pngHash = hash(png)
      assert.equal(results[name].pngHash,native[name].pngHash)
    }
  } finally { engine.free() }
}
console.log(JSON.stringify({wasm:hash(binary),cases:results},null,2))
