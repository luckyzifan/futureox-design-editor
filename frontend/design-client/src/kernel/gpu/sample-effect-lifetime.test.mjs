// CPU-only resource/command regression for the actual production renderer.
// Textures and WASM coordinate fields below are metadata-only: no giant pixel
// arrays, GPU, shader execution, or claim of visual/pixel-fidelity validation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import {loadRendererTestModule} from './renderer-test-types.mjs'
import {rendererKernelStubNames} from './renderer-test-plan.mjs'

const rendererUrl = new URL('./renderer.ts', import.meta.url)
const boundaries = {
  // The production materialField still checks layout, charges the full byte
  // cost and uploads to the driver. Only coordinate generation is a fixture.
  texture_sampling_grid: 'r => { const {w,h}=JSON.parse(r); return {length:w*h*4,byteLength:w*h*16} }',
  texture_material_field: 'r => { const {w,h}=JSON.parse(r); return {length:w*h*4,byteLength:w*h*16} }',
  // Small coefficient fixtures allow command-graph tests of unchanged blur;
  // they do not attempt to validate the WASM coefficient values.
  rational_tent_kernel_rgba: '() => new Uint8Array(16)',
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/generated/design-kernel/design_kernel'))
      return { url: 'sample-effect-test:kernel', shortCircuit: true }
    if (context.parentURL === rendererUrl.href && specifier === '../../geometry')
      return { url: 'sample-effect-test:geometry', shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'sample-effect-test:kernel') return { format: 'module', shortCircuit: true,
      source: rendererKernelStubNames.map(name => boundaries[name]
        ? `export const ${name} = ${boundaries[name]};`
        : `export function ${name}(){ throw Error('Unexpected WASM boundary: ${name}') }`).join('\n')+
        '\nexport {compiled_scene_plan_json} from '+JSON.stringify(new URL('./renderer-test-plan.mjs',import.meta.url).href) }
    if (url === 'sample-effect-test:geometry') return { format: 'module', shortCircuit: true,
      source: "export function inverse(){ throw Error('Unexpected geometry boundary') }" }
    return loadRendererTestModule(url, context, next)
  },
})
let GpuRenderer
try { ({ GpuRenderer } = await import('./renderer.ts')) }
finally { hooks.deregister() }

const MiB = 1024 * 1024
const effect = (kind, extra = {}) => ({ id: kind, kind, visible: true, radius: 2,
  x: 0, y: 0, spread: 0, color: '#235fa0', opacity: .625, amount: .375, ...extra })
