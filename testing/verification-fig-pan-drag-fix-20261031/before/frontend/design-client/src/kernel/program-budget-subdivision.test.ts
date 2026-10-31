import { expect, test } from 'vitest'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { decodeScenePacket } from './gpu/scene-packet'
import type { GpuScene, PathMesh } from './gpu/types'
import { markRenderFailure, renderFailureFields } from './render-failure-telemetry'
import { isAnalyticProgramBudget, renderPreviewRegions } from './preview-tiles'

const budget = 'GPU analytic interval program budget exceeded'
function document(count: number, y = 20) {
  const nodes = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const id = `rect-${i}`, angle = (i + 1) * .0001
    return [id, { id, kind: 'rectangle', width: 512, height: 512,
      transform: [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 30, y],
      fills: [{ kind: 'solid', color: '#123456' }] }]
  }))
  return { schemaVersion: 3, id: 'program-budget', name: 'program budget', rasterProfile: 'figma',
    colorManagement: { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 },
    pages: [{ id: 'p', name: 'p', background: '#ffffff', children: Object.keys(nodes) }], nodes }
}

// Independent decoder of the compiler's f64 endpoints, not a renderer/cache
// approximation. Compare every correlated row and interval after exact crops.
function spans(scene: GpuScene, path: PathMesh, y: number, phase: number) {
  const data = scene.curves!, start = path.area!.first * 4
  expect(data[start]).toBe(3)
  const row = y - path.rect.y, header = start + 4 + (row * 4 + phase) * 4
  if (row < 0 || row >= path.rect.h) return []
  const result: number[][] = []
  const remainder = (at: number) => {
    const buffer = new DataView(new ArrayBuffer(8))
    for (let i = 0; i < 4; i++) buffer.setUint16(i * 2, data[at + i], true)
    return buffer.getFloat64(0, true)
  }
  for (let i = 0; i < data[header + 1]; i++) {
    const at = start + data[header] * 4 + i * 12
    result.push([path.rect.x + data[at] + data[at + 2] + remainder(at + 4),
      path.rect.x + data[at + 1] + data[at + 3] + remainder(at + 8)])
  }
  return result
}

test('actual WASM program overflow subdivides at unchanged camera and every child interval matches the full reference', async () => {
  const engine = new VectorEngine()
  const options = { pageId: 'p', width: 600, height: 600, view: { x: .25, y: .5, zoom: 1 }, rasterProfile: 'figmaSubpixel',
    prepareViewport: { x: 0, y: 0, w: 600, h: 600 } }
  try {
    engine.load_document(JSON.stringify(document(100)))
    const compile = (x: number, y: number, w: number, h: number) => decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({
      ...options, width: w, height: h, gpuViewport: { x, y, w, h },
    })))
    const reference = decodeScenePacket(engine.compile_gpu_packet(JSON.stringify(options)))
    expect(reference.curves!.length).toBeGreaterThan(2_000_000)
    expect(() => compile(0, 0, 514, 514)).toThrow(budget)
    const leaves: { width: number; height: number; floats: number; nodes: number }[] = []
    const result = await renderPreviewRegions(514, 514, async tile => {
      const scene = compile(tile.x, tile.y, tile.width, tile.height)
      expect(scene.view).toEqual(options.view)
      expect(scene.curves!.length).toBeLessThanOrEqual(2_000_000)
      for (const [id, node] of Object.entries(scene.nodes)) {
        const path = node.fill, source = reference.nodes[id].fill
        if (!path?.area || !source?.area) continue
        for (let y = path.rect.y; y < path.rect.y + path.rect.h; y++) for (let phase = 0; phase < 4; phase++) {
          const expected = spans(reference, source, y, phase).map(([left, right]) =>
            [Math.max(left, path.rect.x), Math.min(right, path.rect.x + path.rect.w)]).filter(([left, right]) => right > left)
          expect(spans(scene, path, y, phase)).toEqual(expected)
        }
      }
      leaves.push({ width: tile.width, height: tile.height, floats: scene.curves!.length, nodes: Object.keys(scene.nodes).length })
    }, 514)
    expect(result.tiles).toBeGreaterThan(1)
    console.info('PROGRAM_SUBDIVISION_WASM', JSON.stringify({ referenceFloats: reference.curves!.length, leaves }))
  } finally { engine.free() }
}, 30000)

test('actual WASM dense crossing geometry still fails at the minimum region without relaxing admission', () => {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document(600, -200)))
    let failure: unknown
    try { engine.compile_gpu_packet(JSON.stringify({ pageId: 'p', width: 64, height: 64,
      view: { x: .25, y: .5, zoom: 1 }, rasterProfile: 'figmaSubpixel', gpuViewport: { x: 0, y: 0, w: 64, h: 64 } })) }
    catch (error) { failure = error }
    expect(renderFailureFields(failure).failureCode).toBe(94)
    console.info('PROGRAM_MINIMUM_WASM', JSON.stringify({ nodes: 600, width: 64, height: 64, failureCode: 94 }))
  } finally { engine.free() }
})

test('program complexity independent of ROI stops at 64px and never publishes a partial assembly', async () => {
  let attempts = 0
  const failure = Error(budget)
  await expect(renderPreviewRegions(256, 256, async () => { attempts++; throw failure }, 256)).rejects.toBe(failure)
  expect(attempts).toBe(5)
})

test('cancelled program subdivision stops before compiling any child', async () => {
  let current = true, attempts = 0
  await expect(renderPreviewRegions(514, 514, async () => {
    attempts++; current = false; throw Error(budget)
  }, 514, undefined, async () => { if (!current) throw Error('PREVIEW_CANCELLED') })).rejects.toThrow('PREVIEW_CANCELLED')
  expect(attempts).toBe(1)
})

test('program subdivision accepts only typed code94 and cannot reclassify device or unknown path failures', () => {
  expect(isAnalyticProgramBudget(Error(budget))).toBe(true)
  expect(isAnalyticProgramBudget(markRenderFailure(Error('wrapped'), { failureCategory: 3, failureCode: 94 }))).toBe(true)
  for (const error of [Error(`Unknown: ${budget}`), Error(`${budget}; device lost`), Error('Scanline work budget exceeded'),
    markRenderFailure(Error(budget), { failureCategory: 4, failureCode: 30 })])
    expect(isAnalyticProgramBudget(error)).toBe(false)
})
