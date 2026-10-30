import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { InitializationGate, readKernelAsset } from './initialization.ts'
import { loadKernelResourcePair } from './kernel-resources.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fakeClock() {
  let now = 0, serial = 0
  const timers = new Map()
  return {
    now: () => now,
    schedule(fn, milliseconds) { const id = ++serial; timers.set(id, { fn, at: now + milliseconds }); return id },
    cancel(id) { timers.delete(id) },
    advance(milliseconds) { now += milliseconds; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() } },
  }
}
function replaceExactly(source, from, to) {
  assert.equal(source.split(from).length, 2, `Source shape changed: ${from}`)
  return source.replace(from, to)
}
function moduleBoundary(compile, read = async () => { throw new Error('unexpected resource download') }, hash = async () => new Uint8Array(32).buffer, install = async module => module) {
  // Strip the actual typed module rather than matching obsolete pre-capacity
  // import/signature text. The previous harness already drifted in the baseline.
  const source = stripTypeScriptTypes(readFileSync(new URL('./module.ts', import.meta.url), 'utf8'))
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  assert.doesNotMatch(source, /new VectorEngine|load_font|render_|compile_gpu|initializePicking/)
  const clock = fakeClock(), admitted = [], installed = []
  const api = vm.runInNewContext(`${source}\n({ initializeKernelModule, validateKernelDocument, kernelModuleResourceIdentity })`, {
    InitializationGate: class extends InitializationGate { constructor() { super(30, clock) } },
    WebAssembly: { compile }, readKernelAsset: read,
    documentCapacity: () => ({ memoryBytes: 1024 * 1024 }), pinDocumentCapacity() {}, configure_document_capacity() {},
    crypto: hash === null ? undefined : { subtle: { digest: (_algorithm, bytes) => hash(bytes) } },
    initKernel: async ({ module_or_path }) => { installed.push(module_or_path); return install(module_or_path) },
    validate_document_json: json => admitted.push(json),
  })
  return { ...api, admitted, installed, clock }
}

test('sync admission fails before readiness; concurrent initialization shares one CPU compilation', async () => {
  const loading = deferred(), entered = deferred(), inputs = []
  const api = moduleBoundary(bytes => { inputs.push(bytes); entered.resolve(); return loading.promise })
  assert.throws(() => api.validateKernelDocument('{}'), /文档校验内核尚未就绪/)
  const wasm = new Uint8Array([0]), first = api.initializeKernelModule(wasm)
  assert.equal(api.initializeKernelModule(), first)
  await entered.promise
  assert.throws(() => api.validateKernelDocument('{}'), /文档校验内核尚未就绪/)
  assert.equal(inputs.length, 1)
  assert.notEqual(inputs[0], wasm)
  assert.equal(Object.prototype.toString.call(inputs[0]), '[object ArrayBuffer]')
  wasm[0] = 7
  assert.deepEqual([...new Uint8Array(inputs[0])], [0])
  loading.resolve('compiled'); await first
  api.validateKernelDocument('{"snapshot":1}')
  assert.deepEqual(api.installed, ['compiled'])
  assert.deepEqual(api.admitted, ['{"snapshot":1}'])
})

test('failed compilation admits nothing and an explicit retry recovers', async () => {
  let attempts = 0
  const failure = new Error('invalid module')
  const api = moduleBoundary(async () => { if (++attempts === 1) throw failure; return 'valid' })
  await assert.rejects(api.initializeKernelModule(new Uint8Array([0])), error => error === failure)
  assert.throws(() => api.validateKernelDocument('{}'), /文档校验内核尚未就绪/)
  await api.initializeKernelModule(new Uint8Array([0]))
  api.validateKernelDocument('{}')
  assert.equal(attempts, 2)
  assert.deepEqual(api.installed, ['valid'])
})

for (const lateFailure of [false, true]) {
  test(`a timed-out compile cannot publish or reset a newer attempt (${lateFailure ? 'late failure' : 'late success'})`, async () => {
    const a = deferred(), b = deferred(), enteredA = deferred(), enteredB = deferred()
    let calls = 0
    const api = moduleBoundary(() => { if (++calls === 1) { enteredA.resolve(); return a.promise }; enteredB.resolve(); return b.promise })
    const first = api.initializeKernelModule(new Uint8Array([0])); await enteredA.promise
    api.clock.advance(31)
    await assert.rejects(first, /初始化超时/)
    const next = api.initializeKernelModule(new Uint8Array([1])); await enteredB.promise
    if (lateFailure) a.reject(new Error('late invalid module'))
    else a.resolve('obsolete module')
    await a.promise.catch(() => {}); await Promise.resolve()
    assert.deepEqual(api.installed, [])
    assert.equal(api.initializeKernelModule(), next)
    b.resolve('current module'); await next
    assert.deepEqual(api.installed, ['current module'])
  })
}

