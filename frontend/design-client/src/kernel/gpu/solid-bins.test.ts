import { expect, test } from 'vitest'
import { encodeSolidBinScene } from './solid-bins'
import type { GpuNode, GpuScene } from './types'

function fixture() {
  const roots = ['red', 'blue', 'green', 'amber', 'barrier', 'after']
  const mask = { x: -3, y: 7, w: 17, h: 20 }
  const colours = ['#ff0000', '#0000ff', '#00ff00', '#aa5422', '#000000', '#fffafa']
  const nodes = Object.fromEntries(roots.map((id, index) => [id, {
    id, rect: { ...mask, x: mask.x + index, w: mask.w - index },
    opacity: 1, blend: 'normal', children: [], strokes: [], effects: [],
    fill: { rect: mask, area: { first: 0, count: 7 }, count: 3 },
    fills: [{ kind: 'solid', visible: true, color: colours[index], blend: 'normal', opacity: 1 }],
  }])) as unknown as Record<string, GpuNode>
  nodes.barrier.mask = true
  const curves = new Float32Array(28)
  curves.set([1, 0, mask.w, mask.h])
  return { roots, nodes, curves } as GpuScene
}

test('packs an ordered prefix once and leaves its mask boundary and suffix in the old graph', () => {
  const scene = fixture(), plan = encodeSolidBinScene(scene)!
  expect(plan.runs.get(scene.roots)).toEqual({ start: 0, count: 4, end: 4 })
  expect(plan.runs.get(scene.roots.slice())).toBeUndefined()
  const words = new Int32Array(plan.records.buffer)
  expect(words.length).toBe(48)
  expect([words[0], words[12], words[24], words[36]]).toEqual([-3, -2, -1, 0])
  const paints = new Float32Array(plan.records.buffer)
  expect([...paints.subarray(8, 11)]).toEqual([1, 0, 0])
  expect([...paints.subarray(20, 23)]).toEqual([0, 0, 1])
})

test.each(['mask', 'clip', 'effect', 'colour', 'unsupported coverage'])(
  'declines an uncertified run with %s', reason => {
    const scene = fixture(), first = scene.nodes.red
    if (reason === 'mask') first.maskId = 'after'
    else if (reason === 'clip') first.clip = true
    else if (reason === 'effect') first.effects = [{}] as GpuNode['effects']
    else if (reason === 'colour') scene.colors = { '#ff0000': [2, 0, 0, 1] }
    else scene.curves![0] = 3
    expect(encodeSolidBinScene(scene)).toBeUndefined()
  })
