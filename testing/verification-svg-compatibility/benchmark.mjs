// CPU XML/WASM benchmark. The only host double is Canvas.fillStyle for opaque
// hex colors, explicitly measured separately from the no-canvas geometry cases.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { importSvg } from '../../frontend/design-client/src/import-svg.ts'
import * as model from '../../frontend/design-client/src/model.ts'
import * as geometry from '../../frontend/design-client/src/geometry.ts'
import { initializePicking, kernelBounds } from '../../frontend/design-client/src/kernel/picking.ts'
import { pathNetwork } from '../../frontend/design-client/src/path-network.ts'
const require = createRequire(new URL('../../frontend/design-client/package.json', import.meta.url))
const { JSDOM } = require('jsdom')
const host = new JSDOM('')
globalThis.document = host.window.document
globalThis.DOMParser = host.window.DOMParser
await initializePicking({ wasm: new Uint8Array(readFileSync(new URL('../../frontend/design-client/public/kernel/design_kernel_bg.wasm', import.meta.url))), font: new Uint8Array(readFileSync(new URL('../../frontend/design-client/public/fonts/NotoSansSC.ttf', import.meta.url))) })
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const presentation = new Function(stripTypeScriptTypes(read('svg-presentation.before.ts').replace(/^export /gm, '')) + ';return {svgPresentation,svgPaintValue,svgRootPresentation}')()
const viewport = new Function(stripTypeScriptTypes(read('import-svg-viewport.before.ts').replace(/^import type[^\n]+\n/gm, '').replace(/^export /gm, '')) + ';return {parseSvgViewBox,svgViewportTransform}')()
const frozen = read('import-svg.before.ts')
const dependencies = { ...model, ...geometry, kernelBounds, pathNetwork, ...presentation, ...viewport }
const baseline = new Function(...Object.keys(dependencies), stripTypeScriptTypes(frozen.slice(frozen.indexOf('export function svgTransform(')).replace(/^export /gm, '')) + ';return importSvg')(...Object.values(dependencies))
let canvases = 0, contexts = 0, assignments = 0
const createElement = document.createElement.bind(document)
document.createElement = (tag, ...args) => { if(tag === 'canvas') canvases++; return createElement(tag, ...args) }
host.window.HTMLCanvasElement.prototype.getContext = function(kind) {
  assert.equal(kind, '2d'); contexts++
  let style = '#000000'
  return {
    get fillStyle() { return style },
    set fillStyle(value) {
      assignments++
      if (/^#[\da-f]{6}$/i.test(value)) style = value.toLowerCase()
      else if (/^#[\da-f]{3}$/i.test(value)) style = '#' + [...value.slice(1)].map(c => c + c).join('').toLowerCase()
      else throw new Error('The benchmark color host only implements opaque hex; fixture is invalid')
    },
  }
}
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">${body}</svg>`
const cases = [
  { name: 'rectangles-no-paint-2000', classification: 'real XML and model construction; no canvas adapter used', source: svg(Array.from({length:2000}, (_,i) => `<rect width="10" height="20" transform="translate(${i % 400} ${i % 300}) scale(1.25 .75)" fill="none"/>`).join('')) },
  { name: 'paths-no-paint-200', classification: 'real XML + CPU WASM bounds; no canvas adapter used', source: svg(Array.from({length:200}, (_,i) => `<path transform="translate(${i % 50} ${i % 40})" d="M0 0C1 2 3 4 10 10L20 20H0Z" fill="none"/>`).join('')) },
  { name: 'repeated-hex-2000', classification: 'real XML/model construction; opaque Canvas.fillStyle host double; allocation counts are deterministic, timing is not a browser/canvas result', source: svg('<rect width="10" height="20" fill="#ABC"/>'.repeat(2000)) },
  { name: 'repeated-gradient-1000', classification: 'real XML/model construction; opaque Canvas.fillStyle host double; allocation counts are deterministic, timing is not a browser/canvas result', source: svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#123456"/><stop offset="1" stop-color="#abcdef"/></linearGradient></defs>' + '<rect width="10" height="20" fill="url(#g)"/>'.repeat(1000)) },
]
const stats = samples => { const sorted = [...samples].sort((a,b)=>a-b); return { samplesMs:samples, medianMs:sorted[Math.floor(sorted.length/2)], p95Ms:sorted[Math.ceil(sorted.length*.95)-1], minMs:sorted[0], maxMs:sorted.at(-1) } }
const sourceHashes = Object.fromEntries(['import-svg.ts', 'import-svg-viewport.ts', 'svg-presentation.ts', 'svg-values.ts', 'svg-color.ts', 'svg-gradient.ts', 'path-network.ts'].map(name => [name,createHash('sha256').update(readFileSync(new URL('../../frontend/design-client/src/'+name,import.meta.url))).digest('hex')]))
const results = []
for(const fixture of cases) {
  const descriptor = Object.getOwnPropertyDescriptor(crypto,'randomUUID')
  function exact(parser) {
    let id = 0
    Object.defineProperty(crypto,'randomUUID',{ configurable:true, value:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}` })
    return parser(fixture.source)
  }
  try { assert.equal(JSON.stringify(exact(importSvg)), JSON.stringify(exact(baseline)), fixture.name + ': serialized common supported documents must be exactly identical (JSON normalizes signed zero)') }
  finally { if(descriptor) Object.defineProperty(crypto,'randomUUID',descriptor); else delete crypto.randomUUID }
  const before = [], after = [], allocationCounts = {}
  for (const [label, parser] of [['before', baseline], ['after', importSvg]]) {
    canvases=contexts=assignments=0
    const output = parser(fixture.source); model.validateDocument(output.document)
    allocationCounts[label] = { canvases, contexts, fillStyleAssignments: assignments, nodes: Object.keys(output.document.nodes).length }
    for(let i=0;i<3;i++) parser(fixture.source)
  }
  for(let i=0;i<15;i++) for(const [samples,parser] of i%2 ? [[after,importSvg],[before,baseline]] : [[before,baseline],[after,importSvg]]) {
    globalThis.gc?.()
    const start = performance.now(); const result = parser(fixture.source); samples.push(performance.now()-start)
    assert.equal(Object.keys(result.document.nodes).length, allocationCounts.before.nodes)
  }
  const beforeStats=stats(before), afterStats=stats(after)
  results.push({ name: fixture.name, classification:fixture.classification, sourceBytes:Buffer.byteLength(fixture.source), sourceSha256:createHash('sha256').update(fixture.source).digest('hex'), exactSerializedCommonSubsetEqual:true, allocationCounts, before:beforeStats, after:afterStats, ratio:afterStats.medianMs/beforeStats.medianMs })
  console.log(fixture.name, JSON.stringify(results.at(-1)))
}
const report = { classification:'Retained-production-source differential CPU benchmark; no browser, GPU, network, or OS socket.', sourceHashes, node:process.version, platform:process.platform, arch:process.arch, retainedSourceSha256:createHash('sha256').update(frozen).digest('hex'), samples:15, alternatingOrder:true, gcBetweenSamples:typeof globalThis.gc==='function', results }
writeFileSync(new URL('benchmark.json', import.meta.url),JSON.stringify(report,null,2)+'\n')
host.window.close()
