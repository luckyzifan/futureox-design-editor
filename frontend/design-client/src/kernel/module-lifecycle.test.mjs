import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { InitializationGate, readKernelAsset } from './initialization.ts'

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
function moduleBoundary(compile, read = async () => { throw new Error('unexpected resource download') }) {
  let source = readFileSync(new URL('./module.ts', import.meta.url), 'utf8')
  for (const header of ["import initKernel, { validate_document_json } from '../generated/design-kernel/design_kernel'",
    "import { InitializationGate, readKernelAsset } from './initialization'"]) source = replaceExactly(source, header, '')
  source = replaceExactly(source, 'export function initializeKernelModule(wasm?: Uint8Array): Promise<void>', 'function initializeKernelModule(wasm)')
  source = replaceExactly(source, 'export function kernelModuleReady()', 'function kernelModuleReady()')
  source = replaceExactly(source, 'export function validateKernelDocument(json: string): void', 'function validateKernelDocument(json)')
  assert.doesNotMatch(source, /new VectorEngine|load_font|render_|compile_gpu|initializePicking/)
  const clock = fakeClock(), admitted = [], installed = []
  const api = vm.runInNewContext(`${source}\n({ initializeKernelModule, validateKernelDocument })`, {
    InitializationGate: class extends InitializationGate { constructor() { super(30, clock) } },
    WebAssembly: { compile }, readKernelAsset: read,
    initKernel: async ({ module_or_path }) => { installed.push(module_or_path); return module_or_path },
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
  const callback = source.slice(source.indexOf(header), source.indexOf(end)).replace(header, 'function initializePicking(resources) {')
  const clock = fakeClock(), a = deferred(), b = deferred(), enteredA = deferred(), enteredB = deferred(), engines = []
  let requests = 0
  const context = vm.createContext({
    initialization: new InitializationGate(30, clock), ready: false, layoutEngine: undefined,
    initializeKernelModule: async () => {},
    readKernelAsset: () => { if (++requests === 1) { enteredA.resolve(); return a.promise }; enteredB.resolve(); return b.promise },
    VectorEngine: class { constructor() { engines.push(this) }; load_font(bytes) { this.bytes = bytes }; free() { this.freed = true } },
  })
  const initialize = vm.runInContext(`${callback}\ninitializePicking`, context)
  const first = initialize(); await enteredA.promise
  clock.advance(31); await assert.rejects(first, /初始化超时/)
  const next = initialize(); await enteredB.promise
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
