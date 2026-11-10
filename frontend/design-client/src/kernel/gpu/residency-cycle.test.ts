import { expect, test } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene, Texture } from './types'
import { paint } from '../../model'

const MiB = 1024 * 1024

function scene(width: number, height: number, count: number, dpr = 2): GpuScene {
  const nodes: GpuScene['nodes'] = {}
  const roots: string[] = []
  const columns = Math.max(1, Math.floor(Math.sqrt(count)))
  const cellW = Math.max(8, Math.floor(width / columns))
  const cellH = Math.max(8, Math.floor(height / Math.ceil(count / columns)))
  for (let index = 0; index < count; index++) {
    const id = `n${index}`
    const rect = { x: (index % columns) * cellW, y: Math.floor(index / columns) * cellH, w: cellW, h: cellH }
    nodes[id] = {
      id, rect, matrix: [1, 0, 0, 1, rect.x, rect.y], inverse: [1, 0, 0, 1, -rect.x, -rect.y],
      size: [rect.w, rect.h], fill: { rect, first: 0, count: 0, rule: 'evenodd' },
      fills: [paint('#336699')], strokes: [], children: [], mask: false, clip: false,
      opacity: 1, blend: 'normal', effects: [],
    }
    roots.push(id)
  }
  return {
    version: 7, width, height, extent: { x: 0, y: 0, w: width, h: height },
    background: '#ffffff', transparent: false, grid: false,
    view: { x: 0, y: 0, zoom: 1, dpr }, roots, vertices: [], nodes,
    coherentSamples: false, floatCompositing: true,
    densePaint: { vertexFloats: 0, width: 32, height: 32, nodes: Object.fromEntries(roots.map((id, index) => [id, index])), relocations: [] },
  }
}

async function renderSeries(scenes: GpuScene[], complete: boolean) {
  const live = new Map<Texture, number>()
  let serial = 1
  const driver = {
    name: 'webgpu', managed: true, captureDisplay: true, description: 'residency cycle',
    lost: false, drawCalls: 0, triangles: 0, scratchBytes: 0, resourceEpoch: 0, completedResourceEpoch: 0,
    begin() { driver.resourceEpoch += 1; driver.drawCalls = 0 },
    create(width: number, height: number) {
      const bytes = width * height * 16
      const texture = { id: serial++, width, height, bytes, resource: { id: serial } } as Texture
      live.set(texture, bytes)
      return texture
    },
    destroy(texture: Texture) { live.delete(texture) },
    clear() {}, mask() {}, pass() { driver.drawCalls += 1 }, over() { driver.drawCalls += 1 },
    async finish() {
      if (complete) driver.completedResourceEpoch = driver.resourceEpoch
      return {}
    },
    dispose() { live.clear() },
  }
  const renderer = new GpuRenderer(driver as unknown as Driver) as unknown as {
    bytes: number
    peak: number
    frameBudget: number
    render(scene: GpuScene, readback?: boolean, present?: boolean): Promise<{ drawCalls: number; textureBytes: number; residencyStableBytes: number | null; peakTextureBytes: number }>
    texturePeakAttribution(): {
      chargedBytes: number
      peakBytes: number
      stableBytes: number | null
      resources: { bytes: number; class: string; life: string }[]
      trend: { grew: boolean; stableBytes: number[]; thermal: string | null; cycles: number; crossConditionResets: number }
    }
    dispose(): void
  }
  const rows = []
  for (const scene of scenes) {
    const result = await renderer.render(scene, false, true)
    const liveBytes = [...live.values()].reduce((sum, bytes) => sum + bytes, 0)
    rows.push({
      live: liveBytes, ledger: renderer.bytes, peak: renderer.peak, draws: result.drawCalls,
      budget: renderer.frameBudget, reported: result.textureBytes, stable: result.residencyStableBytes,
      attribution: renderer.texturePeakAttribution(),
      maskHits: (result as { maskHits?: number }).maskHits ?? 0,
      maskRasterizations: (result as { maskRasterizations?: number }).maskRasterizations ?? 0,
    })
  }
  renderer.dispose()
  return rows
}

test('same-condition cycles keep one stable residency and do not raise the budget', async () => {
  const rows = await renderSeries(Array.from({ length: 4 }, () => scene(512, 512, 1)), true)
  expect(rows[0].budget).toBe(1024 * MiB)
  for (const row of rows) {
    expect(row.budget).toBe(rows[0].budget)
    expect(row.live).toBe(rows[0].live)
    expect(row.ledger).toBe(row.live)
    expect(row.stable).toBe(row.live)
    expect(row.attribution.resources.reduce((sum, resource) => sum + resource.bytes, 0)).toBe(row.ledger)
  }
  expect(new Set(rows.map(row => row.draws)).size).toBe(1)
  const trend = rows[3].attribution.trend
  expect(trend.thermal).toBe('warm')
  expect(trend.cycles).toBe(3)
  expect(trend.grew).toBe(false)
  expect(trend.stableBytes).toEqual([rows[0].live, rows[0].live, rows[0].live])
  expect(rows[3].peak).toBe(rows[0].live)
})

test('a completed viewport change drops the unreferenced generation', async () => {
  const first = scene(320, 240, 4, 2)
  const second = scene(300, 220, 4, 2)
  const switched = await renderSeries([first, second, first, second], true)
  const onlySecond = await renderSeries([second], true)
  const onlyFirst = await renderSeries([first], true)
  // The previous viewport's completed free pool is physical residency the
  // finished frame did not read. It must not remain in the stable total.
  // Mask coverage touched by either viewport stays reusable, so the stable
  // value can exceed a cold single-scene run by that cache alone.
  expect(switched[1].live).toBeLessThan(onlyFirst[0].live + onlySecond[0].live)
  expect(switched[1].live - onlySecond[0].live).toBeLessThan(onlyFirst[0].live)
  expect(switched[1].draws).toBe(onlySecond[0].draws)
  expect(switched[2].draws).toBe(onlyFirst[0].draws)
  expect(switched[2].maskRasterizations).toBe(0)
  expect(switched[2].maskHits).toBeGreaterThan(0)
  expect(switched[1].peak).toBeGreaterThan(switched[1].live)
  expect(switched[1].attribution.resources.every(resource => resource.life === 'reclaimable' || resource.life === 'active')).toBe(true)
  expect(switched[1].attribution.trend.thermal).toBe('cold')
  for (const row of switched) expect(row.budget).toBe(1024 * MiB)
})

test('retired textures stay resident until GPU completion', async () => {
  const first = scene(320, 240, 4, 2)
  const second = scene(300, 220, 4, 2)
  const waiting = await renderSeries([first, second], false)
  const completed = await renderSeries([first, second], true)
  expect(waiting[1].live).toBeGreaterThan(completed[1].live)
  expect(waiting[1].ledger).toBe(waiting[1].live)
  expect(waiting[1].attribution.resources.some(resource => resource.life === 'retired-pending-completion' || resource.life === 'active')).toBe(true)
  expect(waiting[1].draws).toBe(completed[1].draws)
  expect(waiting[1].budget).toBe(completed[1].budget)
})
