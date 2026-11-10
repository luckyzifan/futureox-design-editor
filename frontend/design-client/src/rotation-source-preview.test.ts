/** @vitest-environment jsdom */
import { expect, test } from 'vitest'
import { around, inverse, apply, boxPoints, rotate } from './geometry'
import { effect, node } from './model'
import { rotation_screenshot_admitted } from './generated/design-kernel/design_kernel'
import { mountRotationSource, rotationBackdropColor, rotationImageAddress, rotationSourceCoversScreen, rotationSourcePlan, type RotationSourcePlan } from './rotation-source-preview'

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
  documentSpace: 'srgb' as const,
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

test('clearing the original footprint cannot erase another layer', () => {
  const shape = node('rectangle', 0, 0, 100, 10)
  expect(rotationSourcePlan({ ...base, node: shape, world: shape.transform,
    center: { x: 50, y: 5 }, degrees: 90,
    others: [{ x: 0, y: 0, width: 10, height: 10 }],
  })).toBeNull()
})

test('ancestor composition and non-sRGB colors stay on the renderer path', () => {
  const shape = rect('#ff0000')
  const parent = node('frame', -100, -100, 300, 300)
  parent.opacity = 0.5
  expect(rotationSourcePlan({ ...base, node: shape, world: shape.transform, parent })).toBeNull()
  expect(rotationSourcePlan({
    ...base, node: shape, world: shape.transform, parent,
    ancestors: [{ node: parent, matrix: parent.transform }],
  })).toBeNull()
  expect(rotationBackdropColor('#ffffff', parent)).toBeNull()
  expect(rotationSourcePlan({ ...base, node: shape, world: shape.transform, documentSpace: 'display-p3' })).toBeNull()
})

/** Color the preview would stamp at a world point. A single `hole` string is
 * the rejected #241 shape: that color covers the whole footprint unless a
 * clip cuts it. */
function backdropAt(plan: (Pick<RotationSourcePlan, 'box' | 'holes'> & { hole?: string; clip?: RotationSourcePlan['clip'] }) | null, x: number, y: number): string | null {
  if (!plan) return null
  const contains = (box: { x: number; y: number; width: number; height: number }) =>
    x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height
  if (plan.holes?.length) {
    let color: string | null = null
    for (const hole of plan.holes) if (contains(hole.box)) color = hole.color
    return color
  }
  const footprint = plan.clip ? {
    x: Math.max(plan.box.x, plan.clip.x),
    y: Math.max(plan.box.y, plan.clip.y),
    width: Math.min(plan.box.x + plan.box.width, plan.clip.x + plan.clip.width) - Math.max(plan.box.x, plan.clip.x),
    height: Math.min(plan.box.y + plan.box.height, plan.clip.y + plan.clip.height) - Math.max(plan.box.y, plan.clip.y),
  } : plan.box
  if (footprint.width > 0 && footprint.height > 0 && contains(footprint)) return plan.hole ?? null
  return null
}

function counterexampleScene(clip: boolean) {
  const parent = node('frame', 0, 0, 100, 100)
  parent.clip = clip
  parent.fills[0].color = '#00ff00'
  const shape = node('rectangle', 80, 40, 80, 40)
  shape.fills[0].color = '#ff0000'
  parent.children = [shape.id]
  const world = shape.transform
  return { parent, shape, world }
}

test('a protruding child over a non-clipping parent does not paint the outside page with the parent fill', () => {
  // Maintainer counterexample, 2026-11-10, against PR #241. 100×100 green
  // parent, clip=false. Red child at (80,40) size 80×40. Rotate 90° around
  // (120,60). (155,45) was inside the child and, after the turn, is outside
  // the shape and outside the parent, so the page stays white. #241 returned
  // hole=#00ff00 and no clip.
  const { parent, shape, world } = counterexampleScene(false)
  const center = { x: 120, y: 60 }
  const plan = rotationSourcePlan({
    ...base, node: shape, world, parent, degrees: 90, center,
    pageBackground: '#ffffff',
    ancestors: [{ node: parent, matrix: parent.transform }],
    nodes: { [parent.id]: parent, [shape.id]: shape },
  })
  expect(plan).not.toBeNull()
  expect(plan!.clip).toBeUndefined()
  expect(plan!.paint).toEqual({ kind: 'solid', color: '#ff0000' })
  expect(backdropAt(plan, 90.5, 50.5)).toBe('#00ff00')
  expect(backdropAt(plan, 155.5, 45.5)).toBe('#ffffff')
  expect(backdropAt({ box: plan!.box, holes: [], hole: '#00ff00' }, 155.5, 45.5)).toBe('#00ff00')
  const host = document.createElement('div')
  document.body.append(host)
  const layer = mountRotationSource(host, {
    plan: plan!, view, viewport: { width: 220, height: 120 },
    corners: boxPoints(plan!.box), drawSelection: false, ids: [shape.id],
  })
  expect(host.querySelector('canvas')).toBeNull()
  const delta = around(center, rotate(90))
  layer!.place(delta, { x: 155, y: 45 }, 90)
  expect(domHoleColor(host, 155.5, 45.5)).toBe('#ffffff')
  expect(domHoleColor(host, 90.5, 50.5)).toBe('#00ff00')
  expect(paintCovers(host, 155.5, 45.5)).toBe(false)
  expect(paintCovers(host, 90.5, 50.5)).toBe(false)
  expect(paintCovers(host, 120.5, 60.5)).toBe(true)
  layer!.destroy()
})

