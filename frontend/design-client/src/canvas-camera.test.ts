import { expect, test } from 'vitest'
import React, { Children, isValidElement, type ReactNode } from 'react'
import type { Point } from './model'
import { blank } from './model'
import { Editor } from './engine'
import { ViewControls } from './ViewControls'
import {
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_MAX,
  fitBounds,
  revealInView,
  screenToWorld,
  wheelDeltaPixels,
  wheelCamera,
  isNativePinch,
  worldToScreen,
  zoomAt,
} from './canvas-camera'

const zooms = [CANVAS_ZOOM_MIN, 0.125, 0.75, 1, 4, 13.7, CANVAS_ZOOM_MAX]
test('wheel zoom holds an off-centre pointer across a coalesced stream and leaves world geometry alone', () => {
  const size = { width: 1440, height: 900 }, anchor = { x: 197, y: 733 }
  let view = { x: -125.4, y: 30.2, zoom: .27 }
  const original = screenToWorld(view, anchor)
  for (let i = 0; i < 80; i++) {
    view = wheelCamera(view, { deltaX: 0, deltaY: -8, deltaMode: 0 }, size, anchor, true)
    closePoint(worldToScreen(view, original), anchor)
  }
  const panned = wheelCamera(view, { deltaX: 0, deltaY: 20, deltaMode: 0, shiftKey: true }, size, anchor)
  expect(panned).toEqual({ ...view, x: view.x - 20 })
  expect(wheelCamera(view, { deltaX: 12, deltaY: 20, deltaMode: 0 }, size, anchor, false)).toEqual({ ...view, x: view.x - 12, y: view.y - 20 })
  const pinched = wheelCamera(view, { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true }, size, anchor, false)
  expect(pinched.zoom).toBeGreaterThan(view.zoom); closePoint(worldToScreen(pinched, original), anchor)
})

test('a new empty design starts at one CSS pixel per design unit', () => {
  const editor = new Editor(blank())
  try { expect(editor.state.view.zoom).toBe(1) } finally { editor.dispose() }
})
test('native wheel prototype accessors are read even when none are enumerable', () => {
  const event = Object.create({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false })
  expect(Object.keys(event)).toHaveLength(0)
  const before = { x: 20, y: 30, zoom: .5 }, anchor = { x: 100, y: 150 }
  const after = wheelCamera(before, event, { width: 800, height: 600 }, anchor, true)
  expect(after.zoom).toBeGreaterThan(before.zoom)
  closePoint(worldToScreen(after, screenToWorld(before, anchor)), anchor)
})
function closePoint(actual: Point, expected: Point, tolerance = 1e-7) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance)
}
test('default wheel/trackpad pans both axes; modified zoom is continuous and cursor anchored', () => {
  const view = { x: 80, y: -120, zoom: .5 }, size = { width: 900, height: 600 }, anchor = { x: 140, y: 370 }
  expect(wheelCamera(view, {deltaX:12.5,deltaY:-24.25,deltaMode:0},size,anchor)).toEqual({x:67.5,y:-95.75,zoom:.5})
  const next = wheelCamera(view, {deltaX:0,deltaY:-120,deltaMode:0,metaKey:true},size,anchor)
  expect(next.zoom/view.zoom).toBeGreaterThan(1.4)
  expect(next.zoom/view.zoom).toBeLessThan(1.5)
  closePoint(screenToWorld(next,anchor), screenToWorld(view,anchor))
  const editor = new Editor(blank())
  try { expect(editor.state.scrollWheelZoom).toBe(false) } finally { editor.dispose() }
})

test('native Chromium pinch restores its real scale instead of the mouse-wheel gain', () => {
  const size = { width: 1440, height: 900 }, anchor = { x: 317.25, y: 442.5 }
  const view = { x: -250, y: 13.25, zoom: .5 }
  for (const factor of [.5, .8, 1.1, 2]) {
    const event = { deltaX: 0, deltaY: -100 * Math.log(factor), deltaMode: 0, ctrlKey: true }
    const next = wheelCamera(view, event, size, anchor, false, true)
    expect(next.zoom).toBeCloseTo(view.zoom * factor, 12)
    closePoint(screenToWorld(next, anchor), screenToWorld(view, anchor))
  }
  const wheel = wheelCamera(view, { deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: true }, size, anchor, false, false)
  expect(wheel.zoom / view.zoom).toBeGreaterThan(1.4)
  expect(wheel.zoom / view.zoom).toBeLessThan(1.5)
})

