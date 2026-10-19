import test from 'node:test'
import assert from 'node:assert/strict'
import { retainedCaptureGeometry, captureBoardFrame } from './retained-board-capture.ts'

const box = { x: 22.125, y: 18.375, width: 103.25, height: 87.625 }
const view = { x: 10.375, y: 12.625, zoom: 1.25 }

for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3]) {
  test(`retained drag capture preserves one axis-independent density at DPR ${dpr}`, () => {
    const g = retainedCaptureGeometry(780.51, 631.375, box, view, dpr)
    assert.ok(g)
    assert.equal(g.pixelRatio, dpr)
    assert.equal(g.devicePixelRatio, dpr)
    for (const [pixels, css] of [[g.pixelWidth, g.width], [g.pixelHeight, g.height],
      [g.pixelCrop.width, g.crop.width], [g.pixelCrop.height, g.crop.height]]) {
      assert.ok(Math.abs(pixels / css - dpr) < 1e-12)
      for (const point of [0, 0.125, css * 0.37, css - 0.1])
        assert.ok(Math.abs(point * dpr / pixels * css - point) < 1e-10)
    }
    for (const coordinate of Object.values(g.pixelCrop)) assert.ok(Number.isInteger(coordinate))
    assert.equal(g.crop.x * dpr, g.pixelCrop.x)
    assert.equal(g.crop.y * dpr, g.pixelCrop.y)
    assert.ok(g.crop.x <= box.x * view.zoom + view.x - 2)
    assert.ok(g.crop.y <= box.y * view.zoom + view.y - 2)
    assert.ok(g.crop.x + g.crop.width >= (box.x + box.width) * view.zoom + view.x + 2)
    assert.ok(g.crop.y + g.crop.height >= (box.y + box.height) * view.zoom + view.y + 2)
  })
}

test('fractional-layout capture no longer shrinks by a different amount on each axis', () => {
  const width = 780.51, height = 631.375
  assert.ok(Math.abs(780 / Math.ceil(width) * width - 780) > 0.48)
  assert.notEqual(width / Math.ceil(width), height / Math.ceil(height))
  const g = retainedCaptureGeometry(width, height, box, view, 1)
  assert.equal(g.width, g.pixelWidth)
  assert.equal(g.height, g.pixelHeight)
})

test('full-DPR over-budget or clipped captures decline instead of downsampling', () => {
  assert.ok(retainedCaptureGeometry(1800, 1200, box, view, 1))
  assert.equal(retainedCaptureGeometry(1800, 1200, box, view, 3), null)
  assert.equal(retainedCaptureGeometry(2048.0001, 4095.999, box, view, 1), null,
    'the rounded backing allocation, not the smaller CSS product, owns the budget')
  assert.equal(retainedCaptureGeometry(100, 100, box, view, 1.25), null)
  for (const dpr of [0, -1, NaN, Infinity])
    assert.equal(retainedCaptureGeometry(800, 600, box, view, dpr), null)
})

test('capture copies the foreground crop 1:1 at integer physical coordinates', t => {
  // CPU-only canvas-boundary contract. These record calls and allocate no real
  // canvas/GPU; they do not claim to validate browser compositing or pixels.
  const globals = Object.fromEntries(['window', 'document', 'getComputedStyle'].map(name => [name,
    Object.getOwnPropertyDescriptor(globalThis, name)]))
  t.after(() => {
    for (const [name, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const calls = [], created = [], dpr = 1.25
  const geometry = retainedCaptureGeometry(780.51, 631.375, box, view, dpr)
  const source = { width: geometry.pixelWidth, height: geometry.pixelHeight,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 20, y: 30, width: geometry.width, height: geometry.height }) }
  const host = { dataset: {},
    getBoundingClientRect: () => ({ x: 20, y: 30, width: 780.51, height: 631.375 }),
    querySelector: () => ({ querySelectorAll: () => [source] }) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: dpr } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => {
    const id = created.length
    const canvas = { getContext: () => Object.fromEntries(['drawImage', 'clearRect', 'scale'].map(name => [name,
      (...args) => calls.push({ id, name, args })])) }
    created.push(canvas)
    return canvas
  } } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true,
    value: () => ({ visibility: 'visible', display: 'block', zIndex: '0' }) })
  const captured = captureBoardFrame(host, box, view)
  assert.ok(captured)
  assert.equal(captured.width * dpr, captured.background.width)
  assert.equal(captured.height * dpr, captured.background.height)
  assert.equal(captured.crop.width * dpr, captured.foreground.width)
  assert.equal(captured.crop.height * dpr, captured.foreground.height)
  const copy = calls.find(call => call.id === 1 && call.name === 'drawImage')
  const p = geometry.pixelCrop
  assert.deepEqual(copy.args, [captured.background, p.x, p.y, p.width, p.height, 0, 0, p.width, p.height])
  assert.ok(copy.args.slice(1).every(Number.isInteger))
  assert.equal(host.dataset.boardCapture, 'captured')
})
