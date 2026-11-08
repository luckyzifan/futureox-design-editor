// Opens one downloaded Fig through the product importer and times production CPU frames.
// Not Electron, GPU, browser compositing, or display latency.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { zoomAt, wheelCamera } from './canvas-camera'
import { importFig } from './import-fig'
import init, { VectorEngine } from './generated/design-kernel/design_kernel'
import { renderCpuFrame } from './kernel/cpu-frame'
import { benchFonts } from './cpu-bench-fonts'

const file = process.env.CPU_FIG_OPEN_FILE || '/cursor/stores/bot/compare-fixtures/01有料素材.fig'

test.skipIf(process.env.CPU_FIG_OPEN_BENCH !== '1')('imported Fig CPU open, zoom, and pan', async () => {
  const bytes = readFileSync(file)
  const importStart = performance.now()
  const imported = importFig(new Uint8Array(bytes), file.split('/').at(-1) || 'fig')
  const importMs = performance.now() - importStart
  const wasmBytes = readFileSync(process.env.CPU_ZOOM_PAN_WASM || 'public/kernel/design_kernel_bg.wasm')
  const wasmStart = performance.now()
  const wasm = await init({ module_or_path: wasmBytes })
  const wasmInitMs = performance.now() - wasmStart
  const fonts = [readFileSync('public/fonts/NotoSansSC.ttf'), benchFonts().sans.bytes]
  const doc = imported.document
  const engine = new VectorEngine()
  const samples: { label: string; zoom: number; renderMs: number }[] = []
  try {
    const fontStart = performance.now()
    engine.load_font(fonts[0])
    engine.load_font(fonts[1])
    const fontLoadMs = performance.now() - fontStart
    const loadStart = performance.now()
    engine.load_document(JSON.stringify(doc))
    const documentLoadMs = performance.now() - loadStart
    const page = doc.pages[0]
    const options = (view: { x: number; y: number; zoom: number }) => JSON.stringify({
      pageId: page.id, width: 640, height: 480, transparent: false, view, rasterProfile: doc.rasterProfile,
    })
    let view = { x: 0, y: 0, zoom: 0.1 }
    const frames: { label: string; view: typeof view }[] = [{ label: 'open-zoom-0.1', view }]
    for (const zoom of [0.25, 0.5, 1, 2]) {
      view = zoomAt(view, zoom, { x: 320, y: 240 })
      frames.push({ label: `zoom-in-${zoom}`, view })
    }
    for (let i = 0; i < 4; i++) {
      view = wheelCamera(view, { deltaX: i % 2 ? 17 : -13, deltaY: i % 2 ? 9 : -11, deltaMode: 0 }, { width: 640, height: 480 }, { x: 320, y: 240 })
      frames.push({ label: `pan-${i + 1}`, view })
    }
    for (const zoom of [1, 0.5, 0.25, 0.1]) {
      view = zoomAt(view, zoom, { x: 320, y: 240 })
      frames.push({ label: `zoom-out-${zoom}`, view })
    }
    for (const frame of frames) {
      const begin = performance.now()
      const pixels = renderCpuFrame(engine, options(frame.view), undefined)
      const renderMs = performance.now() - begin
      expect(pixels.length).toBe(640 * 480 * 4)
      samples.push({ label: frame.label, zoom: frame.view.zoom, renderMs })
      console.log('CPU_FIG_FRAME', JSON.stringify(samples.at(-1)))
    }
    const report = {
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
      page: page.name,
      pageCount: doc.pages.length,
      nodeCount: Object.keys(doc.nodes).length,
      importMs,
      wasmInitMs,
      fontLoadMs,
      documentLoadMs,
      samples,
      scope: 'Product importFig plus VectorEngine.render_rgba at 640x480. Dev WASM. Not Electron, GPU, or display latency. Fonts are Noto Sans SC and DejaVu Sans, not the file’s Poppins/ABeeZee.',
    }
    const out = process.env.CPU_FIG_OPEN_REPORT || '/tmp/cpu-fig-open.json'
    mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true })
    writeFileSync(out, JSON.stringify(report, null, 2))
  } finally { engine.free() }
}, 300_000)
