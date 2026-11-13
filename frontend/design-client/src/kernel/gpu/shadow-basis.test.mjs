// CPU command-graph check for issue #177. No WebGPU device, shader execution,
// or claim that these passes match a Sketch CLI or Metal readback.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { loadRendererTestModule } from './renderer-test-types.mjs'

const rendererUrl = new URL('./renderer.ts', import.meta.url)
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(ts|mjs)$/.test(name)) out.push(path)
  }
  return out
}
const kernelNames = new Set()
for (const path of files(new URL('..', import.meta.url).pathname)) {
  const source = readFileSync(path, 'utf8')
  for (const match of source.matchAll(/(?:import|export)\s*\{([^}]+)\}\s*from\s*['"][^'"]*generated\/design-kernel\/design_kernel['"]/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name) kernelNames.add(name)
    }
  }
}
const kernelSource = [...kernelNames].map(name => name.endsWith('Builder')
  ? `export class ${name} {}`
  : `export function ${name}(){ return new Uint8Array(16) }`).join('\n')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes('generated/design-kernel/design_kernel'))
      return { url: 'shadow-basis-test:kernel', shortCircuit: true }
    if (context.parentURL === rendererUrl.href && specifier === '../../geometry')
      return { url: 'shadow-basis-test:geometry', shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'shadow-basis-test:kernel')
      return { format: 'module', shortCircuit: true, source: kernelSource }
    if (url === 'shadow-basis-test:geometry')
      return { format: 'module', shortCircuit: true, source: 'export function inverse(){ throw Error("geometry") }' }
    return loadRendererTestModule(url, context, next)
  },
})
const { GpuRenderer } = await import('./renderer.ts')
hooks.deregister()

const effect = (kind, extra = {}) => ({ id: kind, kind, visible: true, radius: 0,
  x: 0, y: 0, spread: 0, color: '#235fa0', opacity: .5, amount: 0, ...extra })
function node(effects) {
  const rect = { x: -32, y: 48, w: 16, h: 16 }
  return { id: 'leaf', rect, matrix: [2, 0, 0, 2, 7, -3], inverse: [.5, 0, 0, .5, -3.5, 1.5],
    size: [8, 8], fill: { rect, first: 0, count: 3, rule: 'nonzero' },
    fills: [], strokes: [], children: [], mask: false, clip: false, opacity: 1, blend: 'normal', effects }
}
function scene(n) {
  return { version: 8, width: 16, height: 16, output: n.rect, extent: n.rect,
    floatCompositing: true, coherentSamples: true, integratedBlur: true,
    background: '#ffffff', transparent: false, grid: false, view: { x: 0, y: 0, zoom: 2 },
    roots: [n.id], nodes: { [n.id]: n }, vertices: new Float32Array(6) }
}
function recorder() {
  const live = new Set(), pending = new Set(), values = new Map(), passes = []
  let bytes = 0, nextId = 0
  const create = (width, height, channels = 4) => {
    const texture = { width, height, bytes: width * height * channels * 4, resource: {}, id: nextId++ }
    live.add(texture); bytes += texture.bytes
    return texture
  }
  const driver = {
    name: 'webgpu', managed: true, scratchBytes: 0, lost: false, drawCalls: 0, triangles: 0,
    description: 'CPU-only shadow command recorder', canvas: {},
    begin() {}, create,
    clear(target) { assert.ok(live.has(target)); pending.add(target); values.set(target, { clear: true }) },
    pass(target, uniforms, inputs) {
      assert.ok(live.has(target)); assert.ok(!inputs.includes(target))
      for (const input of inputs) assert.ok(live.has(input) && values.has(input))
      const expression = { mode: uniforms[16], inputs: inputs.map(input => values.get(input)) }
      passes.push({ expression })
      values.set(target, expression)
      pending.add(target)
      for (const input of inputs) pending.add(input)
    },
    async checkpoint() { pending.clear() },
    destroy(texture) {
      assert.ok(!pending.has(texture))
      assert.ok(live.delete(texture)); bytes -= texture.bytes; values.delete(texture)
    },
    dispose() { pending.clear(); for (const texture of [...live]) this.destroy(texture) },
  }
  return { driver, live, values, passes, get bytes() { return bytes } }
}
function setup(effects) {
  const rec = recorder(), renderer = new GpuRenderer(rec.driver, true, false, undefined, false, false, 256)
  const n = node(effects)
  renderer.scene = scene(n)
  const planes = [0, 1, 2, 3].map(sample => {
    const plane = renderer.acquire(n.rect)
    rec.values.set(plane.texture, { sample })
    return plane
  })
  return { rec, renderer, n, planes }
}
function assertPool(renderer) {
  const pooled = [...renderer.free.values()].flat()
  assert.equal(new Set(pooled).size, pooled.length)
  for (const texture of pooled) assert.equal(renderer.busy.has(texture), false)
}
async function dispose(h) {
  await h.rec.driver.checkpoint()
  h.renderer.dispose()
  assert.equal(h.rec.bytes, 0)
  assert.equal(h.rec.live.size, 0)
}
const shadowsOf = (h, mode) => h.rec.passes.filter(pass => pass.expression.mode === mode)

