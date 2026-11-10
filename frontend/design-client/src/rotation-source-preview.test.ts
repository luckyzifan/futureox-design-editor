/** @vitest-environment jsdom */
import { expect, test } from 'vitest'
import { around, inverse, apply, boxPoints, rotate } from './geometry'
import { effect, node } from './model'
import { rotation_screenshot_admitted } from './generated/design-kernel/design_kernel'
import { mountRotationSource, rotationBackdropColor, rotationSourceCoversScreen, rotationSourcePlan } from './rotation-source-preview'

const view = { x: 0, y: 0, zoom: 1 }
const source = { x: -100, y: -100, width: 300, height: 300 }
const center = { x: 50, y: 50 }
const viewport = { x: 0, y: 0, width: 100, height: 100 }

function rect(color: string, opacity = 1) {
  const shape = node('rectangle', source.x, source.y, source.width, source.height)
  shape.fills[0].color = color
  shape.fills[0].opacity = opacity
  return shape
}

const base = {
  others: [] as const,
  center,
  degrees: 45,
  pageBackground: '#ffffff',
  parent: null,
  grid: false,
  checkerboard: false,
  pixelPreview: false,
}

test('opacity 1 with an 8-digit color is not opaque and is not a screenshot', () => {
  const shape = rect('#ff000080')
  expect(rotationSourcePlan({ ...base, node: shape, world: shape.transform })).toBeNull()
  expect(rotation_screenshot_admitted(
    '#ff000080', 1,
    source.x, source.y, source.width, source.height,
    source.x, source.y, source.width, source.height,
    center.x, center.y, 45,
    viewport.x, viewport.y, viewport.width, viewport.height,
  )).toBe(false)
  expect(rotationBackdropColor('#ffffff80', null)).toBeNull()
})

test('a viewport slice cannot supply the pixel that rotates onto screen (3, 3)', () => {
  const shape = rect('#ff0000')
  const plan = rotationSourcePlan({ ...base, node: shape, world: shape.transform })
  expect(plan?.box).toEqual(source)
  expect(plan && 'crop' in plan).toBe(false)
  const visible = { x: 0, y: 0, width: 100, height: 100 }
  expect(rotation_screenshot_admitted(
    '#ff0000', 1,
    source.x, source.y, source.width, source.height,
    visible.x, visible.y, visible.width, visible.height,
    center.x, center.y, 45,
    viewport.x, viewport.y, viewport.width, viewport.height,
  )).toBe(false)
  const delta = around(center, rotate(45))
  const preimage = apply(inverse(delta), { x: 3, y: 3 })
  expect(preimage.x).toBeGreaterThanOrEqual(source.x)
  expect(preimage.x).toBeLessThanOrEqual(source.x + source.width)
  expect(preimage.y).toBeGreaterThanOrEqual(source.y)
  expect(preimage.y).toBeLessThanOrEqual(source.y + source.height)
  expect(preimage.x < visible.x || preimage.x > visible.x + visible.width || preimage.y < visible.y || preimage.y > visible.y + visible.height).toBe(true)
  expect(rotationSourceCoversScreen(source, view, delta, { x: 3, y: 3 })).toBe(true)

  const host = document.createElement('div')
  document.body.append(host)
  const layer = mountRotationSource(host, {
    plan: plan!, view, viewport: { width: 100, height: 100 },
    corners: boxPoints(source), drawSelection: true, ids: [shape.id],
  })
  expect(layer).not.toBeNull()
  expect(host.querySelector('canvas')).toBeNull()
  const paint = host.querySelector('[data-testid="rotation-source-paint"]') as HTMLElement
  expect(paint.dataset.sourceBox).toBe('-100,-100,300,300')
  expect(paint.style.width).toBe('300px')
  expect(paint.style.height).toBe('300px')
  layer!.place(delta, { x: 3, y: 3 }, 45)
  expect(paint.style.background).toMatch(/#ff0000|rgb\(255,\s*0,\s*0\)/)
  const numbers = paint.style.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number)
  expect(numbers).toHaveLength(6)
  const [a, b, c, d, e, f] = numbers!
  const left = Number.parseFloat(paint.style.left)
  const top = Number.parseFloat(paint.style.top)
  const mapped = boxPoints({ x: 0, y: 0, width: 300, height: 300 }).map(corner => ({
    x: left + a * corner.x + c * corner.y + e,
    y: top + b * corner.x + d * corner.y + f,
  }))
  let winding = 0
  for (let index = 0; index < mapped.length; index++) {
    const start = mapped[index], end = mapped[(index + 1) % mapped.length]
    const cross = (end.x - start.x) * (3 - start.y) - (end.y - start.y) * (3 - start.x)
    if (start.y <= 3 && end.y > 3 && cross > 0) winding += 1
    else if (start.y > 3 && end.y <= 3 && cross < 0) winding -= 1
  }
  expect(winding).not.toBe(0)
  expect(host.querySelector('[data-testid="rotation-feedback"]')?.textContent).toBe('45.00°')
  layer!.destroy()
  expect(host.querySelector('[data-testid="rotation-source-preview"]')).toBeNull()
})

test('an opaque image is redrawn from its full rectangle, not a cropped screenshot', () => {
  const shape = rect('#ffffff')
  shape.fills[0].kind = 'image'
  shape.fills[0].image = 'data:image/png;base64,AAAA'
  const plan = rotationSourcePlan({ ...base, node: shape, world: shape.transform })
  expect(plan?.paint).toEqual({ kind: 'image', src: 'data:image/png;base64,AAAA', fit: 'cover' })
  expect(plan?.box).toEqual(source)
  expect(rotation_screenshot_admitted(
    '#ffffff', 1,
    source.x, source.y, source.width, source.height,
    0, 0, 100, 100,
    center.x, center.y, 45,
    0, 0, 100, 100,
  )).toBe(false)
})

test('background blur is not redrawn as a flat color', () => {
  const shape = rect('#ff0000')
  shape.effects = [effect('background-blur')]
  expect(rotationSourcePlan({ ...base, node: shape, world: shape.transform })).toBeNull()
})

test('a neighbor under the rotated footprint blocks the source redraw', () => {
  const shape = rect('#ff0000')
  expect(rotationSourcePlan({
    ...base, node: shape, world: shape.transform, others: [{ x: 40, y: 40, width: 20, height: 20 }],
  })).toBeNull()
})
