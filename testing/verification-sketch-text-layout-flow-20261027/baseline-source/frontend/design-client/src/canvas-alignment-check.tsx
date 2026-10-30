import { createRoot } from 'react-dom/client'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { initializePicking } from './kernel/picking'
import { apply, scene } from './geometry'
import { node, paint, type DesignDocument } from './model'
import { canvasContentPixelAt } from './canvas-color-picker'
import { captureContentPlane } from './kernel/content-plane'
import './styles.css'

const output = document.querySelector('#results')!
const report: { status: string; stages: any[]; error?: string } = { status: 'running', stages: [] }
const publish = async () => { output.textContent = JSON.stringify(report, null, 2); await fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) }) }
const frame = () => new Promise<number>(requestAnimationFrame)
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] || 0
try {
  await initializePicking()
  const input = await (await fetch('/__render_fixture')).json(), doc: DesignDocument = input.document || input
  const pixels = new URLSearchParams(location.search).has('pixels')
  const sourceBoard = Object.values(doc.nodes).find(n => n.name === '08_E-Mail_Inbox')!
  const marker = pixels ? node('rectangle', sourceBoard.width / 2 + 100,
    sourceBoard.height / 2 + 80, 64, 32) : undefined
  if (marker) { marker.fills = [paint('#ff00ff')]; doc.nodes[marker.id] = marker; sourceBoard.children.push(marker.id) }
  const editor = new Editor(doc), entries = scene(editor.state.doc, editor.state.page)
  const board = entries.find(e => doc.nodes[e.id].name === '08_E-Mail_Inbox') || entries.find(e => e.depth === 0)!
  const n = editor.state.doc.nodes[board.id], point = apply(board.matrix, { x: n.width / 2, y: n.height / 2 })
  const startView = { x: 500 - point.x * .6, y: 360 - point.y * .6, zoom: .6 }
  editor.set({ view: startView, selection: [marker?.id || board.id] })
  createRoot(document.querySelector('#root')!).render(<Canvas editor={editor} />)
  const host = () => document.querySelector<HTMLElement>('#design-canvas-view')!
  const ready = async () => {
    const start = performance.now()
    while (document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady !== 'true') {
      if (performance.now() - start > 90000) throw Error('Complex document did not settle')
      await frame()
    }
  }
  await ready()
  const probe = document.createElement('canvas'), context = probe.getContext('2d', { willReadFrequently: true })!
  const submitted = new Map<string, number>()
  const cameraKey = (view: typeof startView) => JSON.stringify([view.x, view.y, view.zoom])
  let previousCamera = cameraKey(editor.state.view)
  editor.subscribe(() => { const key = cameraKey(editor.state.view); if (key !== previousCamera) { submitted.set(key, performance.now()); previousCamera = key } })
  report.stages.push({ name: 'fixture', nodes: Object.keys(doc.nodes).length, board: n.name, dpr: devicePixelRatio }); await publish()
  for (const zoom of [false, true]) {
    editor.set({ view: startView }); await ready(); for (let i = 0; i < 20; i++) await frame()
    const rect = host().getBoundingClientRect(), samples: any[] = [], intervals: number[] = []
    const pixelErrors: number[] = [], gpuOutlineErrors: number[] = [], ages: number[] = []
    let last = await frame(), missingMarker = 0
    for (let i = 0; i < 120; i++) {
      for (let j = 0; j < 3; j++) host().dispatchEvent(new WheelEvent('wheel', { clientX: rect.left + 500, clientY: rect.top + 360,
        bubbles: true, cancelable: true, deltaX: zoom ? 0 : pixels && i >= 60 ? -3 : 3,
        deltaY: zoom ? (i < 60 ? -1 : 1) * (pixels ? .5 : 1) : 0, ctrlKey: zoom }))
      const now = await frame(); intervals.push(now - last); last = now
      const shown = JSON.parse(host().querySelector<HTMLElement>('.kernel-compositor')?.dataset.presentedCamera || 'null')
      const presentation = host().querySelector<HTMLElement>('.kernel-presentation')!
      if (presentation.dataset.fallbackPhase !== 'none') throw Error(`Unexpected display fallback: ${presentation.dataset.fallbackReason}`)
      const matrix = host().querySelector<SVGGraphicsElement>('[data-testid="canvas-selection-outline"]')?.getCTM()
      if (!shown || !matrix) throw Error('Missing displayed camera or selection outline')
      // A zoom anchored at the centre leaves that one point invariant. Check
      // the corners as well so a wrong density cannot falsely pass alignment.
      const errorCssPixels = Math.max(...[[0, 0], [500, 360], [1000, 720]].map(([x, y]) => {
        const world = { x: (x - shown.x) / shown.zoom, y: (y - shown.y) / shown.zoom }
        return Math.hypot(world.x * matrix.a + matrix.e - x, world.y * matrix.d + matrix.f - y)
      }))
      samples.push({ errorCssPixels,
        shown, overlay: { x: matrix.e, y: matrix.f, zoom: matrix.a }, requested: { ...editor.state.view } })
      const submittedAt = submitted.get(cameraKey(shown)); if (submittedAt !== undefined) ages.push(performance.now() - submittedAt)
      if (marker && i % 4 === 0) {
        const canvas = host().querySelector<HTMLCanvasElement>('.kernel-compositor')!
        probe.width = canvas.width; probe.height = canvas.height
        context.drawImage(canvas, 0, 0)
        const data = context.getImageData(0, 0, probe.width, probe.height).data
        let left = Infinity, top = Infinity, right = -1, bottom = -1
        for (let at = 0; at < data.length; at += 4) if (data[at] > 240 && data[at + 1] < 15 && data[at + 2] > 240 && data[at + 3] > 240) {
          const pixel = at / 4, x = pixel % probe.width, y = Math.floor(pixel / probe.width)
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
        }
        if (right < left) missingMarker++
        else {
          const world = apply(board.matrix, { x: marker.transform[4] + marker.width / 2, y: marker.transform[5] + marker.height / 2 })
          // The worker may present again before its acknowledgement reaches
          // the main thread. Pair content pixels with their captured camera,
          // never with the independently sampled SVG/dataset above.
          const capture=await captureContentPlane(canvas)
          try {
            if(!capture.frame)throw Error('Content capture omitted its camera')
            probe.width=capture.bitmap.width;probe.height=capture.bitmap.height
            context.drawImage(capture.bitmap,0,0)
            const bytes=context.getImageData(0,0,probe.width,probe.height).data
            let l=Infinity,t=Infinity,r=-1,b=-1
            for(let at=0;at<bytes.length;at+=4)if(bytes[at]>240&&bytes[at+1]<15&&bytes[at+2]>240&&bytes[at+3]>240){
              const pixel=at/4,px=pixel%probe.width,py=Math.floor(pixel/probe.width)
              l=Math.min(l,px);r=Math.max(r,px);t=Math.min(t,py);b=Math.max(b,py)
            }
            if(r<l)throw Error('Content snapshot lost the marker')
            const view=capture.frame.view,x=world.x*view.zoom+view.x,y=world.y*view.zoom+view.y
            pixelErrors.push(Math.hypot((l+r+1)/2/(capture.bitmap.width/capture.frame.width)-x,(t+b+1)/2/(capture.bitmap.height/capture.frame.height)-y))
          } finally {capture.bitmap.close()}
          let blueLeft = Infinity, blueRight = -1, blueTop = Infinity, blueBottom = -1
          for (let py = Math.max(0, top - 12); py <= Math.min(probe.height - 1, bottom + 12); py++)
            for (let px = Math.max(0, left - 12); px <= Math.min(probe.width - 1, right + 12); px++) {
              const at = (py * probe.width + px) * 4
              if (data[at] < 35 && data[at + 1] > 135 && data[at + 1] < 175 && data[at + 2] > 240) {
                blueLeft = Math.min(blueLeft, px); blueRight = Math.max(blueRight, px)
                blueTop = Math.min(blueTop, py); blueBottom = Math.max(blueBottom, py)
              }
            }
          if (blueRight < blueLeft) throw Error('Selection was not drawn into the content canvas')
          gpuOutlineErrors.push(Math.hypot((blueLeft + blueRight - left - right) / 2 / devicePixelRatio,
            (blueTop + blueBottom - top - bottom) / 2 / devicePixelRatio))
        }
      }
    }
    const errors = samples.map(s => s.errorCssPixels)
    report.stages.push({ name: zoom ? 'pinch zoom alignment' : 'wheel pan alignment', samples,
      maxError: Math.max(...errors), p95Error: percentile(errors, .95), frameP95: percentile(intervals, .95),
      displayedAgeP95: percentile(ages, .95), pixelChecks: pixelErrors.length, missingMarker,
      pixelErrorMax: Math.max(0, ...pixelErrors), pixelErrorP95: percentile(pixelErrors, .95),
      gpuOutlineErrorMax: Math.max(0, ...gpuOutlineErrors), gpuOutlineErrorP95: percentile(gpuOutlineErrors, .95) }); await publish()
    await ready()
  }
  if (marker) {
    const world = apply(board.matrix, { x: marker.transform[4] + marker.width / 2, y: marker.transform[5] + marker.height / 2 })
    const view=editor.state.view, rect=host().getBoundingClientRect()
    let picked: string | undefined, sampleRetries = 0
    for (; sampleRetries < 30; sampleRetries++) {
      try { picked=await canvasContentPixelAt(host(),rect.left+world.x*view.zoom+view.x,rect.top+world.y*view.zoom+view.y); break }
      catch(error) { if(!String(error).includes('画面已变化'))throw error; await frame() }
    }
    const captured=await captureContentPlane(host().querySelector<HTMLCanvasElement>('.kernel-compositor')!)
    try {
      if(picked!=='#ff00ff'||captured.frame?.document!==editor.state.doc||captured.frame?.view.zoom!==view.zoom)
        throw Error('Displayed document sampling or snapshot ownership mismatch')
      report.stages.push({name:'real Canvas content-only picker and startup snapshot',picked,sampleRetries,ownerMatches:true})
    } finally {captured.bitmap.close()}
  }
  report.status = report.stages.some(s => s.maxError > .25 || s.missingMarker > 0 || s.pixelErrorMax > .51 * Math.SQRT2 / devicePixelRatio || s.gpuOutlineErrorMax > .51 * Math.SQRT2 / devicePixelRatio) ? 'failed' : 'passed'
  await publish()
} catch (error) { report.status = 'failed'; report.error = String(error); await publish() }
