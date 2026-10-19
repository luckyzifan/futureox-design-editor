/** Reproduce the worker's managed-document render latency for the real 117
 * import camera: how long the exact tier takes in the browser's wasm engine. */
import { readFileSync } from 'node:fs'
import initialize, { VectorEngine } from '../src/generated/design-kernel/design_kernel'

const PROFILE = process.env.PROFILE || 'analytic'
const request = JSON.parse(readFileSync('/tmp/req_117_z100.json', 'utf8'))
const documentJson = JSON.stringify(request.document)
const font = readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))

await initialize({ module_or_path: new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url).href })
const engine = new VectorEngine()
engine.load_font(new Uint8Array(font))
engine.load_document(documentJson)

const options = (zoom: number) =>
  JSON.stringify({
    pageId: request.document.pages[0].id,
    width: 1600,
    height: 1000,
    view: { x: 0, y: 0, zoom },
    transparent: false,
    rasterProfile: PROFILE as string,
  })

for (const zoom of [0.25]) {
  try {
    const t0 = performance.now()
    const linear = engine.render_linear(options(zoom))
    console.log(`zoom ${zoom}: render_linear = ${(performance.now() - t0).toFixed(0)}ms`)
  } catch (e) {
    console.log(`zoom ${zoom}: render_linear FAILED: ${e}`)
    console.log('stats:', engine.stats())
  }
}
// The failing camera: fit zoom 0.472, figma profile — with and without tier.
for (const interactive of [false, true]) {
  const opts = JSON.parse(options(0.472))
  opts.rasterProfile = PROFILE
  if (interactive) opts.interactiveEffects = true
  try {
    const t0 = performance.now()
    engine.render_rgba(JSON.stringify(opts))
    console.log(`zoom 0.472 tier=${interactive} render(): OK ${(performance.now() - t0).toFixed(0)}ms`)
    const t1 = performance.now()
    engine.render_rgba(JSON.stringify(opts))
    console.log(`  warm repeat: ${(performance.now() - t1).toFixed(0)}ms`)
    const t2 = performance.now()
    const pan = JSON.parse(JSON.stringify(opts)); pan.view.x = -384
    engine.render_rgba(JSON.stringify(pan))
    console.log(`  pan 384px: ${(performance.now() - t2).toFixed(0)}ms`)
  } catch (e) {
    console.log(`zoom 0.472 tier=${interactive}: FAILED ${e}`)
    console.log('ledger:', engine.compositing_ledger())
    console.log('stats:', engine.stats())
  }
}
engine.free()
