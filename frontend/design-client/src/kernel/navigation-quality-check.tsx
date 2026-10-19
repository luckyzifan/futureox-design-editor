import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { KernelSurface } from './Surface'
import { initializePicking } from './picking'
import { scene, unionBounds } from '../geometry'
import type { DesignDocument } from '../model'
import '../styles.css'

const output = document.querySelector('#results')!,
  host = document.querySelector<HTMLElement>('#canvas')!
const report: { status: string; stages: unknown[]; error?: string } = {
  status: 'running',
  stages: [],
}
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const frame = () => new Promise<number>(requestAnimationFrame)
try {
  await initializePicking()
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document fixture required')
  const input = await response.json(),
    doc: DesignDocument = input.document || input,
    page = doc.pages[0]
  const bounds = unionBounds(
    scene(doc, page.id)
      .filter((e) => e.depth === 0)
      .map((e) => e.bounds),
  )
  const width = 1000,
    height = 640,
    root = createRoot(host)
  Object.assign(host.style, {
    position: 'relative',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
  })
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const view = (zoom: number) => ({
    x: width / 2 - center.x * zoom,
    y: height / 2 - center.y * zoom,
    zoom,
  })
  const render = (zoom: number) =>
    flushSync(() =>
      root.render(
        <KernelSurface
          document={doc}
          pageId={page.id}
          width={width}
          height={height}
          view={view(zoom)}
          grid={false}
          overview={bounds}
          presentationEpoch={1}
        />,
      ),
    )
  const state = () => ({
    tiles: { ...host.querySelector<HTMLElement>('.kernel-tiles')?.dataset },
    display: { ...host.querySelector<HTMLElement>('.kernel-compositor')?.dataset },
  })
  const waitSharp = async () => {
    const start = performance.now()
    do {
      await frame()
      const s = state()
      if (s.tiles.detailReady === 'true') return { ms: performance.now() - start, ...s }
      if (host.querySelector('.kernel-status.error'))
        throw Error(host.querySelector('.kernel-status')!.textContent!)
    } while (performance.now() - start < 120_000)
    throw Error('Viewport detail timeout')
  }
  const fit = Math.min((width * 0.85) / bounds.width, (height * 0.85) / bounds.height)
  render(fit)
  report.stages.push({
    name: 'initial',
    nodes: Object.keys(doc.nodes).length,
    dpr: devicePixelRatio,
    ...(await waitSharp()),
  })
  publish()
  const started = performance.now(),
    trace: unknown[] = []
  for (let i = 0; i <= 120; i++) {
    await frame()
    const zoom = fit * Math.pow(1 / fit, i / 120)
    render(zoom)
    const s = state()
    trace.push({
      at: performance.now() - started,
      zoom,
      scale: Number(s.tiles.samplingScale),
      ready: s.tiles.detailReady === 'true',
      sharp: Number(s.display.sharpCoverage),
      coverage: Number(s.display.coverage),
      upscale: Number(s.display.maxUpscale),
      frames: Number(s.display.compositorFrames),
      uploads: Number(s.display.compositorUploads),
    })
  }
  report.stages.push({
    name: 'continuous zoom',
    duration: performance.now() - started,
    trace,
    settled: await waitSharp(),
  })
  publish()
  render(fit)
  await waitSharp()
  const jump = performance.now()
  render(1)
  report.stages.push({
    name: 'cached zoom revisit',
    ...(await waitSharp()),
    wallMs: performance.now() - jump,
  })
  publish()
  report.status = 'passed'
  publish()
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  publish()
}