function node(side, effects) {
  const rect = { x: -32, y: 48, w: side, h: side }
  return { id: 'leaf', rect, matrix: [2, 0, 0, 2, 7, -3], inverse: [.5, 0, 0, .5, -3.5, 1.5],
    size: [side / 2, side / 2], fill: { rect, first: 0, count: 3, rule: 'nonzero' },
    fills: [], strokes: [], children: [], mask: false, clip: false, opacity: 1, blend: 'normal', effects }
}
function scene(n) {
  return { version: 8, width: n.rect.w, height: n.rect.h, output: n.rect, extent: n.rect,
    floatCompositing: true, coherentSamples: true, integratedBlur: true,
    background: '#ffffff', transparent: false, grid: false, view: { x: 7, y: -3, zoom: 2 },
    roots: [n.id], nodes: { [n.id]: n }, vertices: new Float32Array([0, 0, 1, 0, 0, 1]) }
}
function recorder({ managed = true, captureDisplay = false } = {}) {
  const live = new Set(), pending = new Set(), values = new Map(), passes = [], allocations = []
  let bytes = 0, peak = 0, effectCount = 0, failAt = 0, nextId = 0, checkpoints = 0
  function create(width, height, channels = managed ? 4 : 1) {
    const texture = { width, height, bytes: width * height * channels * 4, resource: {}, id: nextId++ }
    live.add(texture); allocations.push(texture); bytes += texture.bytes; peak = Math.max(peak, bytes)
    return texture
  }
  const driver = {
    name: 'webgpu', managed, captureDisplay, scratchBytes: 0, lost: false, drawCalls: 0, triangles: 0,
    description: 'CPU-only RGBA32F command/ownership recorder', canvas: {},
    begin() { pending.clear() },
    create,
    createScalarCoverage(w, h) { const texture = create(w, h, 1); texture.scalarCoverage = true; return texture },
    clear(target) { assert.ok(live.has(target)); pending.add(target); values.set(target, { clear: true }) },
    mask(_path, target, sample) { assert.ok(live.has(target)); pending.add(target); values.set(target, { mask: sample }) },
    uploadLinear(data, w, h) {
      assert.equal(data.length, w * h * 4); assert.equal(data.byteLength, w * h * 16)
      const texture = create(w, h, 4); values.set(texture, { field: [w, h] }); return texture
    },
    uploadParameters(data, w, h) { return this.uploadLinear(data, w, h) },
    uploadRgba8(data, w, h) {
      assert.equal(data.length, w * h * 4)
      const texture = create(w, h); values.set(texture, { coefficients: Array.from(data) }); return texture
    },
    pass(target, uniforms, inputs, region, channels, filter, clearOutside) {
      assert.ok(live.has(target)); assert.ok(!inputs.includes(target), 'never sample the render target')
      for (const input of inputs) assert.ok(live.has(input), 'no destroyed input may be encoded')
      if ((uniforms[16] === 7 || uniforms[16] === 8) && ++effectCount === failAt)
        throw Error('Injected effect encoding failure')
      // Snapshot semantic inputs now. A later reuse of the physical texture is
      // queue-ordered and must not retroactively change these encoded reads.
      const expression = { mode: uniforms[16], uniforms: Array.from(uniforms),
        inputs: inputs.map(input => { assert.ok(values.has(input)); return values.get(input) }),
        size: [target.width, target.height], region, channels, filter, clearOutside }
      passes.push({ target, inputs: [...inputs], expression })
      values.set(target, expression)
      for (const texture of [target, ...inputs]) pending.add(texture)
      this.drawCalls++
    },
    over(target, uniforms, inputs, region) { this.pass(target, uniforms, inputs, region) },
    async checkpoint() { checkpoints++; pending.clear() },
    async finish() { pending.clear(); return {} },
    destroy(texture) {
      assert.ok(!pending.has(texture), 'destruction requires completion, unlike queue-ordered pool reuse')
      assert.ok(live.delete(texture), 'destroy exactly once'); bytes -= texture.bytes; values.delete(texture)
    },
    dispose() { pending.clear(); for (const texture of [...live]) this.destroy(texture) },
  }
  return { driver, live, values, passes, allocations, get bytes() { return bytes }, get peak() { return peak },
    get checkpoints() { return checkpoints }, failOnEffect(n) { failAt = n; effectCount = 0 } }
}
function setup(effects, side = 16, pattern = [0, 1, 2, 3]) {
  const rec = recorder(), renderer = new GpuRenderer(rec.driver, true, false, undefined, false, false, 256), n = node(side, effects)
  renderer.scene = scene(n)
  const sources = new Map(), planes = pattern.map(i => {
    if (sources.has(i)) return renderer.retain(sources.get(i))
    const plane = renderer.acquire(n.rect); sources.set(i, plane)
    rec.values.set(plane.texture, { sample: i }); return plane
  })
  return { rec, renderer, n, planes, sources }
}
function assertPool(renderer) {
  const pooled = [...renderer.free.values()].flat()
  assert.equal(new Set(pooled).size, pooled.length, 'pool must not contain duplicate physical resources')
  for (const texture of pooled) assert.ok(!renderer.busy.has(texture), 'live and reusable ownership must be disjoint')
}
async function dispose(h) {
  await h.rec.driver.checkpoint(); h.renderer.dispose(); assert.equal(h.rec.bytes, 0); assert.equal(h.rec.live.size, 0)
}
// Frozen pre-fix noise/texture scheduling reference. All allocation, uniforms,
// coordinate fields and pass encoding still use production renderer methods.
async function legacyNoiseTexture(renderer, n, planes) {
  for (const fx of n.effects) {
    await renderer.reclaimScratch()
    const resolved = renderer.run(23, n.rect, planes)
    const shared = new Map(), addresses = renderer.textureGrid(n, fx)
    const outputs = planes.map(plane => {
      let next = shared.get(plane.texture)
      if (!next) {
        next = renderer.run(fx.kind === 'noise' ? 7 : 8, n.rect, addresses ? [plane, addresses] : [plane], u => {
          renderer.transform(u, n)
          u.set([fx.kind === 'noise' ? fx.amount : fx.amount * fx.opacity * 2,
            fx.opacity, fx.texture ? 1 : 0, fx.texture?.clipToShape ? 1 : 0], 40)
        })
        shared.set(plane.texture, next)
      } else next = renderer.retain(next)
      return next
    })
    renderer.release(...planes, resolved); planes = outputs
  }
  return planes
}
const material = effect('texture', { texture: { noiseSize: [8, 12], clipToShape: true } })
for (const fx of [effect('noise'), effect('texture'), material]) {
  const label = fx.texture ? 'material texture' : fx.kind
  test(`${label}: real 1536² RGBA32F effects fit the unchanged 256 MiB budget`, async () => {
    const current = setup([fx], 1536), legacy = setup([fx], 1536), reference = setup([fx], 1536)
    try {
      assert.equal(current.renderer.memoryPolicy().workingBudgetBytes, 256 * MiB)
      await assert.rejects(legacyNoiseTexture(legacy.renderer, legacy.n, legacy.planes), /GPU 表面内存预算超限/)
      // Reference-only headroom measures the old peak; the production renderer
      // above and below keeps this explicit 256 MiB pressure fixture.
      reference.renderer.frameBudget = 512 * MiB
      const old = await legacyNoiseTexture(reference.renderer, reference.n, reference.planes)
      const output = await current.renderer.applySampleEffects(current.n, current.planes, {})
      assert.deepEqual(output.map(p => current.rec.values.get(p.texture)), old.map(p => reference.rec.values.get(p.texture)))
      const fullPlane = 1536 * 1536 * 16, field = fx.kind === 'texture' ? 1 : 0
      assert.equal(reference.rec.peak, (9 + field) * fullPlane)
      assert.equal(current.rec.peak, (5 + field) * fullPlane)
      assert.equal(current.rec.passes.filter(p => p.expression.mode === 23).length, 0, 'no unused resolve')
      assert.equal(current.rec.passes.length, 4, 'all four sample effects are still encoded')
      assert.equal(current.rec.checkpoints, 0, 'no checkpoint may retire a live coordinate field inside this loop')
      assert.equal(current.renderer.memoryPolicy().workingBudgetBytes, 256 * MiB)
      assert.equal(current.renderer.bytes, current.rec.bytes)
      assertPool(current.renderer)
    } finally { await dispose(current); await dispose(legacy); await dispose(reference) }
  })
}


