import { afterEach, expect, test, vi } from 'vitest'
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { blank, node } from '../model'
import { Editor } from '../engine'
import { dispatchEditorCommand, selectionCameraBox } from '../editor-commands'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { CameraReprojection } from './camera-reprojection'
import { selectCoverageUnderlay } from './coverage-stack'
import { NavigationBacking, NAVIGATION_BACKING_BYTES } from './navigation-backing'
import { referenceOverlayCamera } from './reference-zoom-frame'
import { previewCameraScaleWithinLimit, previewUpscaleWithinLimit, showRetainedPreview } from './tile-preview'
import type { RasterTile } from './tile-cache'

afterEach(() => vi.unstubAllGlobals())

test('a page thumbnail is not a readable frame after a large zoom-in', () => {
  expect(previewUpscaleWithinLimit(0.05, 1.197)).toBe(false)
  expect(previewUpscaleWithinLimit(256, 1.197)).toBe(true)
  expect(previewCameraScaleWithinLimit(256, 1.197)).toBe(false)
  expect(previewCameraScaleWithinLimit(1, 2)).toBe(true)
  expect(previewCameraScaleWithinLimit(1, 0.5)).toBe(true)
  const coarse = { key: 'page', x: 0, y: 0, width: 514, height: 514, zoom: 0.05, gutter: 1 } as RasterTile
  const view = { x: 0, y: 0, zoom: 1.197 }
  expect(selectCoverageUnderlay([coarse], view, { width: 800, height: 600 }, [])).toEqual([])
})

test('a zoom jump past 2× keeps the previous image until a covering replacement exists', () => {
  expect(showRetainedPreview({ sourceZoom: 256, viewZoom: 1.197, intersects: true, replacementCovers: false })).toBe(true)
  expect(showRetainedPreview({ sourceZoom: 1, viewZoom: 8, intersects: true, replacementCovers: false })).toBe(true)
  expect(showRetainedPreview({ sourceZoom: 256, viewZoom: 1.197, intersects: true, replacementCovers: true })).toBe(false)
  expect(showRetainedPreview({ sourceZoom: 1, viewZoom: 1.5, intersects: true, replacementCovers: false })).toBe(true)
  expect(showRetainedPreview({ sourceZoom: 1, viewZoom: 8, intersects: false, replacementCovers: false })).toBe(false)
  const dom = new JSDOM('<div><canvas></canvas></div>')
  vi.stubGlobal('document', dom.window.document)
  const host = document.querySelector('div')!
  const canvas = document.querySelector('canvas')!
  const settled = vi.fn()
  vi.useFakeTimers()
  let projection: CameraReprojection | undefined
  try {
  projection = new CameraReprojection(canvas, host, settled)
  const backing = {
    presentationId: 'accepted', view: { x: -129608, y: -32712, zoom: 256 },
    width: 800, height: 600, dpr: 2, interaction: false, ids: [1],
  }
  projection.update(backing, backing.view, 800, 600, true)
  const zoomedOut = projection.update(backing, { x: 40, y: 40, zoom: 1.197 }, 800, 600, true)
  expect(zoomedOut.active).toBe(true)
  expect(canvas.style.visibility).not.toBe('hidden')
  expect(canvas.style.transform).toContain('scale(')
  expect(canvas.dataset.cameraReprojected).toBe('true')
  expect(canvas.dataset.previewUpscaleRejected).toBe('true')
  expect(settled).not.toHaveBeenCalled()
  vi.advanceTimersByTime(0)
  expect(settled).toHaveBeenCalledOnce()
  const page = {
    presentationId: 'accepted', view: { x: 0, y: 0, zoom: 1 },
    width: 800, height: 600, dpr: 2, interaction: false, ids: [1],
  }
  projection.update(page, page.view, 800, 600, true)
  const zoomedIn = projection.update(page, { x: 0, y: 0, zoom: 8 }, 800, 600, true)
  expect(zoomedIn.active).toBe(true)
  expect(canvas.style.visibility).not.toBe('hidden')
  expect(canvas.style.transform).toContain('scale(')
  expect(canvas.dataset.previewUpscaleRejected).toBe('true')
  const covered = projection.update(page, { x: 0, y: 0, zoom: 8 }, 800, 600, true, undefined, true)
  expect(covered.active).toBe(false)
  expect(canvas.style.visibility).toBe('hidden')
  expect(canvas.style.transform).toBe('')
  expect(canvas.dataset.previewUpscaleRejected).toBe('true')
  } finally {
    projection?.dispose()
    vi.useRealTimers()
    dom.window.close()
  }
})

