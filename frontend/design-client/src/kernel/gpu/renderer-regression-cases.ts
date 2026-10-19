/** Shared unit cases for Vitest and the dependency-free Node boundary runner.
 * The production renderer executes unchanged; the driver records resource and
 * render-graph operations. These are not GPU pixel-fidelity/screenshot tests. */
import assert from 'node:assert/strict'
import type { GpuRenderer, ManagedImageLoader } from './renderer'
import type { Driver, GpuNode, GpuScene, Rect, Texture } from './types'

type Register = (name: string, body: () => void | Promise<void>) => unknown
type Renderer = typeof GpuRenderer
const imageA = 'data:image/png;base64,AAAA'
const imageB = 'data:image/png;base64,BBBB'
const fill = (image?: string) => ({ id: 'paint', kind: image ? 'image' : 'solid', visible: true,
  color: '#235fa0', opacity: 1, blend: 'normal', angle: 0, fit: 'stretch', stops: [], image })

function recordingDriver(managed = false) {
  const live = new Set<Texture>(), destroyed: Texture[] = [], masks: Rect[] = []
  const uploads: { width: number; height: number }[] = [], paints: number[] = []
  const allocate = (width: number, height: number): Texture => {
    const texture = { width, height, bytes: width * height * (managed ? 16 : 4), resource: {} as GPUTexture }
    live.add(texture)
    return texture
  }
  const driver = {
    name: 'webgpu', managed, scratchBytes: 0, lost: false, description: 'unit resource recorder',
    drawCalls: 0, triangles: 0, begin() {},
    create: allocate,
    clear(texture: Texture) { assert.ok(live.has(texture)) },
    mask(path: { rect: Rect }, target: Texture) { assert.ok(live.has(target)); masks.push({ ...path.rect }) },
    pass(target: Texture, uniforms: Float32Array, inputs: Texture[]) {
      assert.ok(live.has(target)); inputs.forEach(texture => assert.ok(live.has(texture)))
      paints.push(uniforms[16])
    },
    over(target: Texture, _uniforms: Float32Array, inputs: Texture[]) {
      assert.ok(live.has(target)); inputs.forEach(texture => assert.ok(live.has(texture)))
    },
    uploadRgba8(_bytes: Uint8Array, width: number, height: number) {
      uploads.push({ width, height }); return allocate(width, height)
    },
    uploadLinear(_values: Float32Array, width: number, height: number) {
      uploads.push({ width, height }); return allocate(width, height)
    },
    uploadAtlasRgba8(target: Texture) { assert.ok(live.has(target)) },
    uploadAtlasLinear(target: Texture) { assert.ok(live.has(target)) },
    destroy(texture: Texture) {
      assert.ok(live.delete(texture), 'physical textures must be destroyed exactly once')
      destroyed.push(texture)
    },
    async finish() { return {} },
    async checkpoint() {},
    dispose() { live.clear() },
  } as unknown as Driver
  return { driver, live, destroyed, masks, uploads, paints }
}

function scene(view: { x: number; y: number; zoom: number }, output: Rect, images: string[] = [], nested = false): GpuScene {
  const nodeRect = { x: output.x + 40, y: output.y + 20, w: 50, h: 30 }
  const node = (id: string, image?: string): GpuNode => ({
    id, rect: nodeRect, matrix: [view.zoom, 0, 0, view.zoom, view.x, view.y],
    inverse: [1 / view.zoom, 0, 0, 1 / view.zoom, -view.x / view.zoom, -view.y / view.zoom],
    size: [50 / view.zoom, 30 / view.zoom], fill: { rect: nodeRect, first: 0, count: 3, rule: 'nonzero' },
    fills: [fill(image) as GpuNode['fills'][number]], strokes: [], children: [],
    mask: false, clip: false, opacity: 1, blend: 'normal', effects: [],
  })
  const nodes: Record<string, GpuNode> = images.length ? Object.fromEntries(images.map((uri, i) => [`image${i}`, node(`image${i}`, uri)])) : { leaf: node('leaf') }
  let roots = Object.keys(nodes)
  if (nested) {
    nodes.group = { ...node('group'), fills: [], children: roots }
    roots = ['group']
  }
  return { version: 8, width: output.w, height: output.h, output, extent: output,
    view, nodes, roots, vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
    transparent: false, background: '#ffffff', grid: false }
}

export function highZoomRegressions(test: Register, Renderer: Renderer) {
  for (const zoom of [2.99, 3, 32, 64]) for (const translated of [false, true]) {
    test(`compiled global-raster nodes survive zoom ${zoom} with ${translated ? 'translated' : 'origin'} tiles`, async () => {
      const mock = recordingDriver(), renderer = new Renderer(mock.driver, false)
      const output = { x: translated ? 640 : 0, y: translated ? -900 : 0, w: 128, h: 128 }
      const view = { x: translated ? -4000 : 0, y: translated ? 2000 : 0, zoom }
      try {
        const input = scene(view, output, [], true)
        await renderer.render(input)
        assert.ok(mock.masks.some(rect => rect.x === output.x + 40 && rect.y === output.y + 20),
          'the real render graph must reach the visible leaf mask')
        assert.ok(mock.paints.includes(2), 'the real render graph must paint foreground content')
      } finally { renderer.dispose() }
      assert.equal(mock.live.size, 0)
    })
  }
  test('image selection with mips disabled stays at level zero at every zoom', () => {
    const mock = recordingDriver(), renderer = new Renderer(mock.driver) as any
    const input = scene({ x: -4000, y: 2000, zoom: 32 }, { x: 640, y: -900, w: 128, h: 128 }, [imageA])
    renderer.scene = input
    assert.equal(renderer.imageLevel(input.nodes.image0, input.nodes.image0.fills[0]), 0)
    renderer.dispose()
  })
}

