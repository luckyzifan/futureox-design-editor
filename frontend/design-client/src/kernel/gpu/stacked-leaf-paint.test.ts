import { expect, test } from 'vitest'
import { GpuRenderer } from './renderer'
import { paint } from '../../model'
import type { GpuNode, Rect, Surface } from './types'

const bounds = { x: 0, y: 0, w: 32, h: 24 }
const path = { first: 0, count: 3, rule: 'nonzero' as const, sampleCount: 4, rect: bounds, area: { first: 0, count: 4 } }

function leaf(strokes: GpuNode['strokes'], effects: GpuNode['effects'] = []): GpuNode {
  return {
    id: 'leaf', rect: bounds, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [32, 24],
    fill: path, fills: [{ ...paint('#3478ab'), kind: 'solid', stops: [] }],
    strokes, effects, children: [], mask: false, clip: false, opacity: 1, blend: 'normal',
  }
}

function harness(node: GpuNode) {
  const driver: any = {
    name: 'webgpu', managed: true, create: (w: number, h: number) => ({ width: w, height: h, bytes: w * h * 16, resource: {} }),
    destroy: () => {}, clear: () => {}, pass: () => {}, checkpoint: async () => {},
  }
  const renderer = new GpuRenderer(driver) as any
  const mask = { texture: { width: 32, height: 24, bytes: 16, resource: {}, binaryCoverage: true }, rect: bounds }
  const paints: string[] = []
  let isolations = 0
  renderer.scene = {
    coherentSamples: true, nodes: { leaf: node }, roots: ['leaf'], curves: new Float32Array(0),
    extent: bounds, view: { x: 0, y: 0, zoom: 0.125 },
  }
  renderer.nodeMask = () => mask
  renderer.mask = () => mask
  renderer.reclaimForPaintOver = () => undefined
  renderer.reclaimScratch = async () => {}
  renderer.retireLeafMasks = () => {}
  renderer.paintOver = (_n: GpuNode, item: { kind: string; color?: string }, _mask: Surface, target: Surface) => {
    paints.push(`${item.kind}:${item.color}`)
    return target
  }
  const empty = renderer.empty.bind(renderer)
  renderer.empty = (rect: Rect) => { isolations++; return empty(rect) }
  const targets = [0, 1, 2, 3].map(() => renderer.acquire(bounds))
  return { renderer, paints, get isolations() { return isolations }, targets }
}

const stroke = { path, paint: { ...paint('#102030'), kind: 'solid' as const, stops: [] }, align: 'center' as const }

test('a settled fill and centered stroke paint the parent without an isolation surface', async () => {
  const h = harness(leaf([stroke]))
  const out = await h.renderer.drawBundle(['leaf'], h.targets)
  expect(out).toHaveLength(4)
  expect(h.isolations).toBe(0)
  expect(h.paints).toEqual(Array.from({ length: 4 }, () => ['solid:#3478ab', 'solid:#102030']).flat())
})

test('effects, inside strokes, and ancestor clips keep the isolated leaf', async () => {
  const blurred = harness(leaf([stroke], [{ kind: 'blur', visible: true, radius: 4, color: '#000000' } as GpuNode['effects'][number]]))
  await blurred.renderer.drawBundle(['leaf'], blurred.targets)
  expect(blurred.isolations).toBeGreaterThan(0)

  const inside = harness(leaf([{ ...stroke, align: 'inside' }]))
  await inside.renderer.drawBundle(['leaf'], inside.targets)
  expect(inside.isolations).toBeGreaterThan(0)

  const clipped = harness(leaf([stroke]))
  const clip = clipped.targets.map(() => clipped.renderer.acquire(bounds))
  await clipped.renderer.drawBundle(['leaf'], [0, 1, 2, 3].map(() => clipped.renderer.acquire(bounds)), clip)
  expect(clipped.isolations).toBeGreaterThan(0)
})
