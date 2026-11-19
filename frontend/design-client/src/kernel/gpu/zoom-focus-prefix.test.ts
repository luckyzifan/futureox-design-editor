import { describe, expect, it } from 'vitest'
import { paint } from '../../model'
import { focusClipCovers, focusPrefixWitness, sameFocusPrefix, snapshotFocusPrefix } from './zoom-focus-prefix'
import { type GpuNode, type GpuScene, type PathMesh, type Rect } from './types'

const viewport = { x: 10, y: 20, w: 4, h: 3 }

function rectangle(bounds: Rect, rightFraction = 1) {
  return new Float32Array([
    1, 0, bounds.w, bounds.h,
    0, bounds.w - 1, 0, rightFraction,
    0, bounds.h - 1, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ])
}

function path(bounds: Rect, count = 7): PathMesh {
  return { rect: bounds, first: 0, count: 1, rule: 'nonzero', area: { first: 0, count } }
}

function node(id: string, bounds: Rect, fill: PathMesh): GpuNode {
  return { id, rect: bounds, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [4, 3],
    fill, fills: [], strokes: [], children: [], mask: false, clip: true, opacity: 1, blend: 'normal', effects: [] }
}

function stage(bounds: Rect, curves = rectangle(bounds)) {
  const fill = path(bounds, curves.length / 4)
  const root = node('board', bounds, fill), a = node('a', bounds, fill), b = node('b', bounds, fill)
  const scene: GpuScene = {
    version: 8, width: viewport.w, height: viewport.h, output: viewport, extent: bounds,
    background: '#ffffff', transparent: false, grid: false, roots: ['board'], vertices: [],
    nodes: { board: root, a, b }, curves, view: { x: 0, y: 0, zoom: 128 }, floatCompositing: true,
  }
  const witness = () => focusPrefixWitness(scene, root, ['a', 'b'], viewport, () => true)
  return { scene, a, b, witness }
}

function intervals(bounds: Rect) {
  const rows = bounds.h * 8
  const data = new Float32Array((1 + rows * 4) * 4)
  data.set([0, 1, bounds.w, bounds.h])
  for (let i = 0; i < rows; i++) {
    const span = 1 + rows + i * 3
    data.set([span, 1, 0, 0], (1 + i) * 4)
    data.set([0, bounds.w - 1, 0, 1], span * 4)
  }
  return data
}

describe('zoom focus prefix coverage', () => {
  it('accepts a larger capture with the same viewport pixel coverage', () => {
    const expanded = { ...viewport, y: viewport.y - 2, h: viewport.h + 5 }
    const full = stage(expanded)
    const visible = stage(viewport)
    expect(focusClipCovers(path(expanded), full.scene.curves, viewport)).toBe(true)
    expect(sameFocusPrefix(full.witness()!, visible.witness()!)).toBe(true)
  })

  it('compares contributing scanline spans across different row addresses', () => {
    const expanded = { ...viewport, y: viewport.y - 1, h: viewport.h + 2 }
    const full = stage(expanded, intervals(expanded)), clip = stage(viewport, intervals(viewport))
    const saved = snapshotFocusPrefix(full.witness()!)
    expect(sameFocusPrefix(saved, clip.witness()!)).toBe(true)
    const curves = clip.scene.curves as Float32Array
    curves[curves[4] * 4 + 3] = 0.5
    expect(sameFocusPrefix(saved, clip.witness()!)).toBe(false)
  })

  it('rejects a partial clip or a changed static painter', () => {
    const full = stage(viewport), partial = stage(viewport, rectangle(viewport, 0.5))
    expect(focusClipCovers(path(viewport), partial.scene.curves, viewport)).toBe(false)
    expect(sameFocusPrefix(full.witness()!, partial.witness()!)).toBe(false)
    const saved = full.witness()!
    full.b.opacity = 0.5
    expect(sameFocusPrefix(saved, full.witness()!)).toBe(false)
    full.b.passthrough = true
    expect(full.witness()).toBeUndefined()
  })

  it('keeps the original resolved colors across a palette replacement', () => {
    const { a, scene, witness } = stage(viewport)
    a.fills.push(paint('#00ff00'))
    scene.colors = { '#00ff00': [0, 1, 0, 1] }
    const saved = witness()!
    scene.colors['#00ff00'][1] = 0.75
    expect(sameFocusPrefix(saved, witness()!)).toBe(false)
  })
})