export function imageResourceRegressions(test: Register, Renderer: Renderer) {
  for (const mips of [false, true]) for (const managed of [false, true]) {
    test(`image admission preserves demanded source quality (mips=${mips}, float=${managed})`, () => {
      const mock = recordingDriver(managed), levels: number[] = []
      const loader: ManagedImageLoader = (_uri, byte, level = 0) => {
        levels.push(level)
        if (level > 0 && !mips) throw Error('Image mip levels are disabled')
        const side = 64 >> level
        return { width: side, height: side, pixels: byte ? new Float32Array() : new Float32Array(side * side * 4),
          bytes: byte ? new Uint8Array(side * side * 4) : undefined }
      }
      const renderer = new Renderer(mock.driver, true, true, loader, mips) as any
      renderer.scene = { floatCompositing: managed }
      const demanded = mips ? 1 : 0, side = 64 >> demanded, bytes = side * side * (managed ? 16 : 4)
      renderer.frameBudget = bytes - 1
      try {
        assert.throws(() => renderer.imageFor(imageA, demanded, false), /GPU (?:浮点图片内存|图片总内存)预算超限/)
        assert.deepEqual(levels, [demanded], 'do not retry an unrequested coarser mip')
        assert.deepEqual(mock.uploads, [])
        renderer.frameBudget = bytes
        const admitted = renderer.imageFor(imageA, demanded, false)
        assert.equal(admitted.texture.width, side)
        assert.equal(admitted.texture.height, side)
        assert.deepEqual(mock.uploads, [{ width: side, height: side }])
      } finally { renderer.dispose() }
    })
  }
  for (const mips of [false, true]) test(`real paint preserves source fidelity under pressure (mips=${mips})`, () => {
    const mock = recordingDriver(), levels: number[] = []
    const renderer = new Renderer(mock.driver, true, true, (_uri, _byte, level = 0) => {
      levels.push(level)
      if (level > 0 && !mips) throw Error('Image mip levels are disabled')
      const side = 64 >> level
      return { width: side, height: side, pixels: new Float32Array(), bytes: new Uint8Array(side * side * 4) }
    }, mips) as any
    const input = scene({ x: 0, y: 0, zoom: 32 }, { x: 0, y: 0, w: 128, h: 128 }, [imageA])
    renderer.scene = input; renderer.frameBudget = 4096
    // Isolate geometric selection/encoding boundaries. The selected source is
    // level zero; level one could fit, but its pixels are not equivalent.
    renderer.imageLevel = () => 0
    renderer.run = () => { throw Error('A degraded source reached paint encoding') }
    try {
      assert.throws(() => renderer.paint(input.nodes.image0, input.nodes.image0.fills[0], {}), /GPU 图片总内存预算超限/)
      assert.deepEqual(levels, [0])
      assert.equal(mock.paints.length, 0)
    } finally { renderer.dispose() }
  })
  test('current image survives unrelated resource touches and is uploaded only once', async () => {
    const mock = recordingDriver(), levels: number[] = []
    const renderer = new Renderer(mock.driver, true, true, (_uri, _byte, level = 0) => {
      levels.push(level)
      return { width: 4, height: 4, pixels: new Float32Array(), bytes: new Uint8Array(64) }
    }) as any
    const input = scene({ x: 0, y: 0, zoom: 32 }, { x: 0, y: 0, w: 128, h: 128 }, [imageA])
    renderer.scene = input
    try {
      const first = renderer.imageFor(imageA)
      for (let i = 0; i < 100; i++) renderer.touch({})
      await renderer.loadImages(input)
      assert.equal(renderer.imageFor(imageA), first)
      assert.equal(mock.destroyed.length, 0)
      assert.equal(mock.uploads.length, 1)
      assert.deepEqual(levels, [0])
      await renderer.loadImages(scene(input.view, input.output!, []))
      assert.deepEqual(mock.destroyed, [first.texture])
      assert.equal(renderer.bytes, 0)
    } finally { renderer.dispose() }
  })
  test('atlas cleanup retains shared pages and retires each physical allocation once', async () => {
    const mock = recordingDriver()
    const renderer = new Renderer(mock.driver, true, true, () => ({ width: 4, height: 4,
      pixels: new Float32Array(), bytes: new Uint8Array(64) }), false, true) as any
    const input = scene({ x: 0, y: 0, zoom: 32 }, { x: 0, y: 0, w: 128, h: 128 }, [imageA, imageB])
    renderer.scene = input
    try {
      const a = renderer.imageFor(imageA, 0, true), b = renderer.imageFor(imageB, 0, true)
      assert.equal(a.texture, b.texture)
      const bytes = a.texture.bytes
      assert.equal(renderer.bytes, bytes)
      for (let i = 0; i < 100; i++) renderer.touch({})
      await renderer.loadImages(scene(input.view, input.output!, [imageB]))
      assert.equal(mock.destroyed.length, 0)
      assert.equal(renderer.imageFor(imageB, 0, true), b)
      assert.ok(mock.live.has(b.texture))
      assert.equal(renderer.bytes, bytes)
      assert.equal(renderer.atlasPages.length, 1)
      await renderer.loadImages(scene(input.view, input.output!, []))
      assert.deepEqual(mock.destroyed, [a.texture])
      assert.equal(renderer.atlasPages.length, 0)
      assert.equal(renderer.images.size, 0)
      assert.equal(renderer.imageOrigins.size, 0)
      assert.equal(renderer.bytes, 0)
      await renderer.loadImages(scene(input.view, input.output!, []))
      assert.equal(mock.destroyed.length, 1)
    } finally { renderer.dispose() }
  })
}