test('switching between Ctrl/Meta wheel and native pinch does not share their zoom gain', () => {
  const size = { width: 1200, height: 800 }, anchor = { x: 377.25, y: 291.5 }
  const event = Object.create({ deltaX: 0, deltaY: -100 * Math.log(2), deltaMode: 0, ctrlKey: true, metaKey: false })
  const heldCtrl = { ctrl: true, meta: false }, released = { ctrl: false, meta: false }
  expect(isNativePinch(event, heldCtrl)).toBe(false)
  expect(isNativePinch(event, released)).toBe(true)
  expect(isNativePinch({ ...event, ctrlKey: false, metaKey: true, deltaMode: 0, deltaX: 0 }, { ctrl: false, meta: true })).toBe(false)
  expect(isNativePinch({ ctrlKey: true, deltaMode: 1, deltaX: 0 }, released)).toBe(false)
  const original = { x: -41, y: 57, zoom: .5 }
  let view = wheelCamera(original, event, size, anchor, false, isNativePinch(event, heldCtrl))
  const wheelFactor = view.zoom / original.zoom
  expect(wheelFactor).toBeCloseTo(2 ** .3, 12)
  view = wheelCamera(view, event, size, anchor, false, isNativePinch(event, released))
  expect(view.zoom / original.zoom).toBeCloseTo(wheelFactor * 2, 12)
  closePoint(screenToWorld(view, anchor), screenToWorld(original, anchor))
})

test('fine wheel samples retain the same total zoom as one coarse sample at the same pointer', () => {
  const original = { x: 20, y: -30, zoom: .75 }, size = { width: 1440, height: 900 }, anchor = { x: 530, y: 240 }
  const coarse = wheelCamera(original, { deltaX: 0, deltaY: -120, deltaMode: 0, metaKey: true }, size, anchor)
  let fine = original
  for (let i = 0; i < 120; i++) fine = wheelCamera(fine, { deltaX: 0, deltaY: -1, deltaMode: 0, metaKey: true }, size, anchor)
  expect(fine.zoom).toBeCloseTo(coarse.zoom, 12)
  closePoint(screenToWorld(fine, anchor), screenToWorld(original, anchor))
})

test('camera limits retain Core’s current range pending Figma UI verification', () => {
  expect(CANVAS_ZOOM_MIN).toBe(0.025)
  expect(CANVAS_ZOOM_MAX).toBe(32)
})

test('CSS screen/world coordinates round trip across the range at large signed positions', () => {
  for (const zoom of zooms) {
    for (const x of [-1e7, -123.375, 0, 321.125, 1e7]) {
      const point = { x, y: -x + 0.375 }
      const view = { x: 483.125 - x * zoom, y: 277.625 + x * zoom, zoom }
      closePoint(screenToWorld(view, worldToScreen(view, point)), point)
      for (const screen of [
        { x: 0, y: 0 },
        { x: 483.125, y: 277.625 },
        { x: 1280, y: 960 },
      ])
        closePoint(worldToScreen(view, screenToWorld(view, screen)), screen)
    }
  }
})

test('every zoom pair preserves cursor and viewport-center anchors at +/-1e7 world coordinates', () => {
  for (const oldZoom of zooms) {
    for (const targetZoom of zooms) {
      for (const sign of [-1, 1]) {
        for (const anchor of [
          { x: 321.125, y: 199.625 },
          { x: 640, y: 480 },
        ]) {
          const point = { x: sign * 1e7 + 0.125, y: -sign * 1e7 + 0.625 }
          const view = {
            x: anchor.x - point.x * oldZoom,
            y: anchor.y - point.y * oldZoom,
            zoom: oldZoom,
          }
          const next = zoomAt(view, targetZoom, anchor)
          closePoint(screenToWorld(next, anchor), point)
          closePoint(worldToScreen(next, point), anchor)
          expect(next.zoom).toBe(targetZoom)
        }
      }
    }
  }
})