test('one shadow still reads that sample and does not keep a second silhouette', async () => {
  const h = setup([effect('shadow', { x: 4, y: 2 })])
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    assert.equal(h.rec.passes.filter(pass => pass.expression.mode === 23).length, 1)
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 4)
    for (let i = 0; i < 4; i++) assert.deepEqual(shadows[i].expression.inputs, [original[i], original[i]])
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('glass between shadows does not start a new silhouette', async () => {
  const h = setup([effect('shadow'), effect('glass'), effect('shadow', { x: 1 })])
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 8)
    for (let i = 0; i < 4; i++) assert.equal(shadows[i + 4].expression.inputs[1], original[i])
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('two drop shadows sample the silhouette from before either shadow', async () => {
  const h = setup([effect('shadow', { x: 4, y: 6 }), effect('shadow', { x: 8, y: 2 })])
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    const resolves = h.rec.passes.filter(pass => pass.expression.mode === 23)
    assert.equal(resolves.length, 2)
    for (const resolve of resolves) assert.deepEqual(resolve.expression.inputs, original)
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 8)
    for (let i = 0; i < 4; i++) {
      assert.equal(shadows[i + 4].expression.inputs[1], original[i])
      assert.notEqual(shadows[i + 4].expression.inputs[0], original[i])
    }
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('two inner shadows read silhouette alpha, then composite onto the running result', async () => {
  const h = setup([effect('inner-shadow'), effect('inner-shadow', { x: 3, y: 1 })])
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 8)
    for (let i = 0; i < 4; i++) assert.deepEqual(shadows[i + 4].expression.inputs, [original[i], original[i]])
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('a no-op blur between shadows starts a new chain on the current composite', async () => {
  const h = setup([effect('shadow'), effect('blur'), effect('shadow', { x: 1 })])
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 8)
    for (let i = 0; i < 4; i++) {
      assert.equal(shadows[i].expression.inputs[1], original[i])
      assert.equal(shadows[i + 4].expression.inputs[0], shadows[i + 4].expression.inputs[1])
      assert.notEqual(shadows[i + 4].expression.inputs[1], original[i])
    }
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('exact shadow-over still feeds the second drop shadow the pre-shadow alpha', async () => {
  const h = setup([effect('shadow', { x: 4, y: 6 }), effect('shadow', { x: 2, y: 1 })])
  h.rec.driver.exactShadowOver = true
  try {
    const original = h.planes.map(plane => h.rec.values.get(plane.texture))
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    const shadows = shadowsOf(h, 50)
    assert.equal(shadows.length, 8)
    assert.equal(shadowsOf(h, 6).length, 0)
    for (let i = 0; i < 4; i++) {
      assert.equal(shadows[i + 4].expression.inputs[1], original[i])
      assert.notEqual(shadows[i + 4].expression.inputs[0], original[i])
    }
    h.renderer.release(...output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('the single-plane painter blurs the pre-shadow layer for every later drop shadow', async () => {
  const h = setup([effect('shadow', { x: 4, y: 2 }), effect('shadow', { x: 1, y: 3 })])
  const backdrop = h.renderer.acquire(h.n.rect)
  h.rec.values.set(backdrop.texture, { backdrop: true })
  h.renderer.release(...h.planes)
  try {
    const output = await h.renderer.node(h.n.id, backdrop)
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 2)
    const silhouette = shadows[0].expression.inputs[1]
    assert.equal(shadows[0].expression.inputs[0], silhouette)
    assert.equal(shadows[1].expression.inputs[1], silhouette)
    assert.notEqual(shadows[1].expression.inputs[0], silhouette)
    h.renderer.release(output, backdrop)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('analytic shadow stages keep filtering the pre-shadow silhouette', async () => {
  const h = setup([effect('shadow'), effect('shadow', { x: 2, y: 1 })])
  const filtered = []
  h.renderer.filterBoxRegion = async input => {
    filtered.push(h.rec.values.get(input.texture))
    return input
  }
  const stage = { output: h.n.rect, filter: { input: h.n.rect, output: h.n.rect, axes: [] } }
  h.n.analyticRegion = { output: h.n.rect, effects: [stage, stage] }
  const layer = h.renderer.acquire(h.n.rect)
  h.rec.values.set(layer.texture, { silhouette: true })
  h.renderer.release(...h.planes)
  try {
    const output = await h.renderer.applyAnalyticEffects(h.n, layer)
    assert.deepEqual(filtered.map(value => value.silhouette), [true, true])
    const shadows = shadowsOf(h, 6)
    assert.equal(shadows.length, 2)
    assert.equal(shadows[1].expression.inputs[1].silhouette, true)
    h.renderer.release(output)
    assert.equal(h.renderer.busy.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})