test('a hung module download times out and aborts its owned fetch signal', async () => {
  const entered = deferred(); let signal
  const api = moduleBoundary(async () => 'unused', (_path, _limit, value) => { signal = value; entered.resolve(); return new Promise(() => {}) })
  const loading = api.initializeKernelModule(); await entered.promise
  api.clock.advance(31)
  await assert.rejects(loading, /初始化超时/)
  assert.equal(signal.aborted, true)
  assert.deepEqual(api.installed, [])
})

test('fixed same-origin asset reading enforces actual streamed bytes, not a small Content-Length claim', async () => {
  const previous = globalThis.fetch, calls = []
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options })
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6])); controller.close()
    } }), { headers: { 'Content-Length': '1' } })
  }
  try {
    const controller = new AbortController()
    await assert.rejects(readKernelAsset('/kernel/design_kernel_bg.wasm', 4, controller.signal), /大小限制/)
    assert.equal(calls[0].path, '/kernel/design_kernel_bg.wasm')
    assert.equal(calls[0].options.mode, 'same-origin')
    assert.equal(calls[0].options.redirect, 'error')
    assert.equal(calls[0].options.signal, controller.signal)
  } finally { globalThis.fetch = previous }
})

test('font initialization timeout and late completion cannot replace a newer initialized engine', async () => {
  const source = readFileSync(new URL('./picking.ts', import.meta.url), 'utf8')
  const header = 'export function initializePicking(resources?: { wasm: Uint8Array; font: Uint8Array }) {'
  assert.equal(source.split(header).length, 2)
  const end = '\n/** All file-opening paths share'
  assert.equal(source.split(end).length, 2)
  const callback = stripTypeScriptTypes(source.slice(source.indexOf(header), source.indexOf(end))).replace('export function', 'function')
  const clock = fakeClock(), a = deferred(), b = deferred(), enteredA = deferred(), enteredB = deferred(), engines = []
  let requests = 0
  const context = vm.createContext({
    initialization: new InitializationGate(30, clock), ready: false, layoutEngine: undefined,
    initializeKernelModule: async () => {}, loadKernelResourcePair,
    kernelResourceSha256: async () => 'c'.repeat(64),
    kernelModuleResourceIdentity: () => ({ wasmSha256: 'b'.repeat(64), bundled: true }),
    preparationResources: undefined, geometryEpoch: {},
    readKernelAsset: () => { if (++requests === 1) { enteredA.resolve(); return a.promise }; enteredB.resolve(); return b.promise },
    VectorEngine: class { constructor() { engines.push(this) }; load_font(bytes) { this.bytes = bytes }; free() { this.freed = true } },
  })
  const initialize = vm.runInContext(`${callback}\ninitializePicking`, context)
  const first = initialize(); await Promise.race([enteredA.promise, first.then(() => { throw new Error('initialization returned before font request') })])
  clock.advance(31); await assert.rejects(first, /初始化超时/)
  const next = initialize(); await Promise.race([enteredB.promise, next.then(() => { throw new Error('retry returned before font request') })])
  a.resolve(new Uint8Array([1])); await a.promise; await Promise.resolve()
  assert.equal(engines.length, 0)
  b.resolve(new Uint8Array([2])); await next
  assert.equal(engines.length, 1)
  assert.equal(context.layoutEngine, engines[0])
  assert.equal(context.layoutEngine.bytes[0], 2)
  assert.equal(context.ready, true)
})

test('the committed publication remains successful when the clock crosses the deadline before promise propagation', async () => {
  const clock = fakeClock(), gate = new InitializationGate(30, clock)
  let ready = false
  const result = gate.run(async lease => {
    lease.commit(() => { ready = true })
    clock.advance(31)
  })
  await result
  assert.equal(ready, true)
  assert.equal(gate.run(async () => { throw new Error('must reuse committed result') }), result)
})


test('late hash after timeout cannot publish over a newer successful module identity', async () => {
  const a = deferred(), b = deferred(), enteredA = deferred(), enteredB = deferred(); let calls = 0
  const api = moduleBoundary(async bytes => new Uint8Array(bytes)[0], undefined,
    () => { if (++calls === 1) { enteredA.resolve(); return a.promise }; enteredB.resolve(); return b.promise })
  const first = api.initializeKernelModule(new Uint8Array([1])); await enteredA.promise
  api.clock.advance(31); await assert.rejects(first, /初始化超时/)
  assert.equal(api.kernelModuleResourceIdentity(), undefined); assert.deepEqual(api.installed, [])
  const second = api.initializeKernelModule(new Uint8Array([2])); await enteredB.promise
  b.resolve(new Uint8Array(32).fill(2).buffer); await second
  const current = api.kernelModuleResourceIdentity()
  assert.equal(current.wasmSha256, '02'.repeat(32)); assert.equal(current.bundled, false)
  assert.equal(Object.isFrozen(current), true)
  a.resolve(new Uint8Array(32).fill(1).buffer); await Promise.resolve(); await Promise.resolve()
  assert.equal(api.kernelModuleResourceIdentity(), current); assert.deepEqual(api.installed, [2])
})