test('clamping extreme requests preserves the anchor and repeated limit events are exact no-ops', () => {
  const anchor = { x: 487.3, y: 319.7 }
  const initial = { x: -1e7 + 0.1, y: 1e7 + 0.3, zoom: 0.7 }
  const point = screenToWorld(initial, anchor)
  for (const target of [-Infinity, -1, 0, 1e9, Infinity]) {
    const next = zoomAt(initial, target, anchor)
    expect(next.zoom).toBe(target <= 0 ? CANVAS_ZOOM_MIN : CANVAS_ZOOM_MAX)
    closePoint(worldToScreen(next, point), anchor)
    let repeated = next
    for (let i = 0; i < 10_000; i++) repeated = zoomAt(repeated, target, anchor)
    expect(repeated).toEqual(next)
  }
  expect(zoomAt(initial, initial.zoom, anchor)).toEqual(initial)
  expect(zoomAt(initial, NaN, anchor)).toEqual(initial)
})

test('10000 repeated zoom cycles retain the anchor and do not accumulate visible camera drift', () => {
  for (const sign of [-1, 1]) {
    const anchor = { x: 347.125, y: 217.625 }
    const initial = { x: sign * 1e7 + 0.125, y: -sign * 1e7 + 0.625, zoom: 0.75 }
    const point = screenToWorld(initial, anchor)
    let view = initial
    for (let cycle = 0; cycle < 10_000; cycle++) {
      for (const zoom of [CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX, 0.125, 8, initial.zoom])
        view = zoomAt(view, zoom, anchor)
    }
    closePoint(view, initial, 1e-6)
    closePoint(worldToScreen(view, point), anchor, 1e-6)
    expect(view.zoom).toBe(initial.zoom)
  }
})

