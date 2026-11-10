// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { scheduleCanvasView } from './canvas-view-schedule'
import { CameraReprojection } from './kernel/camera-reprojection'
import { Editor } from './engine'
import { blank } from './model'
import type { CanvasCamera } from './canvas-camera'

const worlds: JSDOM[] = []
afterEach(() => {
  worlds.splice(0).forEach(dom => dom.window.close())
  vi.unstubAllGlobals()
})

function harness() {
  const dom = new JSDOM('<div><canvas></canvas></div>', { url: 'http://localhost/' })
  worlds.push(dom)
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++sequence, fn)
    return sequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const editor = new Editor(blank())
  editor.set({ view: { x: 0, y: 0, zoom: 1 } })
  const host = document.querySelector('div')!
  const canvas = document.querySelector('canvas')!
  const projection = new CameraReprojection(canvas, host)
  const backing = {
    presentationId: 'accepted', view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 80, dpr: 2, interaction: false, ids: [1],
  }
  const bounds = { x: 0, y: 0, width: 400, height: 400 }
  projection.update(backing, backing.view, 100, 80, true, bounds)
  return { editor, canvas, projection, backing, bounds, frames }
}

function slide(projection: CameraReprojection, backing: { view: CanvasCamera; width: number; height: number }, bounds: { x: number; y: number; width: number; height: number }, cameras: readonly CanvasCamera[]) {
  for (const camera of cameras) projection.update(backing as never, camera, 100, 80, true, bounds)
}

test('folding a pan into a parked shrink leaves the retained picture fixed', () => {
  const { editor, canvas, projection, backing, bounds } = harness()
  const shrunk = { x: 25, y: 20, zoom: 0.5 }
  const panned = { x: 85, y: 20, zoom: 0.5 }
  const seen: CanvasCamera[] = []
  editor.subscribe(() => seen.push({ ...editor.state.view }))
  editor.setViewCoalesced(shrunk)
  editor.setViewCoalesced(panned)
  editor.flushPendingView()
  expect(seen).toEqual([panned])
  slide(projection, backing, bounds, [panned])
  expect(canvas.style.transform).toBe('')
  editor.dispose()
})

test('a parked shrink is published before the immediate pan and the retained picture slides', () => {
  const { editor, canvas, projection, backing, bounds } = harness()
  const shrunk = { x: 25, y: 20, zoom: 0.5 }
  const panned = { x: 85, y: 20, zoom: 0.5 }
  const published: CanvasCamera[] = []
  scheduleCanvasView(editor, shrunk, run => run())
  expect(editor.cameraCommitPending()).toBe(true)
  expect(editor.state.view).toEqual({ x: 0, y: 0, zoom: 1 })
  scheduleCanvasView(editor, panned, run => {
    run()
    published.push({ ...editor.state.view })
  })
  expect(published).toEqual([shrunk, panned])
  expect(editor.state.view).toEqual(panned)
  slide(projection, backing, bounds, published)
  expect(canvas.style.transform).toBe('translate(60px, 0px) scale(1)')
  expect(JSON.parse(canvas.dataset.projectedCamera!)).toEqual({ x: 60, y: 0, zoom: 1 })
  editor.dispose()
})

test('a zoom-only burst stays parked and a pan at the committed zoom is not split', () => {
  const parked = harness()
  const flush = vi.fn((run: () => void) => run())
  scheduleCanvasView(parked.editor, { x: 10, y: 0, zoom: 0.5 }, flush)
  scheduleCanvasView(parked.editor, { x: 12, y: 4, zoom: 0.25 }, flush)
  expect(flush).not.toHaveBeenCalled()
  expect(parked.editor.state.view.zoom).toBe(1)
  expect(parked.editor.effectiveView()).toEqual({ x: 12, y: 4, zoom: 0.25 })
  parked.editor.dispose()
  const committed = harness()
  scheduleCanvasView(committed.editor, { x: 40, y: 4, zoom: 1 }, flush)
  expect(flush).not.toHaveBeenCalled()
  expect(committed.editor.state.view).toEqual({ x: 40, y: 4, zoom: 1 })
  committed.editor.dispose()
})
