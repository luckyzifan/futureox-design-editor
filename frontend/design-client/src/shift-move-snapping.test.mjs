import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { dragThresholdPassed } from './canvas-pointer-intent.ts'
import { placedSmartGuides } from './canvas-smart-guides.ts'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const canvas = read('./Canvas.tsx'), view = read('./canvas-view.ts')
const canvasViewImport = canvas.match(/import \{([^}]+)\} from '\.\/canvas-view'/)
assert.ok(canvasViewImport, 'canvas move uses the production canvas-view helpers')
const canvasViewNames = new Set(canvasViewImport[1].split(',').map(name => name.trim()).filter(Boolean))
for (const name of ['createBox', 'forcedPixelSnap', 'resizeInBasis', 'snapMove'])
  assert.equal(canvasViewNames.has(name), true, name)
function boundary(source, start, end) {
  assert.equal(source.split(start).length, 2, `unique start: ${start}`)
  assert.equal(source.split(end).length, 2, `unique end: ${end}`)
  assert.ok(source.indexOf(start) < source.indexOf(end))
  return source.slice(source.indexOf(start), source.indexOf(end))
}

// Exercise the production move branch and pixel-axis mask, not a copied snap
// algorithm. The drag has already crossed its threshold and stays inside its
// parent; duplication/free-move ports are outside this axis-snapping boundary.
// The WASM primitives are replaced with deterministic counterparts: pixel
// rounding plus a JS twin of the kernel's smart_guides::snap contract
// (integer-grid rects, smallest non-zero delta, one guide per axis, guide
// extent spans the union of moving rect and matched target).
const helpers = boundary(view, 'export const forcedPixelSnap =', 'export function createBox(')
  .replaceAll('export ', '')
// Snapping lives in the production gesture helper. The move branch reaches it
// only after the layout-reorder gate, so both slices stay the code under test.
const gesture = boundary(canvas, 'function gestureVisualMatrix(', 'function placeGestureFollow(')
const moveGate = boundary(canvas, 'const layoutPointer = d.layoutPointerOrigin', 'transform = visual.matrix')
const script = stripTypeScriptTypes(`${helpers}
${gesture}
function movePointer() {
  const pointerScreen = screenPoint(e)
  let transform
  let moveGuides = {}
  setGuides(moveGuides)
${moveGate}
  transform = visual.matrix
  setGuides(moveGuides)
  return transform
}
movePointer`)

const target = (x, y, id = 'other', ancestors = []) => ({
  id, ancestors, bounds: { x, y, width: 30, height: 30 },
})
const roundRect = r => ({
  x: Math.round(r.x), y: Math.round(r.y),
  width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)),
})
// Mirrors crates/design-kernel/src/smart_guides.rs + the strict threshold
// filter in canvas-smart-guides.ts.
function smartGuidesSnapWorld(moving, parent, siblings, threshold) {
  moving = roundRect(moving)
  const targets = [parent, ...siblings].filter(Boolean).map(roundRect)
  const axis = pick => {
    let best
    for (const t of targets) {
      const lo = pick === 'x' ? t.y : t.x, hi = pick === 'x' ? t.y + t.height : t.x + t.width
      for (const position of pick === 'x'
        ? [t.x, t.x + t.width / 2, t.x + t.width]
        : [t.y, t.y + t.height / 2, t.y + t.height]) {
        for (const edge of pick === 'x'
          ? [moving.x, moving.x + moving.width / 2, moving.x + moving.width]
          : [moving.y, moving.y + moving.height / 2, moving.y + moving.height]) {
          const delta = position - edge
          if (Math.abs(delta) > threshold || Math.abs(delta) < 1e-9) continue
          if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, position, lo, hi }
        }
      }
    }
    return best
  }
  const result = { dx: 0, dy: 0, guides: [null, null] }
  for (const [slot, pick] of [[0, 'x'], [1, 'y']]) {
    const best = axis(pick)
    if (!best || Math.abs(best.delta) >= threshold) continue
    const movingLo = pick === 'x' ? moving.y : moving.x,
      movingHi = pick === 'x' ? moving.y + moving.height : moving.x + moving.width
    result.guides[slot] = {
      axis: pick, position: best.position,
      start: Math.min(movingLo, best.lo), end: Math.max(movingHi, best.hi),
    }
    if (pick === 'x') result.dx = best.delta
    else result.dy = best.delta
  }
  return result
}
function drag({ delta = { x: 10, y: 2 }, shift = true, alt = false, snap = true,
  pixels = false, kind = 'rectangle', box = { x: 100, y: 200, width: 20, height: 20 },
  entries = [], zoom = 1, reorder = false } = {}) {
  let guides, pixelCalls = 0
  const guideIndex = { current: null }
  const context = vm.createContext({
    d: { kind: 'move', start: { x: 30, y: 40 }, ids: ['selected'], box,
      moved: true, duplicating: alt, view: { zoom }, screen: { x: 0, y: 0 } },
    p: { x: 30 + delta.x, y: 40 + delta.y },
    e: { shiftKey: shift, altKey: alt }, entries, zoom, guideIndex,
    editor: { state: { snap, snapPixels: pixels, doc: { nodes: { selected: { kind } } } },
      previewLayoutOrder: () => reorder, previewFreeMove: () => {} },
    dragThresholdPassed, screenPoint: () => ({ x: 30 + delta.x, y: 40 + delta.y }),
    insideParentFrame: () => true,
    setGuides: value => { guides = { ...value } },
    translate: (x, y) => ({ x, y }),
    kernelSnapPoint: p => { pixelCalls++; return { x: Math.round(p.x), y: Math.round(p.y) } },
    smartGuidesSnapWorld, placedSmartGuides,
    releaseGuideIndex: () => { guideIndex.current = null },
    dropGestureFollow() {}, clearMoveGuides() {},
    // The native index is the only kernel call in this branch. Same contract
    // as the historical canvas twin: integer-grid rects, one guide per axis.
    createSmartGuidesIndex: (parent, siblings) => ({
      snap: (moving, threshold) => smartGuidesSnapWorld(moving, parent, siblings, threshold),
    }),
  })
  const result = vm.runInContext(script, context)()
  return { delta: result, guides, pixelCalls }
}
// Guide segments carry finite extents; position and axis are what the drag
// semantics depend on, extents only need to cover the union.
const assertGuide = (guide, axis, position) => {
  assert.equal(guide.axis, axis)
  assert.equal(guide.position, position)
  assert.ok(Number.isFinite(guide.start) && Number.isFinite(guide.end) && guide.start <= guide.end)
}