test('fit centers large signed bounds and keeps all corners within the requested CSS padding', () => {
  const size = { width: 1280, height: 960 }
  for (const sign of [-1, 1]) {
    for (const shape of [
      { width: 720, height: 240 },
      { width: 240, height: 720 },
    ]) {
      const bounds = { x: sign * 1e7, y: -sign * 1e7, ...shape }
      const view = fitBounds(bounds, size)
      closePoint(
        worldToScreen(view, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
        { x: size.width / 2, y: size.height / 2 },
      )
      const topLeft = worldToScreen(view, bounds)
      const bottomRight = worldToScreen(view, {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
      })
      expect(topLeft.x).toBeGreaterThanOrEqual(40 - 1e-7)
      expect(topLeft.y).toBeGreaterThanOrEqual(40 - 1e-7)
      expect(bottomRight.x).toBeLessThanOrEqual(size.width - 40 + 1e-7)
      expect(bottomRight.y).toBeLessThanOrEqual(size.height - 40 + 1e-7)
    }
  }
})

test('fit retains the editor range for tiny, huge, degenerate and temporarily hidden viewports', () => {
  const size = { width: 1280, height: 960 }
  expect(fitBounds({ x: 100, y: 200, width: 1, height: 1 }, size).zoom).toBe(CANVAS_ZOOM_MAX)
  const huge = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 }
  const view = fitBounds(huge, size)
  expect(view.zoom).toBe(CANVAS_ZOOM_MIN)
  // A minimum zoom can prevent full containment, but the content stays centered.
  closePoint(worldToScreen(view, { x: 0, y: 0 }), { x: 640, y: 480 })
  for (const bounds of [
    { x: 10, y: -20, width: 0, height: 0 },
    { x: 10, y: -20, width: 0, height: 200 },
  ]) {
    for (const viewport of [size, { width: 0, height: 0 }]) {
      const fitted = fitBounds(bounds, viewport)
      expect(Object.values(fitted).every(Number.isFinite)).toBe(true)
      closePoint(
        worldToScreen(fitted, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
        { x: viewport.width / 2, y: viewport.height / 2 },
      )
    }
  }
})

test('animation fit retains its 24px padding and existing 4x preview ceiling', () => {
  const size = { width: 600, height: 400 }
  const bounds = { x: -100, y: 200, width: 50, height: 40 }
  const view = fitBounds(bounds, size, { padding: 24, maxZoom: 4 })
  expect(view.zoom).toBe(4)
  closePoint(worldToScreen(view, { x: -75, y: 220 }), { x: 300, y: 200 })
  expect(fitBounds({ ...bounds, height: 400 }, size, { padding: 24, maxZoom: 4 }).zoom).toBe(0.88)
})

test('wheel pixel, line and page deltas normalize to viewport-local CSS pixels', () => {
  const size = { width: 1200, height: 800 }
  expect(wheelDeltaPixels({ deltaX: 1.5, deltaY: -2.25, deltaMode: 0 }, size)).toEqual({
    x: 1.5,
    y: -2.25,
  })
  expect(wheelDeltaPixels({ deltaX: 1.5, deltaY: -2.25, deltaMode: 1 }, size)).toEqual({
    x: 24,
    y: -36,
  })
  expect(wheelDeltaPixels({ deltaX: 0.5, deltaY: -0.25, deltaMode: 2 }, size)).toEqual({
    x: 600,
    y: -200,
  })
})

test('equivalent wheel modes produce the same anchored zoom for mouse and trackpad input', () => {
  const size = { width: 1200, height: 800 }
  const anchor = { x: 317.125, y: 433.625 }
  const view = { x: -1e7, y: 1e7, zoom: 1.25 }
  const point = screenToWorld(view, anchor)
  const results = [
    { deltaX: 0, deltaY: 16, deltaMode: 0 },
    { deltaX: 0, deltaY: 1, deltaMode: 1 },
    { deltaX: 0, deltaY: 0.02, deltaMode: 2 },
  ].map((event) =>
    wheelCamera(view, event, size, anchor, true),
  )
  expect(results[1]).toEqual(results[0])
  expect(results[2]).toEqual(results[0])
  closePoint(worldToScreen(results[0], point), anchor)
})

test('repeated control clicks use the latest camera before a React rerender without changing the document', () => {
  const editor = new Editor(blank())
  const initial = { x: -1e7 + 0.125, y: 1e7 + 0.625, zoom: 1 }
  editor.set({ view: initial })
  const document = editor.state.doc
  const size = { width: 1280, height: 960 }
  const anchor = { x: size.width / 2, y: size.height / 2 }
  const point = screenToWorld(initial, anchor)
  // Capture handlers from one render: repeated clicks must read the latest camera,
  // even before React has rendered a second time. Effects are covered in the GUI suite.
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const old = internals.H
  let controls: ReturnType<typeof ViewControls>
  internals.H = { useRef: (current: unknown) => ({ current }), useEffect() {} }
  try { controls = ViewControls({ editor, size, fit: () => {} }) } finally { internals.H = old }
  const button = (title: string) => {
    const find = (children: ReactNode): (() => void) | undefined => {
      for (const child of Children.toArray(children)) {
        if (!isValidElement<{ title?: string; onClick?: () => void; children?: ReactNode }>(child)) continue
        if (child.type === 'button' && child.props.title === title && child.props.onClick)
          return child.props.onClick
        const nested = find(child.props.children)
        if (nested) return nested
      }
    }
    const handler = find(controls.props.children)
    if (handler) return handler
    throw new Error(`Missing zoom button: ${title}`)
  }
  const zoomIn = button('放大')
  const zoomOut = button('缩小')
  for (let i = 0; i < 3; i++) zoomIn()
  expect(editor.state.view.zoom).toBe(2 ** 3)
  closePoint(worldToScreen(editor.state.view, point), anchor)
  for (let i = 0; i < 3; i++) zoomOut()
  expect(editor.state.view.zoom).toBe(initial.zoom)
  closePoint(editor.state.view, initial)
  expect(editor.state.doc).toBe(document)
})


test('Shift wheel maps an unmodified vertical wheel to X without remapping native horizontal or diagonal input', () => {
  const size = { width: 800, height: 600 }
  expect(wheelDeltaPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: true }, size)).toEqual({ x: 48, y: 0 })
  expect(wheelDeltaPixels({ deltaX: -24, deltaY: 0, deltaMode: 0, shiftKey: true }, size)).toEqual({ x: -24, y: 0 })
  expect(wheelDeltaPixels({ deltaX: 8.125, deltaY: -13.75, deltaMode: 0, shiftKey: true }, size)).toEqual({ x: 8.125, y: -13.75 })
})

