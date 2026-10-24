import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { decodeScenePacket } from './scene-packet'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhxsAAAAASUVORK5CYII='

test('self-contained image bytes restore the exact legacy scene and geometry through WASM', () => {
  const document = blank(), shape = node('rectangle', .3, -.7, 43.8, 27.9)
  const image = { ...paint('#ffffff'), kind: 'image' as const, image: png }
  shape.fills = [image, { ...image, opacity: .5 }]
  shape.strokes = [{ id: 'stroke', paint: image, width: 2, align: 'center', cap: 'butt', join: 'miter', dash: '', visible: true }]
  document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    const options = { pageId: document.pages[0].id, width: 64, height: 64,
      view: { x: .125, y: -.375, zoom: 1.137 }, rasterProfile: 'figma' }
    const legacy = engine.compile_gpu_packet(JSON.stringify(options))
    const compact = engine.compile_gpu_packet(JSON.stringify({ ...options, gpuPacketImages: true }))
    expect(new DataView(compact.buffer, compact.byteOffset).getUint32(4, true)).toBe(2)
    const expected = decodeScenePacket(legacy)
    for (const pad of [0, 1, 4]) {
      const copy = new Uint8Array(compact.length + pad); copy.set(compact, pad)
      const scene = decodeScenePacket(copy.subarray(pad))
      expect(scene).toEqual(expected)
      expect(new Uint32Array((scene.vertices as Float32Array).buffer, (scene.vertices as Float32Array).byteOffset, scene.vertices.length))
        .toEqual(new Uint32Array((expected.vertices as Float32Array).buffer, (expected.vertices as Float32Array).byteOffset, expected.vertices.length))
      expect('packetImageLengths' in scene).toBe(false)
    }
    expect(() => engine.compile_gpu_packet(JSON.stringify({ ...options, gpuPacketImages: '1' }))).toThrow('policy')
  } finally { engine.free() }
})

function imagePacket(references = ['0', '1'], lengths?: unknown, raw?: Uint8Array) {
  const strings = ['原样\n"\\😀', 'data:image/png;base64,AA=='], encode = new TextEncoder()
  const parts = strings.map(s => encode.encode(s)), payload = raw || encode.encode(strings.join(''))
  const metadata = encode.encode(JSON.stringify({ version: 8, nodes: { a: {
    fills: [{ image: references[0] }], strokes: [{ paint: { image: references[1] } }],
    textureReplay: { paint: { image: references[0] } },
  } }, packetImageLengths: lengths ?? parts.map(p => p.length) }))
  const start = Math.ceil((24 + metadata.length) / 4) * 4, bytes = new Uint8Array(start + 8 + payload.length)
  const header = new DataView(bytes.buffer)
  ;[0x4b504746, 2, metadata.length, 2, 0, payload.length].forEach((v, i) => header.setUint32(i * 4, v, true))
  bytes.set(metadata, 24); header.setUint32(start, 0x80000000, true); header.setUint32(start + 4, 0x7fc00001, true)
  bytes.set(payload, start + 8)
  return bytes
}

test('image section preserves UTF-8 strings, replay paint and all geometry bits', () => {
  const scene = decodeScenePacket(imagePacket())
  expect(scene.nodes.a.fills[0].image).toBe('原样\n"\\😀')
  expect(scene.nodes.a.textureReplay!.paint.image).toBe(scene.nodes.a.fills[0].image)
  expect(scene.nodes.a.strokes[0].paint.image).toBe(png.slice(0, 22) + 'AA==')
  const values = scene.vertices as Float32Array
  expect([...new Uint32Array(values.buffer, values.byteOffset, values.length)]).toEqual([0x80000000, 0x7fc00001])
})

test('malformed image sections fail before publishing a partial scene', () => {
  for (const refs of [['2', '1'], ['01', '1'], ['-1', '1'], ['1e0', '1'], ['9007199254740992', '1']])
    expect(() => decodeScenePacket(imagePacket(refs))).toThrow('reference')
  for (const lengths of [[], [0], [-1], [1.5], [1e20], ['1']])
    expect(() => decodeScenePacket(imagePacket(undefined, lengths))).toThrow()
  expect(() => decodeScenePacket(imagePacket(['0', '0'], [1], new Uint8Array([255])))).toThrow()
  const bytes = imagePacket()
  expect(() => decodeScenePacket(bytes.subarray(0, bytes.length - 1))).toThrow('length')
})

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
