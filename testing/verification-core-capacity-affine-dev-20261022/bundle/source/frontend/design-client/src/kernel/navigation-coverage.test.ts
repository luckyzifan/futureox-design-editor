import { expect, test } from 'vitest'
import { navigationCoverageTiles, navigationHasCoverage, navigationCoverageFlight } from './navigation-coverage'
import { navigationPreviewDensity } from './navigation-zoom'
import { compositeDrawPlan, compositeRasterQuad } from './gpu/composite-draw-plan'
import { physicalCoverage } from './gpu/physical-coverage'

const document = {}, client = {}
const owner = { document, client, revision: 4, resident: true, device: '11/1/1' }
const tile = { key: 'high-zoom', document, revision: 4, x: 0, y: 0, width: 1024, height: 512,
  zoom: 32, gutter: 0, gpuTile: 1, residentDevice: { client, key: '11/1/1' } }

test.each([1, 2, 3, 4, 5])('32x dwell crop does not certify newly exposed %ix viewport', zoom => {
  const residents = navigationCoverageTiles([tile], new Set([tile.key]), owner)
  expect(navigationHasCoverage(residents, { x: 0, y: 0, zoom: 32 }, 1024, 512)).toBe(true)
  expect(navigationHasCoverage(residents, { x: 0, y: 0, zoom }, 1024, 512)).toBe(false)
  const covering = { ...tile, key: 'wide', zoom }
  expect(navigationHasCoverage([...residents, covering], { x: 0, y: 0, zoom }, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([...residents, covering], { x: 0, y: 0, zoom }, 1024, 512, zoom * 2)).toBe(false)
})

test.each(['document', 'revision', 'page/session-contract', 'device', 'client', 'not-ready', 'unknown-device'] as const)(
  'continuity reuse rejects %s without falsely certifying coverage', kind => {
    const next = { ...owner }
    if (kind === 'document') next.document = {}
    if (kind === 'revision' || kind === 'page/session-contract') next.revision++
    if (kind === 'device') next.device = '11/2/2'
    if (kind === 'client') next.client = {}
    if (kind === 'unknown-device') next.device = ''
    expect(navigationCoverageTiles([tile], new Set(kind === 'not-ready' ? [] : [tile.key]), next)).toEqual([])
  })

test('one-pixel uncovered strip is not full coverage, including fractional cameras', () => {
  const view = { x: .25, y: -.125, zoom: 2 }
  const full = { ...tile, zoom: 2, x: -.25, y: .125 }
  expect(navigationHasCoverage([full], view, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([{ ...full, width: 1023 }], view, 1024, 512)).toBe(false)
})

test('bounded coverage density is temporary and never raises the native sampling contract', () => {
  for (const [width, height, dpr] of [[1024, 512, 2], [3840, 2160, 2], [16000, 9000, 3]]) {
    const density = navigationPreviewDensity(dpr, width, height)
    expect(density).toBeLessThanOrEqual(dpr)
    expect(width * height * density * density).toBeLessThanOrEqual(1_048_577)
    expect(Math.max(width, height) * density).toBeLessThanOrEqual(2048)
  }
})

test('flight completion is idempotent and carries no readiness or exact certificate', async () => {
  const flight = navigationCoverageFlight<object>({}, 3)
  let done = false
  void flight.done.then(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false)
  flight.tile = tile
  await Promise.resolve(); expect(done).toBe(false)
  flight.finish(); flight.finish(); await flight.done
  expect(done).toBe(true)
})


test('production one-pixel gutters do not fill a missing native seam', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  const left = { ...tile, key: 'left', x: -1, y: -1, width: 514, height: 514, zoom: 1, gutter: 1 }
  const right = { ...left, key: 'right', x: 511 }
  expect(navigationHasCoverage([left, right], view, 1024, 512)).toBe(true)
  expect(navigationHasCoverage([left, { ...right, x: 512 }], view, 1024, 512)).toBe(false)
  const ready = new Set([left.key])
  expect(navigationHasCoverage(navigationCoverageTiles([left, right], ready, owner), view, 1024, 512)).toBe(false)
})

test('geometry admission is never a clipped submitted-fragment coverage certificate', () => {
  const full = { ...tile, zoom: 1, serial: 1, bytes: new Uint8Array() }
  const view = { x: 0, y: 0, zoom: 1 }
  expect(navigationHasCoverage([full], view, 1024, 512)).toBe(true)
  const draws = compositeDrawPlan([{ tile: full, active: true, layer: 0, gutter: 0,
    clip: { left: 0, top: 0, width: 1023, height: 512 } }], view, 1024, 512)
  const rows = draws.map(row => ({ ...compositeRasterQuad(row.placement, row.clip, 1024, 512, 1)!, native: false }))
  expect(physicalCoverage(rows, 1024, 512)).toEqual({ pixelCoverageComplete: false, nativeCoverageComplete: false })
})