test('camera-only updates retain panel snapshots while mutations and hover publish new snapshots', () => {
  const editor = new Editor(blank()), initial = editor.panelSnapshot(), document = editor.state.doc
  for (let i = 0; i < 100; i++) editor.set({ view: { x: i / 3, y: -i / 7, zoom: 1 + i / 100 } })
  expect(editor.panelSnapshot()).toBe(initial)
  expect('view' in initial).toBe(false)
  expect(editor.state.doc).toBe(document)
  expect(editor.canUndo).toBe(false)
  editor.notify('Changed'); expect(editor.panelSnapshot()).not.toBe(initial)
  expect(initial.message).not.toBe('Changed')
  const named = editor.panelSnapshot(); editor.set({ hover: 'target', hoverSource: 'canvas' })
  expect(editor.panelSnapshot()).not.toBe(named)
  expect(named.hover).toBe(null)
  editor.dispose()
})

test('revealInView keeps visible selections perfectly still and pans minimally otherwise', () => {
  const size = { width: 1000, height: 800 }
  const view = { x: 0, y: 0, zoom: 1 }
  // Fully inside the 48px margin: a click on a visible layer must not move a pixel.
  expect(revealInView(view, { x: 200, y: 200, width: 100, height: 80 }, size)).toBe(null)
  // Off the left edge: minimal pan brings it just inside the margin.
  const left = revealInView(view, { x: -300, y: 200, width: 100, height: 80 }, size)!
  expect(left).not.toBe(null)
  expect(left.zoom).toBe(1)
  expect(left.x).toBe(48 - (-300))
  expect(left.y).toBe(view.y)
  // Off the bottom: only the y axis moves.
  const bottom = revealInView(view, { x: 200, y: 900, width: 100, height: 80 }, size)!
  expect(bottom.x).toBe(view.x)
  expect(bottom.y).toBe(800 - 48 - (900 + 80))
  // Zoom is never changed, including fractional cameras.
  const zoomed = { x: 12.5, y: -7.25, zoom: 0.75 }
  const target = { x: -410, y: 358, width: 1922, height: 1080 }
  const panned = revealInView(zoomed, target, size)!
  expect(panned.zoom).toBe(zoomed.zoom)
  // The revealed bounds are inside the resulting viewport on both axes.
  expect(revealInView(panned, target, size)).toBe(null)
  // A selection larger than the viewport centres instead of hugging an edge.
  const huge = { x: -5000, y: -5000, width: 20000, height: 20000 }
  const centred = revealInView(view, huge, size)!
  expect(centred.x).toBe(size.width / 2 - (huge.x + huge.width / 2))
  expect(centred.y).toBe(size.height / 2 - (huge.y + huge.height / 2))
})

test('requestReveal publishes a discrete signal the canvas can consume and filters unknown ids', () => {
  const editor = new Editor()
  const seen: (string[] | null)[] = []
  const unsubscribe = editor.subscribeReveal(() => seen.push(editor.revealSnapshot()?.ids ?? null))
  editor.requestReveal([])
  editor.requestReveal(['missing'])
  expect(seen).toEqual([])
  const node = editor.state.doc.pages[0].children[0]
  editor.requestReveal([node, node])
  expect(seen).toEqual([[node]])
  expect('view' in editor.panelSnapshot()).toBe(false)
  unsubscribe()
  editor.requestReveal([node])
  expect(seen).toHaveLength(1)
  editor.dispose()
})