test('horizontal Shift rejects vertical correction and guide while accepting horizontal snap', () => {
  const result = drag({ entries: [target(111, 202)] })
  assert.deepEqual(result.delta, { x: 11, y: 0 })
  assertGuide(result.guides.x, 'x', 111)
  assert.equal(result.guides.y, undefined)
})

test('vertical Shift rejects horizontal correction and guide while accepting vertical snap', () => {
  const result = drag({ delta: { x: 2, y: 10 }, entries: [target(102, 211)] })
  assert.deepEqual(result.delta, { x: 0, y: 11 })
  assertGuide(result.guides.y, 'y', 211)
  assert.equal(result.guides.x, undefined)
})

for (const [label, delta, candidate, expected] of [
  ['positive tie', { x: 4, y: 4 }, target(101, 205), { x: 0, y: 5 }],
  ['signed tie', { x: 4, y: -4 }, target(101, 197), { x: 0, y: -3 }],
  ['zero movement', { x: 0, y: 0 }, target(101, 201), { x: 0, y: 1 }],
  ['negative horizontal', { x: -10, y: -2 }, target(89, 202), { x: -11, y: 0 }],
]) {
  test(`Shift retains existing dominant-axis selection for ${label}`, () => {
    const result = drag({ delta, entries: [candidate] })
    assert.deepEqual(result.delta, expected)
    assert.equal(result.guides[expected.x === 0 ? 'x' : 'y'], undefined)
  })
}

test('non-Shift retains smart snapping and guides on both axes', () => {
  const result = drag({ shift: false, delta: { x: 10, y: 10 }, entries: [target(111, 211)] })
  assert.deepEqual(result.delta, { x: 11, y: 11 })
  assertGuide(result.guides.x, 'x', 111)
  assertGuide(result.guides.y, 'y', 211)
})

test('disabled snap keeps the axis lock without guides; Alt still snaps the unlocked axis', () => {
  const off = drag({ snap: false, entries: [target(111, 202)] })
  assert.deepEqual(off.delta, { x: 10, y: 0 })
  assert.deepEqual(off.guides, { x: undefined, y: undefined })
  assert.equal(off.pixelCalls, 0)
  const alt = drag({ alt: true, entries: [target(111, 202)] })
  assert.deepEqual(alt.delta, { x: 11, y: 0 })
  assertGuide(alt.guides.x, 'x', 111)
  assert.equal(alt.pixelCalls, 0)
})

test('no candidates preserve Shift movement and unrestricted decimal movement', () => {
  assert.deepEqual(drag().delta, { x: 10, y: 0 })
  assert.deepEqual(drag({ shift: false, delta: { x: 10.25, y: 2.5 } }).delta, { x: 10.25, y: 2.5 })
})

test('optional and forced pixel snapping cannot move the locked axis from a fractional origin', () => {
  const box = { x: 100.25, y: 200.25, width: 20, height: 20 }
  for (const options of [{ pixels: true }, { kind: 'frame', alt: true }]) {
    const horizontal = drag({ ...options, box })
    assert.deepEqual(horizontal.delta, { x: 9.75, y: 0 })
    assert.equal(horizontal.pixelCalls, 1)
    const vertical = drag({ ...options, box, delta: { x: 2, y: 10 } })
    assert.deepEqual(vertical.delta, { x: 0, y: 9.75 })
    assert.equal(vertical.pixelCalls, 1)
    assert.deepEqual(drag({ ...options, box, shift: false }).delta, { x: 9.75, y: 1.75 })
  }
})

test('smart guides still suppress optional pixel rounding on an unlocked axis', () => {
  // Fractional targets round onto the kernel's integer grid first.
  const result = drag({ pixels: true, entries: [target(111.375, 202.375)] })
  assert.deepEqual(result.delta, { x: 11, y: 0 })
  assert.equal(result.guides.x.position, 111)
  assert.equal(result.guides.y, undefined)
})

test('selected objects and descendants remain excluded from snap candidates', () => {
  const result = drag({ entries: [target(111, 202, 'selected'), target(112, 203, 'child', ['selected'])] })
  assert.deepEqual(result.delta, { x: 10, y: 0 })
  assert.deepEqual(result.guides, { x: undefined, y: undefined })
})

test('smart-snap threshold remains zoom scaled and strictly exclusive', () => {
  assert.deepEqual(drag({ zoom: 6, entries: [target(111, 202)] }).delta, { x: 10, y: 0 })
  assert.deepEqual(drag({ zoom: 3, entries: [target(111, 202)] }).delta, { x: 11, y: 0 })
})

test('layout reorder continues to return before translation or snapping', () => {
  const result = drag({ reorder: true, pixels: true, entries: [target(111, 202)] })
  assert.equal(result.delta, undefined)
  assert.equal(result.pixelCalls, 0)
  assert.deepEqual(result.guides, {})
})
