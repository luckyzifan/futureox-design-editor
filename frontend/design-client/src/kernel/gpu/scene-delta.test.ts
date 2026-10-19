import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { SceneDeltaDecoder } from './scene-delta'
import { decodeScenePacket } from './scene-packet'

test('incremental native poses and camera changes reconstruct the full exact packet', () => {
  const doc = blank(), shape = node('ellipse', 12.25, 8.125, 42, 30)
  shape.fills = [paint('#2255aa')]; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const kernel = new VectorEngine(), decoder = new SceneDeltaDecoder()
  try {
    kernel.load_document(JSON.stringify(doc))
    const options = { pageId: doc.pages[0].id, width: 128, height: 128, view: { x: .25, y: -.125, zoom: 1.2 }, rasterProfile: 'analytic' }
    const verify = (reset: boolean) => {
      const settings = JSON.stringify(options), bytes = kernel.compile_gpu_scene_update(settings, reset)
      const actual = decoder.decode(bytes), full = decodeScenePacket(kernel.compile_gpu_packet(settings))
      expect(actual).toEqual(full)
      return { actual, bytes }
    }
    const first = verify(true), unchanged = verify(false)
    expect(unchanged.bytes.length).toBeLessThan(first.bytes.length)
    expect(unchanged.actual.curves).toBe(first.actual.curves)
    expect(unchanged.actual.nodes[shape.id]).toBe(first.actual.nodes[shape.id])
    for (const x of [.125, 1.375, -4.875]) {
      expect(kernel.apply_interaction_transforms(JSON.stringify({ [shape.id]: [1, 0, 0, 1, 12.25 + x, 8.125] }))).toBe(true)
      verify(false)
    }
    options.view.zoom = 2.125; verify(false)
    const bytes = kernel.compile_gpu_scene_update(JSON.stringify(options), false)
    const broken = bytes.slice(); broken[4] = 9
    expect(() => decoder.decode(broken)).toThrow('Unsupported')
    decoder.decode(bytes)
    expect(() => decoder.decode(bytes)).toThrow('Stale')
    verify(true)
    kernel.load_document(JSON.stringify(blank())); decoder.clear()
  } finally { kernel.free() }
})

test('updates cannot be applied without their base, including after a decoder reset', () => {
  const kernel = new VectorEngine(), decoder = new SceneDeltaDecoder(), doc = blank()
  try {
    kernel.load_document(JSON.stringify(doc))
    const options = JSON.stringify({ pageId: doc.pages[0].id, width: 32, height: 32, view: {x:0,y:0,zoom:1} })
    decoder.decode(kernel.compile_gpu_scene_update(options, true))
    const delta = kernel.compile_gpu_scene_update(options, false)
    decoder.clear(); expect(() => decoder.decode(delta)).toThrow('Stale')
    expect(() => decoder.decode(kernel.compile_gpu_scene_update(options, true))).not.toThrow()
  } finally { kernel.free() }
})
