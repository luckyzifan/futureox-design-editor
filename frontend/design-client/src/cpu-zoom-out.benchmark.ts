// Same production CPU raster and camera as cpu-zoom-pan.benchmark.ts.
// Measures zoom-out after the existing bench's zoom-in ladder. Not a browser or GPU frame.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { zoomAt } from './canvas-camera'
import init, { VectorEngine } from './generated/design-kernel/design_kernel'
import { renderCpuFrame } from './kernel/cpu-frame'
import { blank, defaultTextStyle, demo } from './model'

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
function fixture() {
  const source = demo(), d = blank('Repeated production demo: CPU zoom-out')
  d.id = uuid(1); d.pages[0].id = uuid(2); d.schemaVersion = source.schemaVersion; d.rasterProfile = 'analytic'
  const sourceNodes = Object.values(source.nodes), copies = Math.ceil(3000 / sourceNodes.length)
  for (let c = 0; c < copies; c++) {
    const ids = new Map(sourceNodes.map((n, i) => [n.id, uuid(100 + c * sourceNodes.length + i)]))
    sourceNodes.forEach((n, i) => {
      const copy = structuredClone(n); copy.id = ids.get(n.id)!; copy.children = n.children.map(id => ids.get(id)!)
      if (source.pages[0].children.includes(n.id)) { copy.transform[4] += (c % 14) * 1250; copy.transform[5] += Math.floor(c / 14) * 800; d.pages[0].children.push(copy.id) }
      if (copy.kind === 'text' && !/[^\x00-\x7f]/.test(copy.text || '')) copy.textStyle = { ...defaultTextStyle(), fontId: (i + c) % 2 ? 'sans' : 'serif' }
      copy.effects = []
      d.nodes[copy.id] = copy
    })
  }
  return d
}

test.skipIf(process.env.CPU_ZOOM_OUT_BENCH !== '1')('3000+ node CPU zoom-out after the zoom-in ladder', async () => {
  const wasmBytes = readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm')
  const wasm = await init({ module_or_path: wasmBytes })
  const fonts = ['public/fonts/NotoSansSC.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'].map(path => ({ path, bytes: readFileSync(path) }))
  const resources = JSON.stringify({ sans: { family: 'DejaVu Sans', data: fonts[1].bytes.toString('base64') }, serif: { family: 'DejaVu Serif', data: fonts[2].bytes.toString('base64') } })
  const d = fixture(); d.fonts = JSON.parse(resources); const engine = new VectorEngine()
  try {
    engine.load_font(fonts[0].bytes); engine.load_document_fonts(resources); engine.load_document(JSON.stringify(d))
    const options = (view: { x: number; y: number; zoom: number }) => JSON.stringify({ pageId: d.pages[0].id, width: 640, height: 480, transparent: false, view, rasterProfile: 'analytic' })
    let view = { x: 305, y: 226, zoom: 0.1 }
    for (const zoom of [0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 32]) view = zoomAt(view, zoom, { x: 320, y: 240 })
    const samples: { zoom: number; renderMs: number }[] = []
    for (const zoom of [25.6, 12.8, 6.4, 3.2, 1.6, 0.8, 0.4, 0.2, 0.1]) {
      view = zoomAt(view, zoom, { x: 320, y: 240 })
      const begin = performance.now()
      const pixels = renderCpuFrame(engine, options(view), undefined)
      const renderMs = performance.now() - begin
      expect(pixels.length).toBe(640 * 480 * 4)
      samples.push({ zoom: view.zoom, renderMs })
      console.log('CPU_ZOOM_OUT', JSON.stringify(samples.at(-1)))
    }
    const sorted = samples.map(s => s.renderMs).sort((a, b) => a - b)
    const summary = {
      nodeCount: Object.keys(d.nodes).length,
      wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
      samples,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
      scope: 'CPU/WASM renderCpuFrame zoom-out on the effects-off 3009-node demo. Not Electron, GPU, or display latency.',
    }
    const out = process.env.CPU_ZOOM_OUT_REPORT || '/tmp/cpu-zoom-out.json'
    mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true })
    writeFileSync(out, JSON.stringify(summary, null, 2))
    console.log('CPU_ZOOM_OUT_SUMMARY', JSON.stringify(summary))
  } finally { engine.free() }
}, 180_000)