test('oversize texture fields remain alive for all sample reads, then retire at a completed checkpoint', async () => {
  const h = setup([material, effect('noise'), material], 1536)
  try {
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    assert.deepEqual(h.rec.passes.map(p => p.expression.mode), [8, 8, 8, 8, 7, 7, 7, 7, 8, 8, 8, 8])
    const firstField = h.rec.passes[0].inputs[1], secondField = h.rec.passes[8].inputs[1]
    assert.ok(!h.rec.live.has(firstField), 'completed oversized field is reclaimable between effects')
    assert.ok(h.rec.live.has(secondField)); assert.notEqual(firstField, secondField)
    for (let i = 0; i < 4; i++) {
      assert.equal(h.rec.passes[i].inputs[1], firstField)
      assert.equal(h.rec.passes[i + 8].inputs[1], secondField)
    }
    assert.ok(h.rec.checkpoints > 0); assert.ok(h.rec.peak <= 256 * MiB)
    assert.equal(h.renderer.bytes, h.rec.bytes); assert.equal(output.length, 4); assertPool(h.renderer)
  } finally { await dispose(h) }
})

for (const pattern of [[0, 1, 2, 3], [0, 0, 0, 0], [0, 1, 0, 1], [0, 0, 1, 1]]) {
  test(`noise/texture chains preserve exact pass inputs, uniforms and output graphs for aliases ${pattern}`, async () => {
    const effects = [effect('noise'), material, effect('noise', { amount: .8125, opacity: .375 })]
    const current = setup(effects, 16, pattern), reference = setup(effects, 16, pattern)
    try {
      const sourceValues = current.planes.map(p => current.rec.values.get(p.texture))
      const old = await legacyNoiseTexture(reference.renderer, reference.n, reference.planes)
      const output = await current.renderer.applySampleEffects(current.n, current.planes, {})
      assert.deepEqual(output.map(p => current.rec.values.get(p.texture)), old.map(p => reference.rec.values.get(p.texture)))
      assert.deepEqual(current.rec.passes.map(p => p.expression), reference.rec.passes.filter(p => p.expression.mode !== 23).map(p => p.expression))
      assert.deepEqual(current.rec.passes.slice(0, new Set(pattern).size).map(p => p.expression.inputs[0]),
        [...new Map(pattern.map((index, i) => [index, sourceValues[i]])).values()])
      assert.equal(new Set(output.map(p => p.texture)).size, new Set(pattern).size)
      assert.equal(current.renderer.busy.size, new Set(pattern).size + 1, 'only output planes and cached coordinate field stay owned')
      assertPool(current.renderer)
      current.renderer.release(...output)
      assert.equal(current.renderer.aliases.size, 0)
      assert.equal(current.renderer.busy.size, 1, 'the immutable material field stays cache-owned')
      assertPool(current.renderer)
    } finally { await dispose(current); await dispose(reference) }
  })
}