test('an outer opaque ancestor keeps its own color outside the parent', () => {
  const { parent, shape, world } = counterexampleScene(false)
  const outer = node('frame', 0, 0, 200, 200)
  outer.clip = false
  outer.fills[0].color = '#0000ff'
  outer.children = [parent.id]
  const plan = rotationSourcePlan({
    ...base, node: shape, world, parent, degrees: 90, center: { x: 120, y: 60 },
    ancestors: [
      { node: outer, matrix: outer.transform },
      { node: parent, matrix: parent.transform },
    ],
    nodes: { [outer.id]: outer, [parent.id]: parent, [shape.id]: shape },
  })
  expect(backdropAt(plan, 90.5, 50.5)).toBe('#00ff00')
  expect(backdropAt(plan, 155.5, 45.5)).toBe('#0000ff')
})

test('a clipping parent only restores the footprint the child actually painted', () => {
  const { parent, shape, world } = counterexampleScene(true)
  const plan = rotationSourcePlan({
    ...base, node: shape, world, parent, degrees: 90, center: { x: 120, y: 60 },
    ancestors: [{ node: parent, matrix: parent.transform }],
    nodes: { [parent.id]: parent, [shape.id]: shape },
  })
  expect(plan?.clip).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  expect(backdropAt(plan, 90.5, 50.5)).toBe('#00ff00')
  expect(backdropAt(plan, 155.5, 45.5)).toBeNull()
})

test('parent color #00ff0080 is not an opaque backdrop', () => {
  const { parent, shape, world } = counterexampleScene(false)
  parent.fills[0].color = '#00ff0080'
  expect(rotationSourcePlan({
    ...base, node: shape, world, parent, degrees: 90, center: { x: 120, y: 60 },
    ancestors: [{ node: parent, matrix: parent.transform }],
    nodes: { [parent.id]: parent, [shape.id]: shape },
  })).toBeNull()
})

test('a mask sibling blocks nested own-paint', () => {
  const { parent, shape, world } = counterexampleScene(false)
  const mask = node('rectangle', 0, 0, 0, 0)
  mask.mask = true
  parent.children = [mask.id, shape.id]
  expect(rotationSourcePlan({
    ...base, node: shape, world, parent, degrees: 0, center: { x: 120, y: 60 },
    ancestors: [{ node: parent, matrix: parent.transform }],
    nodes: { [parent.id]: parent, [shape.id]: shape, [mask.id]: mask },
    others: [],
  })).toBeNull()
})

test('a nested large image keeps its full rectangle inside a proven frame', () => {
  const frame = node('frame', -200, -200, 500, 500)
  frame.clip = true
  frame.fills[0].color = '#112233'
  const shape = rect('#ffffff')
  shape.fills[0].kind = 'image'
  const hash = 'ab'.repeat(32)
  shape.fills[0].image = `design-app://app/source-image/owned-1/${hash}-3000x2000.png?samples=1`
  shape.transform = [1, 0, 0, 1, 100, 100]
  const world = [1, 0, 0, 1, -100, -100] as typeof shape.transform
  frame.children = [shape.id]
  const plan = rotationSourcePlan({
    ...base, node: shape, world, parent: frame,
    ancestors: [{ node: frame, matrix: frame.transform }],
    nodes: { [frame.id]: frame, [shape.id]: shape },
  })
  expect(rotationImageAddress(shape.fills[0].image!)).toBe(`design-app://app/source-image/owned-1/${hash}-3000x2000.png`)
  expect(plan?.box).toEqual(source)
  expect(plan?.clip).toEqual({ x: -200, y: -200, width: 500, height: 500 })
  expect(plan?.holes).toEqual([{ box: source, color: '#112233' }])
  expect(plan?.paint).toEqual({
    kind: 'image',
    src: `design-app://app/source-image/owned-1/${hash}-3000x2000.png`,
    fit: 'cover',
  })
  expect(plan && 'crop' in plan).toBe(false)
  expect(rotation_screenshot_admitted(
    '#ffffff', 1,
    source.x, source.y, source.width, source.height,
    0, 0, 100, 100,
    center.x, center.y, 45,
    0, 0, 100, 100,
  )).toBe(false)
  const host = document.createElement('div')
  document.body.append(host)
  const layer = mountRotationSource(host, {
    plan: plan!, view, viewport: { width: 100, height: 100 },
    corners: boxPoints(source), drawSelection: true, ids: [shape.id],
  })
  const paint = host.querySelector('[data-testid="rotation-source-paint"]') as HTMLElement
  const clip = host.querySelector('[data-testid="rotation-source-clip"]') as HTMLElement
  expect(host.querySelector('canvas')).toBeNull()
  expect(paint.dataset.sourceBox).toBe('-100,-100,300,300')
  expect(paint.style.width).toBe('300px')
  expect(paint.style.visibility).toBe('hidden')
  expect(clip.style.overflow).toBe('hidden')
  expect(clip.style.width).toBe('500px')
  paint.querySelector('img')!.dispatchEvent(new Event('load'))
  expect(paint.style.visibility).toBe('')
  const delta = around(center, rotate(45))
  layer!.place(delta, { x: 3, y: 3 }, 45)
  const image = paint.querySelector('img') as HTMLImageElement
  expect(image.src).toContain(`${hash}-3000x2000.png`)
  expect(image.src).not.toContain('samples=1')
  expect(rotationSourceCoversScreen(plan!.box, view, delta, { x: 3, y: 3 })).toBe(true)
  layer!.destroy()
  const again = mountRotationSource(host, {
    plan: plan!, view, viewport: { width: 100, height: 100 },
    corners: boxPoints(source), drawSelection: false, ids: [shape.id],
  })
  again!.place(delta, { x: 3, y: 3 }, 45)
  host.querySelector('img')!.dispatchEvent(new Event('error'))
  expect(host.querySelector('[data-testid="rotation-source-preview"]')).toBeNull()
})

