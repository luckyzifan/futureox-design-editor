import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { decodeScenePacket } from './scene-packet'

test('packet geometry matches the established JSON compiler, including sliced buffers', () => {
  const document = blank(), shape = node('ellipse', 0.3, 0.7, 43.8, 27.9)
  shape.fills = [paint('#3377ee')]; document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    const options = JSON.stringify({ pageId: document.pages[0].id, width: 64, height: 64,
      view: { x: 0.125, y: -0.375, zoom: 1.137 }, rasterProfile: 'figma' })
    const json = JSON.parse(engine.compile_gpu(options)), packet = engine.compile_gpu_packet(options)
    for (const pad of [0, 1, 4]) {
      const buffer = new Uint8Array(packet.length + pad); buffer.set(packet, pad)
      const scene = decodeScenePacket(buffer.subarray(pad))
      expect(scene.vertices).toEqual(new Float32Array(json.vertices))
      expect(scene.curves).toEqual(new Float32Array(json.curves))
      expect({ ...scene, vertices: [], curves: [] }).toEqual({ ...json, vertices: [], curves: [] })
    }
    expect(() => decodeScenePacket(packet.subarray(0, packet.length - 1))).toThrow('length')
    const corrupt = packet.slice(); corrupt[4] = 2
    expect(() => decodeScenePacket(corrupt)).toThrow('Unsupported')
  } finally { engine.free() }
})
