/** Exact CPU draw-plan and software-composition witnesses. No browser/GPU claim. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { compositeDrawPlan as currentPlan, compositeRasterQuad } from './composite-draw-plan.ts'

const frozen = readFileSync(new URL('../../../../../testing/verification-performance-publication/composite-draw-plan.before.ts', import.meta.url), 'utf8')
assert.equal(createHash('sha256').update(frozen).digest('hex'), 'c2299336e926a8c83ca3daeb92fde2db5b74a6770c4cf071d5c5ea84eae53f55')
const reference = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(frozen))}`)
const plan = process.env.DESIGN_COMPOSITE_BASELINE === '1' ? reference.compositeDrawPlan : currentPlan
const view = { x: 0, y: 0, zoom: 1 }
const item = (serial, placement, extra = {}) => ({
  tile: { key: String(serial), serial, x: 0, y: 0, width: 16, height: 16, zoom: 1, bytes: new Uint8Array() },
  active: true, layer: 0, gutter: 0, placement, ...extra,
})
function equalPlan(items, camera = view, width = 128, height = 96) {
  const snapshot = structuredClone(items)
  const expected = reference.compositeDrawPlan(items, camera, width, height)
  const actual = plan(items, camera, width, height)
  assert.deepStrictEqual(actual, expected)
  assert.deepStrictEqual(items, snapshot, 'planning must not mutate any item or texture')
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].item, expected[i].item, 'published draw keeps exact tile identity')
    for (const dpr of [.75, 1, 1.25, 2, 3])
      assert.deepStrictEqual(compositeRasterQuad(actual[i].placement, actual[i].clip, width, height, dpr),
        reference.compositeRasterQuad(expected[i].placement, expected[i].clip, width, height, dpr))
  }
  return actual
}

test('disjoint resident tiles do no fragment flattening while preserving all 64 draws', () => {
  const tiles = Array.from({ length: 64 }, (_, i) => item(i, {
    left: (i % 8) * 16, top: Math.floor(i / 8) * 12, width: 16, height: 12,
  }))
  let flattenings = 0
  const flatMap = Array.prototype.flatMap
  let draws
  try {
    Array.prototype.flatMap = function (...args) { flattenings++; return flatMap.apply(this, args) }
    draws = plan(tiles, view, 128, 96)
  } finally { Array.prototype.flatMap = flatMap }
  assert.equal(draws.length, 64)
  assert.deepStrictEqual(draws, reference.compositeDrawPlan(tiles, view, 128, 96))
  assert.equal(flattenings, 0, `disjoint tiles performed ${flattenings} redundant fragment flattenings`)
})

test('touching, half-open, fractional, signed-zero and degenerate rectangles retain exact metadata', () => {
  for (const edge of [-0, 0, .5 - 1e-8, .5, .5 + 1e-8, 15.25, 15.24999999999, 63.5, 128]) {
    const tiles = [item(0, { left: -0, top: -0, width: edge, height: 96 }),
      item(1, { left: edge, top: 0, width: 128 - edge, height: 96 }),
      item(2, { left: edge, top: 0, width: 0, height: 96 }, { layer: 3 }),
      item(3, { left: edge, top: 96, width: 20, height: 0 }, { layer: 4 }),
      item(4, { left: edge, top: -2, width: 12, height: 101 }, { layer: 1, gutter: 1,
        clip: { left: edge - .125, top: .5, width: 8.25, height: 95 } }),
      item(5, { left: edge, top: 0, width: 16, height: 32 }, { layer: 2, blend: true })]
    equalPlan(tiles)
  }
  // Preserve historical invalid-input behavior too; this optimization adds no
  // validation policy and cannot silently turn NaN/Infinity into a new draw.
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    equalPlan([item(1, { left: value, top: 0, width: 24, height: 32 }),
      item(2, { left: 2, top: 1, width: 32, height: 40 })])
    equalPlan([item(1, { left: 0, top: value, width: 24, height: 32 }),
      item(2, { left: 2, top: 1, width: value, height: 40 }, { blend: true })])
  }
})

test('1,500 generated scenes preserve fragment, tile and sampling order byte-for-byte', () => {
  let seed = 0xa0c12491
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000)
  const scales = [.1, .125, .5, 1, 1.25, 2, 8, 32]
  for (let scene = 0; scene < 1500; scene++) {
    const camera = { x: (random() - .5) * 120, y: (random() - .5) * 100, zoom: scales[scene % scales.length] }
    const tiles = Array.from({ length: 1 + Math.floor(random() * 50) }, (_, i) => {
      const tile = item(i, { left: (random() - .25) * 170, top: (random() - .25) * 130,
        width: random() * 150, height: random() * 110 },
      { layer: Math.floor(random() * 5), active: random() > .1, blend: random() > .75, gutter: scene % 3 === 0 ? 1 : 0 })
      tile.tile = { ...tile.tile, zoom: scales[Math.floor(random() * scales.length)],
        x: (random() - .5) * 100, y: (random() - .5) * 100,
        width: 2 + Math.floor(random() * 514), height: 2 + Math.floor(random() * 514),
        phaseX: random(), phaseY: random() }
      if (scene % 4 === 0) delete tile.placement
      if (random() > .65) tile.clip = { left: random() * 80, top: random() * 50, width: random() * 100, height: random() * 80 }
      return tile
    })
    equalPlan(tiles, camera)
  }
})

// Deterministic CPU-only texture sampler, with a visible per-tile color and
// texel ramp. Exact plan/UV equality above is the backend-independent contract;
// these bytes independently guard against holes, incorrect ownership and order.
function pixels(draws, width, height, dpr) {
  const w = Math.ceil(width * dpr), h = Math.ceil(height * dpr)
  const output = new Uint8Array(w * h * 4)
  for (const draw of draws) {
    const q = compositeRasterQuad(draw.placement, draw.clip, width, height, dpr)
    if (!q) continue
    const id = draw.item.tile.serial, alpha = draw.item.blend ? .5 : 1
    for (let y = q.y; y < q.y + q.height; y++) for (let x = q.x; x < q.x + q.width; x++) {
      const u = q.uv[0] + ((x + .5 - q.x) / q.width) * q.uv[2]
      const v = q.uv[1] + ((y + .5 - q.y) / q.height) * q.uv[3]
      const red = (id * 47 + Math.floor(u * 16) * 9) & 255
      const green = (id * 73 + Math.floor(v * 16) * 11) & 255
      const blue = (id * 17 + Math.floor((u + v) * 16) * 3) & 255
      const offset = (y * w + x) * 4
      for (const [channel, value] of [red, green, blue].entries())
        output[offset + channel] = Math.round(value * alpha + output[offset + channel] * (1 - alpha))
      output[offset + 3] = Math.round(255 * alpha + output[offset + 3] * (1 - alpha))
    }
  }
  return output
}

test('CPU sampled texture pixels are identical through progressive layers, blends and fractional cameras', () => {
  const items = [item(1, { left: 0, top: 0, width: 128, height: 96 }),
    item(2, { left: 11.24999999999, top: 7.5, width: 69.125, height: 40.25 }, { layer: 1 }),
    item(3, { left: 20.5, top: 12.75, width: 55.25, height: 42.5 }, { layer: 2, blend: true }),
    item(4, { left: 30.25, top: 18.75, width: 68.5, height: 40.75 }, { layer: 3, blend: true })]
  for (const dpr of [.75, 1, 1.25, 2, 3]) {
    const expected = pixels(reference.compositeDrawPlan(items, view, 128, 96), 128, 96, dpr)
    const draws = plan(items, view, 128, 96), actual = pixels(draws, 128, 96, dpr)
    assert.deepStrictEqual(actual, expected)
    assert.equal(actual.filter((_, i) => i % 4 === 3).every(alpha => alpha === 255), true)
    assert.notDeepStrictEqual(pixels(draws.slice().reverse(), 128, 96, dpr), expected, 'wrong blend order must fail the pixel witness')
    assert.notDeepStrictEqual(pixels(draws.filter(draw => draw.item.tile.serial !== 1), 128, 96, dpr), expected, 'missing background must fail the pixel witness')
    const clipped = draws.map(draw => ({ ...draw, clip: { ...draw.clip, right: draw.clip.right - 1 } }))
    assert.notDeepStrictEqual(pixels(clipped, 128, 96, dpr), expected, 'shrinking ownership must fail the pixel witness')
  }
})