test('external retained source aliases survive effect consumption and pool reuse', async () => {
  const h = setup([effect('noise')], 16, [0, 1, 0, 1])
  const external = h.renderer.retain(h.planes[0]), value = h.rec.values.get(external.texture)
  try {
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    assert.equal(h.rec.values.get(external.texture), value)
    assert.ok(h.renderer.busy.has(external.texture)); assert.ok(!output.some(p => p.texture === external.texture))
    h.renderer.release(...output); assert.ok(h.renderer.busy.has(external.texture))
    h.renderer.release(external); assert.equal(h.renderer.busy.size, 0); assert.equal(h.renderer.aliases.size, 0)
    assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('repeated identical surface wrappers are consumed once and output aliases remain distinct', async () => {
  const h = setup([effect('noise')], 16, [0])
  try {
    const output = await h.renderer.applySampleEffects(h.n, Array(4).fill(h.planes[0]), {})
    assert.equal(h.rec.passes.length, 1); assert.equal(new Set(output).size, 4)
    assert.equal(h.renderer.aliases.get(output[0].texture), 4)
    h.renderer.release(...output); assert.equal(h.renderer.busy.size, 0); assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('disabled/no-op effects leave all four planes and borrowed coverage unchanged', async () => {
  const effects = [effect('noise', { visible: false }), effect('background-blur'), effect('glass'),
    effect('blur', { radius: 0 }), effect('texture', { amount: 0 }), effect('texture', { opacity: 0 }),
    effect('texture', { radius: 0, texture: material.texture })]
  const h = setup(effects), coverage = { value: h.planes, owned: false }
  try {
    assert.equal(await h.renderer.applySampleEffects(h.n, h.planes, coverage), h.planes)
    assert.equal(coverage.value, h.planes); assert.equal(coverage.owned, false)
    assert.equal(h.rec.passes.length, 0); assert.equal(h.renderer.busy.size, 4)
  } finally { await dispose(h) }
})

test('noise followed by blur resolves the modified four planes exactly once', async () => {
  const h = setup([effect('noise'), effect('blur')])
  try {
    const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
    assert.deepEqual(h.rec.passes.map(p => p.expression.mode), [7, 7, 7, 7, 23, 22, 22])
    assert.deepEqual(h.rec.passes[4].expression.inputs, h.rec.passes.slice(0, 4).map(p => p.expression))
    assert.equal(new Set(output.map(p => p.texture)).size, 1); assert.equal(h.renderer.aliases.get(output[0].texture), 4)
    h.renderer.release(...output); assert.equal(h.renderer.busy.size, 0); assertPool(h.renderer)
  } finally { await dispose(h) }
})

test('a pre-resolved first blur keeps its original mean and skips a second resolve', async () => {
  const h = setup([effect('blur'), effect('noise')]), resolved = h.renderer.run(23, h.n.rect, h.planes)
  h.renderer.release(...h.planes)
  const mean = h.rec.values.get(resolved.texture)
  try {
    const output = await h.renderer.applySampleEffects(h.n, [], {}, resolved)
    assert.deepEqual(h.rec.passes.map(p => p.expression.mode), [23, 22, 22, 7])
    assert.equal(h.rec.passes[1].expression.inputs[0], mean)
    assert.equal(new Set(output.map(p => p.texture)).size, 1)
    h.renderer.release(...output); assert.equal(h.renderer.busy.size, 0); assertPool(h.renderer)
  } finally { await dispose(h) }
})

for (const kind of ['shadow', 'inner-shadow']) for (const scalar of [false, true]) {
  test(`${kind} retains the required ${scalar ? 'scalar-alpha' : 'RGBA'} resolve after noise`, async () => {
    const h = setup([effect('noise'), effect(kind, { radius: 0 })])
    h.rec.driver.scalarAlphaFilter = scalar
    try {
      const output = await h.renderer.applySampleEffects(h.n, h.planes, {})
      const resolves = h.rec.passes.filter(p => [23, 49].includes(p.expression.mode))
      assert.equal(resolves.length, 1); assert.equal(resolves[0].expression.mode, scalar ? 49 : 23)
      assert.deepEqual(resolves[0].expression.inputs, h.rec.passes.slice(0, 4).map(p => p.expression))
      const shadows = h.rec.passes.filter(p => p.expression.mode === 6)
      assert.equal(shadows.length, 4)
      for (const shadow of shadows) assert.equal(shadow.expression.inputs[0], shadow.expression.inputs[1], 'integer zero-radius shadow still reads its individual sample')
      h.renderer.release(...output); assert.equal(h.renderer.busy.size, 0); assertPool(h.renderer)
    } finally { await dispose(h) }
  })
}


for (const captureDisplay of [false, true]) for (const managed of [false, true]) for (const coherentSamples of [false, true]) {
  test(`${captureDisplay ? 'Electron' : 'web'} driver policy keeps the same full render graph (managed=${managed}, fourSamples=${coherentSamples})`, async () => {
    const current = recorder({ managed, captureDisplay }), reference = recorder({ managed, captureDisplay })
    const renderer = new GpuRenderer(current.driver, true, false), legacy = new GpuRenderer(reference.driver, true, false)
    const n = { ...node(16, [effect('noise'), effect('texture')]), passthrough: true }
    const input = { ...scene(n), floatCompositing: managed, coherentSamples }
    // The legacy scheduler only differs in coherent-sample foreground effects;
    // ordinary single-sample applyEffects continues through production code.
    legacy.applySampleEffects = (node, planes) => legacyNoiseTexture(legacy, node, planes)
    try {
      const result = await renderer.render(input), old = await legacy.render(input)
      assert.equal(result.workingBudgetBytes, old.workingBudgetBytes)
      const modes = new Set([7, 8])
      assert.deepEqual(current.passes.filter(p => modes.has(p.expression.mode)).map(p => p.expression),
        reference.passes.filter(p => modes.has(p.expression.mode)).map(p => p.expression))
      assert.deepEqual(current.passes.at(-1).expression, reference.passes.at(-1).expression)
      assert.equal(renderer.busy.size, managed ? 1 : 0, 'only the managed coordinate-field cache stays owned')
      assert.equal(renderer.busy.size, legacy.busy.size)
      assert.equal(renderer.aliases.size, 0); assertPool(renderer)
    } finally {
      await current.driver.checkpoint(); await reference.driver.checkpoint()
      renderer.dispose(); legacy.dispose(); assert.equal(current.bytes, 0); assert.equal(reference.bytes, 0)
    }
  })
}

for (const effectIndex of [1, 2, 4]) {
  test(`render failure on sample ${effectIndex} clears aliases/ownership and permits a clean retry`, async () => {
    const rec = recorder(), renderer = new GpuRenderer(rec.driver, true, true), n = node(16, [effect('noise')])
    rec.failOnEffect(effectIndex)
    try {
      await assert.rejects(renderer.render(scene(n)), /Injected effect encoding failure/)
      assert.equal(renderer.busy.size, 0); assert.equal(renderer.aliases.size, 0); assertPool(renderer)
      assert.equal(renderer.bytes, rec.bytes)
      rec.failOnEffect(0)
      await renderer.render(scene(n))
      assert.equal(renderer.busy.size, 0); assert.equal(renderer.aliases.size, 0); assertPool(renderer)
      assert.equal(renderer.bytes, rec.bytes)
    } finally { await rec.driver.checkpoint(); renderer.dispose(); assert.equal(rec.bytes, 0) }
  })
}
