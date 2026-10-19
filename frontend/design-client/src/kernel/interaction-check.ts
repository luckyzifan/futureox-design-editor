import { readDesignFile } from '../persistence'
import { initializePicking } from './picking'
import { scene, unionBounds } from '../geometry'
import { InteractionRenderer } from './interaction-renderer'
import { TileCompositor } from './gpu/tile-compositor'
import type { DesignDocument } from '../model'
import type { InteractionProps } from './interaction-layers'

const input = document.querySelector<HTMLInputElement>('#fixture')!
const button = document.querySelector<HTMLButtonElement>('#run')!
const output = document.querySelector<HTMLElement>('#results')!
const canvas = document.querySelector<HTMLCanvasElement>('#preview')!
let fixture: DesignDocument | undefined
input.onchange = async () => {
  try {
    button.disabled = true
    fixture = (await readDesignFile(input.files![0])).document
    output.textContent = `已加载 ${Object.keys(fixture.nodes).length} 个节点`
    button.disabled = false
  } catch (error) { output.textContent = String(error) }
}
button.onclick = async () => {
  if (!fixture) return
  button.disabled = true
  const compositor = new TileCompositor(canvas)
  let interaction: InteractionRenderer | undefined
  try {
    await initializePicking()
    const doc = fixture, page = doc.pages[0], id = page.children[1] || page.children[0]
    const bounds = unionBounds(scene(doc, page.id).map(e => e.bounds)), zoom = Math.min(900 / bounds.width, 500 / bounds.height)
    const view = { x: 50 - bounds.x * zoom, y: 50 - bounds.y * zoom, zoom }
    const probe = document.createElement('canvas'); probe.width = 16; probe.height = 10
    const pixels = probe.getContext('2d', { willReadFrequently: true })!
    const probePixels = document.querySelector<HTMLInputElement>('#pixels')!.checked
    let blankFrames = 0, checkedFrames = 0
    const paint = () => {
      if (!interaction) return
      compositor.retain(new Set(interaction.tiles.map(t => t.serial)))
      for (const tile of interaction.tiles) if (!compositor.has(tile)) {
        compositor.upload(tile); tile.bytes = new Uint8Array(); tile.bitmap?.close(); tile.bitmap = undefined
      }
      const items = interaction.items(view)
      if (items) {
        compositor.draw(items, view, 1000, 600, 1)
        if (probePixels) {
        pixels.clearRect(0, 0, 16, 10); pixels.drawImage(canvas, 0, 0, 16, 10)
        const data = pixels.getImageData(0, 0, 16, 10).data
        let content = 0
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && Math.min(data[i], data[i + 1], data[i + 2]) < 220) content++
        if (content < 3) blankFrames++
        checkedFrames++
        }
      }
    }
    interaction = new InteractionRenderer(paint)
    const props: InteractionProps = { document: doc, selection: [id], active: false, epoch: 1, control: { current: null }, onReady() {} }
    const start = performance.now()
    interaction.prepare(props, page.id, view, 1, 'figmaSubpixel', 'webgpu')
    while (!interaction.ready) {
      if (interaction.error || performance.now() - start > 60000) throw Error(interaction.error || 'Warm-up timeout')
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    const warmMs = performance.now() - start
    props.active = true
    interaction.prepare(props, page.id, view, 1, 'figmaSubpixel', 'webgpu')
    const trace: { at: number; samples: number; moves: number; uploads: number }[] = []
    const gestureStart = performance.now(), transform = doc.nodes[id].transform
    for (let i = 0; i < 360; i++) {
      await new Promise(requestAnimationFrame)
      const offset = Math.sin(i / 359 * Math.PI) * 200
      interaction.control.apply(doc, { [id]: { transform: [...transform.slice(0, 4), transform[4] + offset, transform[5]] as typeof transform } })
      // Reproduce Canvas/React's authored-document repaint during imperative motion.
      interaction.prepare(props, page.id, view, 1, 'figmaSubpixel', 'webgpu')
      trace.push({ at: performance.now() - gestureStart, samples: interaction.samples, moves: interaction.moves, uploads: compositor.uploads })
    }
    const newSamplesDuringGesture = trace.at(-1)!.samples - trace[0].samples
    const passed = !interaction.error && blankFrames === 0 && (!probePixels || checkedFrames > 0) &&
      (interaction.mode === 'retained-layers' || newSamplesDuringGesture >= 5)
    output.textContent = JSON.stringify({ status: passed ? 'passed' : 'failed', nodes: Object.keys(doc.nodes).length, mode: interaction.mode, warmMs,
      gestureMs: performance.now() - gestureStart, newSamplesDuringGesture, probePixels, blankFrames, checkedFrames,
      error: interaction.error, sampleTrace: interaction.sampleTrace, trace }, null, 2)
    // Copy displayed pixels before disposing WebGL resources.
    const saved = document.createElement('canvas'); saved.width = canvas.width; saved.height = canvas.height
    saved.getContext('2d')!.drawImage(canvas, 0, 0); canvas.after(saved)
  } catch (error) { output.textContent = JSON.stringify({ status: 'failed', error: String(error) }) }
  finally { interaction?.dispose(); compositor.dispose(); button.disabled = false }
}