test('generated initializer timeout and late singleton publication cannot certify retry bytes', async () => {
  const a = deferred(), enteredA = deferred(); let calls = 0, singleton
  const api = moduleBoundary(async bytes => new Uint8Array(bytes)[0], undefined,
    async bytes => new Uint8Array(32).fill(bytes[0]).buffer,
    async module => {
      if (++calls === 1) { enteredA.resolve(); await a.promise }
      if (singleton === undefined) singleton = module
      return singleton
    })
  const first = api.initializeKernelModule(new Uint8Array([1])); await enteredA.promise
  api.clock.advance(31); await assert.rejects(first, /初始化超时/)
  // The old generated initializer publishes after its caller has timed out.
  a.resolve(); await Promise.resolve(); await Promise.resolve()
  await api.initializeKernelModule(new Uint8Array([2]))
  assert.equal(singleton, 1)
  api.validateKernelDocument('{}')
  assert.equal(api.kernelModuleResourceIdentity(), undefined)
})

test('generated initializer failure conservatively disables identity after a successful retry', async () => {
  let calls = 0
  const api = moduleBoundary(async () => 'compiled', undefined, undefined,
    async module => { if (++calls === 1) throw new Error('installation failure'); return module })
  await assert.rejects(api.initializeKernelModule(new Uint8Array([1])), /installation failure/)
  await api.initializeKernelModule(new Uint8Array([2]))
  api.validateKernelDocument('{}')
  assert.equal(api.kernelModuleResourceIdentity(), undefined)
})

for (const hash of [null, async () => { throw new Error('WebCrypto unavailable') }]) {
  test(`ordinary module initialization survives ${hash === null ? 'absent' : 'failed'} WebCrypto without fabricating identity`, async () => {
    const api = moduleBoundary(async () => 'module', undefined, hash)
    await api.initializeKernelModule(new Uint8Array([1]))
    api.validateKernelDocument('{}')
    assert.equal(api.kernelModuleResourceIdentity(), undefined)
  })
}

function pickingHashBoundary(hash) {
  const source = readFileSync(new URL('./picking.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function initializePicking(')
  const end = source.indexOf('\n/** All file-opening paths share', start)
  const callback = stripTypeScriptTypes(source.slice(start, end)).replace('export function', 'function')
  const clock = fakeClock(), engines = []
  const context = vm.createContext({
    initialization: new InitializationGate(30, clock), ready: false, layoutEngine: undefined,
    preparationResources: undefined, geometryEpoch: {},
    initializeKernelModule: async () => {}, loadKernelResourcePair,
    kernelResourceSha256: hash, kernelModuleResourceIdentity: () => ({ wasmSha256: 'b'.repeat(64), bundled: true }),
    readKernelAsset: async () => new Uint8Array([1]),
    VectorEngine: class { constructor() { engines.push(this) }; load_font(bytes) { this.bytes = bytes }; free() { this.freed = true } },
  })
  const initialize = vm.runInContext(`${callback}\ninitializePicking`, context)
  return { initialize, context, engines, clock }
}

test('font hash timeout creates no engine and a late old hash cannot replace new resources or epoch', async () => {
  const a = deferred(), b = deferred(), enteredA = deferred(), enteredB = deferred(); let calls = 0
  const api = pickingHashBoundary(() => { if (++calls === 1) { enteredA.resolve(); return a.promise }; enteredB.resolve(); return b.promise })
  const originalEpoch = api.context.geometryEpoch
  const first = api.initialize(); await enteredA.promise
  api.clock.advance(31); await assert.rejects(first, /初始化超时/)
  assert.equal(api.engines.length, 0); assert.equal(api.context.preparationResources, undefined)
  assert.equal(api.context.geometryEpoch, originalEpoch)
  const second = api.initialize(); await enteredB.promise
  b.resolve('d'.repeat(64)); await second
  const resources = api.context.preparationResources, epoch = api.context.geometryEpoch
  assert.equal(resources.fontSha256, 'd'.repeat(64)); assert.equal(Object.isFrozen(resources), true)
  a.resolve('c'.repeat(64)); await Promise.resolve(); await Promise.resolve()
  assert.equal(api.context.preparationResources, resources); assert.equal(api.context.geometryEpoch, epoch)
  assert.equal(api.engines.length, 1)
})

test('custom font resources never claim the bundled preparation environment', async () => {
  const api = pickingHashBoundary(async () => 'c'.repeat(64))
  await api.initialize({ wasm: new Uint8Array([2]), font: new Uint8Array([3]) })
  assert.equal(api.context.preparationResources.bundled, false)
  const resources = api.context.preparationResources
  await api.initialize({ wasm: new Uint8Array([4]), font: new Uint8Array([5]) })
  assert.equal(api.context.preparationResources, resources)
  assert.equal(api.engines.length, 1)
  assert.equal(api.context.layoutEngine.bytes[0], 3)
})