test('a front sibling and a translucent parent fill are not redrawn over the page', () => {
  const frame = node('frame', 0, 0, 400, 300)
  frame.fills[0].color = '#112233'
  const shape = node('rectangle', 100, 100, 120, 40)
  const world = [1, 0, 0, 1, 100, 100] as typeof shape.transform
  frame.children = [shape.id]
  expect(rotationSourcePlan({
    ...base, node: shape, world, parent: frame, degrees: 90,
    center: { x: 160, y: 120 },
    ancestors: [{ node: frame, matrix: frame.transform }],
    nodes: { [frame.id]: frame, [shape.id]: shape },
    others: [{ x: 145, y: 150, width: 30, height: 24 }],
  })).toBeNull()
  frame.fills[0].color = '#ff000080'
  expect(rotationSourcePlan({
    ...base, node: shape, world, parent: frame, degrees: 0,
    ancestors: [{ node: frame, matrix: frame.transform }],
    nodes: { [frame.id]: frame, [shape.id]: shape },
  })).toBeNull()
})

function domHoleColor(host: HTMLElement, x: number, y: number): string | null {
  let color: string | null = null
  for (const hole of host.querySelectorAll<HTMLElement>('[data-testid="rotation-source-hole"]')) {
    const left = Number.parseFloat(hole.style.left)
    const top = Number.parseFloat(hole.style.top)
    const width = Number.parseFloat(hole.style.width)
    const height = Number.parseFloat(hole.style.height)
    if (x >= left && y >= top && x < left + width && y < top + height)
      color = (hole.dataset.holeColor || hole.style.background).toLowerCase()
  }
  return color
}

function paintCovers(host: HTMLElement, x: number, y: number): boolean {
  const clip = host.querySelector<HTMLElement>('[data-testid="rotation-source-clip"]')
  if (clip) {
    const left = Number.parseFloat(clip.style.left)
    const top = Number.parseFloat(clip.style.top)
    const width = Number.parseFloat(clip.style.width)
    const height = Number.parseFloat(clip.style.height)
    if (x < left || y < top || x >= left + width || y >= top + height) return false
  }
  const paint = host.querySelector<HTMLElement>('[data-testid="rotation-source-paint"]')
  if (!paint) return false
  const numbers = paint.style.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number)
  if (!numbers || numbers.length !== 6) return false
  const [a, b, c, d, e, f] = numbers
  const originLeft = clip ? Number.parseFloat(clip.style.left) : 0
  const originTop = clip ? Number.parseFloat(clip.style.top) : 0
  const left = originLeft + Number.parseFloat(paint.style.left)
  const top = originTop + Number.parseFloat(paint.style.top)
  const width = Number.parseFloat(paint.style.width)
  const height = Number.parseFloat(paint.style.height)
  const mapped = boxPoints({ x: 0, y: 0, width, height }).map(corner => ({
    x: left + a * corner.x + c * corner.y + e,
    y: top + b * corner.x + d * corner.y + f,
  }))
  let winding = 0
  for (let index = 0; index < mapped.length; index += 1) {
    const start = mapped[index], end = mapped[(index + 1) % mapped.length]
    const cross = (end.x - start.x) * (y - start.y) - (end.y - start.y) * (x - start.x)
    if (start.y <= y && end.y > y && cross > 0) winding += 1
    else if (start.y > y && end.y <= y && cross < 0) winding -= 1
  }
  return winding !== 0
}