test('a page atlas is not stretched across a closer camera', () => {
  const dom = new JSDOM('<div></div>')
  vi.stubGlobal('document', dom.window.document)
  vi.spyOn(dom.window.HTMLCanvasElement.prototype as { getContext(kind: '2d'): CanvasRenderingContext2D | null }, 'getContext')
    .mockReturnValue({ drawImage() {}, clearRect() {} } as unknown as CanvasRenderingContext2D)
  const host = document.querySelector('div')!
  const backing = new NavigationBacking(host)
  backing.bind({})
  const source = document.createElement('canvas')
  source.width = 80
  source.height = 60
  const frame = {
    view: { x: 0, y: 0, zoom: 1 }, width: 800, height: 600, dpr: 1, interaction: false,
    ids: [1], preview: false, navigationBackingBytes: NAVIGATION_BACKING_BYTES,
  }
  backing.capture(source, frame)
  backing.show(frame, { view: { x: 0, y: 0, zoom: 24 }, width: 800, height: 600 })
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('none')
  backing.dispose()
  dom.window.close()
})

test('overlay chrome follows a high-zoom center when the presented pasteboard cannot appear', () => {
  const live = { x: -129608, y: -32712, zoom: 24 }
  const presented = { x: 0, y: 0, zoom: 24 }
  const viewport = { width: 800, height: 600 }
  expect(referenceOverlayCamera({
    cpu: false, live, presented, scopeMatches: true, editPreview: false, viewport,
  })).toEqual(live)
  expect(referenceOverlayCamera({
    cpu: false, live: { x: 20, y: 10, zoom: 1 }, presented: { x: 0, y: 0, zoom: 1 },
    scopeMatches: true, editPreview: false, viewport,
  })).toEqual({ x: 0, y: 0, zoom: 1 })
})

function nestedCard() {
  const doc = blank()
  const frame = node('frame', 4697, 860, 1440, 1030)
  const group = node('group', 388, 162, 664, 707)
  const card = node('rectangle', 0, 0, 664, 707)
  card.fills = [{ ...card.fills[0], color: '#ffffff' }]
  const mark = node('rectangle', 292, 313, 80, 80)
  mark.fills = [{ ...mark.fills[0], color: '#3459d4' }]
  group.children = [card.id, mark.id]
  frame.children = [group.id]
  doc.nodes[frame.id] = frame
  doc.nodes[group.id] = group
  doc.nodes[card.id] = card
  doc.nodes[mark.id] = mark
  doc.pages[0].children = [frame.id]
  return { doc, group }
}

test('center selection at 2400% puts a nested group on the world camera, and that view paints the card', async () => {
  const { doc, group } = nestedCard()
  const editor = new Editor(doc)
  try {
    editor.select([group.id])
    editor.set({ view: { x: 0, y: 0, zoom: 24 } })
    const box = selectionCameraBox(editor)
    expect(box).toMatchObject({ x: 5085, y: 1022, width: 664, height: 707 })
    await dispatchEditorCommand(editor, 'center-selection')
    const view = editor.state.view
    expect(view.zoom).toBe(24)
    expect(view.x).toBeCloseTo(400 - (5085 + 332) * 24, 6)
    expect(view.y).toBeCloseTo(300 - (1022 + 353.5) * 24, 6)
    const engine = new VectorEngine()
    try {
      engine.load_document(JSON.stringify(doc))
      const paint = (zoom: number) => {
        const camera = {
          x: 32 - (5085 + 332) * zoom,
          y: 24 - (1022 + 353.5) * zoom,
          zoom,
        }
        const bytes = new Uint8Array(engine.render_rgba(JSON.stringify({
          pageId: doc.pages[0].id, width: 64, height: 48, transparent: false, grid: true,
          view: camera, rasterProfile: 'analytic',
        })))
        const i = (24 * 64 + 32) * 4
        return [bytes[i], bytes[i + 1], bytes[i + 2]]
      }
      for (const zoom of [1, 24, 32]) {
        const [r, g, b] = paint(zoom)
        expect(r).toBeLessThan(80)
        expect(b).toBeGreaterThan(180)
        expect(g).toBeGreaterThan(60)
        expect(g).toBeLessThan(120)
      }
    } finally { engine.free() }
  } finally { editor.dispose() }
})
