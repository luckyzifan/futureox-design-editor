/** Real GPU recovery gate with explicitly labelled admission/finish faults.
 * --prepare-only compiles the actual fixture with WASM but never starts a GPU. */
import { chromium } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(project, '../..')
const shaderRoot = join(repository, 'design-studio/crates/design-kernel/shaders')
const fixturePath = join(repository, 'testing/review/design-desktop-macos-gui-2026-10-10/hdr-performance/combined-fixture.forma')
const runId = randomUUID(), startedAt = new Date().toISOString()
let output = process.env.DESIGN_TEST_OUTPUT || ''
let ownedOutput = false
let before: Record<string, string> | undefined, after: Record<string, string> | undefined
const browserErrors: { zoom?: number; type: string; message: string }[] = []
const rows: unknown[] = [], messages: { zoom: number; message: string }[] = []
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const evidence = async (name: string, value: unknown) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const changedInputs = () => before && after
  ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before![name] !== after![name]) : []

async function inputHashes() {
  const hashes: Record<string, string> = {}
  async function walk(root: string, directory: string, label: string, ancestors = new Set<string>()) {
    const canonical = await realpath(directory)
    if (ancestors.has(canonical)) throw Error(`Input symlink cycle: ${directory}`)
    const next = new Set(ancestors).add(canonical)
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), info = await stat(path)
      if (info.isDirectory()) await walk(root, path, label, next)
      else if (info.isFile()) hashes[`${label}/${relative(root, path).replaceAll('\\', '/')}`] = digest(await readFile(path))
      else throw Error(`Unsupported input type: ${path}`)
    }
  }
  await walk(join(project, 'src'), join(project, 'src'), 'src')
  await walk(join(project, 'public/kernel'), join(project, 'public/kernel'), 'public/kernel')
  await walk(shaderRoot, shaderRoot, 'shaders')
  for (const name of ['scripts/check-exact-prefix-recovery.ts', 'gpu-check.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'public/fonts/NotoSansSC.ttf'])
    hashes[name] = digest(await readFile(join(project, name)))
  hashes[`fixture/${relative(repository, fixturePath).replaceAll('\\', '/')}`] = digest(await readFile(fixturePath))
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
}

async function stopOwned(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null || !server.pid) return
  const exited = new Promise<void>(resolve => server.once('exit', () => resolve()))
  server.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const ended = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000) })])
  clearTimeout(timer)
  if (!ended) { server.kill('SIGKILL'); await exited }
}

try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('bun scripts/check-exact-prefix-recovery.ts [--prepare-only] [--zoom=2|4] [--output=/new-or-empty/directory]')
    console.log('Default: both existing HDR cameras, tile index 1 at zoom 2 and index 9 at zoom 4. GPU faults are explicit test controls, not physical OOM claims.')
    process.exit(0)
  }
  const options = new Map<string, string>(), flags = new Set<string>()
  for (const arg of args) {
    if (arg === '--prepare-only' && !flags.has(arg)) { flags.add(arg); continue }
    const match = /^--(zoom|output)=(.+)$/.exec(arg)
    if (!match || options.has(match[1])) throw Error(`Unknown or repeated argument: ${arg}`)
    options.set(match[1], match[2])
  }
  const zoomOption = options.get('zoom')
  if (zoomOption !== undefined && zoomOption !== '2' && zoomOption !== '4') throw Error('--zoom must be 2 or 4')
  const zooms = zoomOption === undefined ? [2, 4] : [Number(zoomOption)]
  const prepareOnly = flags.has('--prepare-only')
  if (options.has('output')) output = options.get('output')!
  if (output && !isAbsolute(output)) throw Error('Evidence output must be absolute')
  output ||= await mkdtemp(join(tmpdir(), `forma-prefix-recovery-${runId}-`))
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw Error(`Refusing non-empty evidence directory: ${output}`)
  await evidence('run-owner.json', { runId, pid: process.pid, startedAt })
  ownedOutput = true
  before = await inputHashes()
  await evidence('inputs-before.json', before)

  // CPU preparation also exercises the actual WASM, font, fixture and planner.
  const { initSync, VectorEngine } = await import(pathToFileURL(join(project, 'src/generated/design-kernel/design_kernel.js')).href)
  const { planTiles, devicePixelPhase } = await import(pathToFileURL(join(project, 'src/kernel/tile-cache.ts')).href)
  const fixtureBytes = await readFile(fixturePath), fixture = JSON.parse(fixtureBytes.toString('utf8'))
  initSync({ module: await readFile(join(project, 'public/kernel/design_kernel_bg.wasm')) })
  const engine = new VectorEngine(), prepared: any[] = []
  try {
    engine.load_font(await readFile(join(project, 'public/fonts/NotoSansSC.ttf')))
    engine.load_document(JSON.stringify(fixture))
    for (const zoom of zooms) {
      const view = zoom === 2 ? { x: -213.33333333333326, y: -194, zoom } : { x: -1306.6666666666665, y: -1250, zoom }
      const width = 1760, height = 1724, tileIndex = zoom === 2 ? 1 : 9
      const tiles = planTiles({ x: -view.x / zoom, y: -view.y / zoom, width: width / zoom, height: height / zoom }, zoom, 256,
        { x: devicePixelPhase(view.x, 1), y: devicePixelPhase(view.y, 1) })
      const tile = tiles[tileIndex]
      if (!tile) throw Error(`Missing planned tile ${tileIndex} at zoom ${zoom}`)
      const crop = { x: tile.x + Math.floor(view.x), y: tile.y + Math.floor(view.y), w: tile.width, h: tile.height }
      const renderOptions = { pageId: fixture.pages[0].id, width: crop.w, height: crop.h, view, transparent: false, grid: true, rasterProfile: 'figma', gpuViewport: crop }
      const raw = engine.compile_gpu(JSON.stringify(renderOptions)), scene = JSON.parse(raw)
      if (!scene.floatCompositing || !scene.integratedBlur || !scene.coherentSamples) throw Error('Selected fixture no longer compiles into the expected managed integrated scene')
      prepared.push({ zoom, tileIndex, plannedTiles: tiles.length, crop, renderOptions, rawSceneSha256: digest(raw),
        compiled: { extent: scene.extent, output: scene.output, floatCompositing: scene.floatCompositing, integratedBlur: scene.integratedBlur,
          coherentSamples: scene.coherentSamples, nodeCount: Object.keys(scene.nodes).length } })
    }
  } finally { engine.free() }
  await evidence('prepared-scenes.json', { scope: 'Actual CPU WASM compilation only; no pixel/GPU claim.', fixtureSha256: digest(fixtureBytes), scenes: prepared })
  await evidence('run.json', { runId, startedAt, prepareOnly, zooms, fixture: relative(repository, fixturePath),
    policy: 'Serial real GPU gates; reference explicitly disables prefix and must report zero scratch. Candidate faults are declared test instrumentation.',
    runtime: { bun: process.versions.bun || null, node: process.version, platform: process.platform, arch: process.arch } })
  console.log(JSON.stringify({ output, prepareOnly, zooms }))

  if (!prepareOnly) for (const selection of prepared) {
    const zoom = selection.zoom, serverLogs: string[] = []
    const env = { ...process.env }
    delete env.VITE_PRIVATE_PREFIX
    delete env.VITE_DESIGN_EXACT_PREFIX
    const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      server.stdout.on('data', data => serverLogs.push(String(data)))
      server.stderr.on('data', data => serverLogs.push(String(data)))
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20_000)
        let text = ''
        server.once('error', error => { clearTimeout(timer); reject(error) })
        server.once('exit', code => { clearTimeout(timer); reject(Error(`Vite exited ${code}`)) })
        server.stdout.on('data', data => {
          text = (text + String(data)).slice(-32768)
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+/)
          if (match) { clearTimeout(timer); resolve(match[0]) }
        })
      })
      browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
      const page = await browser.newPage()
      page.on('pageerror', error => browserErrors.push({ zoom, type: 'pageerror', message: error.stack || error.message }))
      page.on('console', message => {
        if (message.type() === 'error') browserErrors.push({ zoom, type: 'console.error', message: message.text() })
        if (message.text().startsWith('DESIGN_GPU_PREFIX')) messages.push({ zoom, message: message.text() })
      })
      await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }))
      await page.goto(`${url}/gpu-check.html`)
      let timeout: ReturnType<typeof setTimeout> | undefined
      let result: any
      try { result = await Promise.race([page.evaluate(async ({ fixture, selection }) => {
        const { initializePicking } = await import('/src/kernel/picking.ts')
        const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
        const { createGpu } = await import('/src/kernel/gpu/factory.ts')
        await initializePicking()
        const font = await fetch('/fonts/NotoSansSC.ttf')
        if (!font.ok) throw Error('Font request failed')
        const engine = new VectorEngine()
        let scene: any, raw: string
        try {
          engine.load_font(new Uint8Array(await font.arrayBuffer()))
          engine.load_document(JSON.stringify(fixture))
          raw = engine.compile_gpu(JSON.stringify(selection.renderOptions)); scene = JSON.parse(raw)
        } finally { engine.free() }
        const rawHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(v => v.toString(16).padStart(2, '0')).join('')
        if (rawHash !== selection.rawSceneSha256) throw Error('Browser scene differs from actual CPU WASM preparation')
        const reference = await createGpu('webgpu', true, false, fixture.colorManagement, undefined, true, true)
        ;(reference.driver as any).prefixEnabled = false
        let expected: Uint32Array, referenceFrameScratchBytes = -1
        try {
          const result = await reference.render(scene, true, false)
          referenceFrameScratchBytes = reference.driver.frameScratchBytes || 0
          if (referenceFrameScratchBytes !== 0 || reference.driver.scratchBytes || (reference.driver as any).prefix)
            throw Error('Old-filter reference unexpectedly prepared or used prefix')
          if (!result.linear || result.linear.length !== selection.crop.w * selection.crop.h * 4) throw Error('Missing or wrong-sized reference float readback')
          expected = new Uint32Array(result.linear.buffer, result.linear.byteOffset, result.linear.length).slice()
        } finally { reference.dispose() }
        const renderer = await createGpu('webgpu', true, false, fixture.colorManagement, undefined, true, true)
        const driver = renderer.driver as any, internal = renderer as any
        let encodedPasses = 0, wrapped: any, abortCalls = 0, attempts = 0, forceBudget = true, forced = false
        let fault: any, oversizedCreated = false, insideFault = false
        const ledger = () => ([...driver.textures] as any[]).filter(t => t !== driver.blank).reduce((sum, t) => sum + t.bytes, driver.scratchBytes)
        try {
          if (driver.scratchBytes !== 0) throw Error('Driver allocated eager scratch')
          // Declared instrumentation: two uniform slots force real submissions.
          driver.uniformData = new Float32Array(512)
          const prepare = driver.prepareFilters.bind(driver)
          driver.prepareFilters = async (...args: any[]) => {
            await prepare(...args)
            if (driver.prefix && wrapped !== driver.prefix) {
              wrapped = driver.prefix; const encode = wrapped.encode.bind(wrapped)
              wrapped.encode = (...args: any[]) => { const result = encode(...args); if (result) encodedPasses++; return result }
            }
          }
          const attempt = internal.renderAttempt.bind(internal)
          internal.renderAttempt = (...args: any[]) => { attempts++; return attempt(...args) }
          const abort = driver.abortFrameAndReleaseFilterScratch.bind(driver)
          driver.abortFrameAndReleaseFilterScratch = async () => {
            abortCalls++; await abort()
            if (driver.scratchBytes !== 0 || driver.frameScopeOpen) throw Error('Abort did not retire scratch/scope')
          }
          const create = driver.create.bind(driver)
          driver.create = (w: number, h: number) => {
            if (insideFault && w === 4096 && h === 4096) oversizedCreated = true
            return create(w, h)
          }
          const acquire = internal.acquire.bind(internal)
          internal.acquire = (r: any, binary = false) => {
            if (forceBudget && !forced && encodedPasses > 0 && driver.commandSubmissions > 0) {
              forced = true; insideFault = true
              fault = { kind: 'declared oversized next lease through real compositor admission; not physical OOM', encodedPasses,
                submitted: driver.commandSubmissions, reserved: driver.scratchBytes, rejectedByRealBudgetCheck: false }
              try {
                const result = acquire({ ...r, w: 4096, h: 4096 }, false)
                throw Error(`Oversized lease unexpectedly admitted: ${Boolean(result)}`)
              } catch (error) {
                if (error instanceof Error && error.message === 'GPU 表面内存预算超限') fault.rejectedByRealBudgetCheck = true
                throw error
              } finally { insideFault = false }
            }
            return acquire(r, binary)
          }
          const compare = (linear?: Float32Array) => {
            if (!linear) throw Error('Missing candidate float readback')
            const actual = new Uint32Array(linear.buffer, linear.byteOffset, linear.length)
            if (actual.length !== expected.length) throw Error('Float dimensions changed')
            let differences = 0
            for (let i = 0; i < actual.length; i++) differences += Number(actual[i] !== expected[i])
            if (differences) throw Error(`${differences} float bits changed`)
            return { components: actual.length, differences }
          }
          const recovered = await renderer.render(scene, true, false), first = compare(recovered.linear)
          const minimumSubmissions = selection.zoom === 2 ? 22 : 28
          if (!forced || !fault.rejectedByRealBudgetCheck || oversizedCreated || abortCalls !== 1 || attempts !== 2 ||
              fault.submitted < minimumSubmissions || fault.reserved !== 4 * 1024 * 1024 || driver.lost)
            throw Error('Submitted-prefix capacity fallback did not exercise the declared boundary exactly once')
          if (internal.bytes !== ledger() || driver.scratchBytes !== 0) throw Error('Ledger drift after recovered budget failure')
          forceBudget = false
          const beforeReuse = encodedPasses, reused = await renderer.render(scene, true, false), reuse = compare(reused.linear)
          if (encodedPasses <= beforeReuse || driver.frameScratchBytes !== 4 * 1024 * 1024 || driver.scratchBytes !== 0 || internal.bytes !== ledger())
            throw Error('Prefix did not resume and retire cleanly on the next frame')
          const finish = driver.finish.bind(driver)
          let failTail = true, tailRejected = false
          driver.finish = async (...args: any[]) => {
            const result = await finish(...args)
            if (failTail) { failTail = false; throw Error('deliberate failure after scratch retirement') }
            return result
          }
          try { await renderer.render(scene, true, false) }
          catch (error) { if (String(error).includes('deliberate failure after scratch retirement')) tailRejected = true; else throw error }
          if (!tailRejected || driver.scratchBytes !== 0 || internal.bytes !== ledger() || abortCalls !== 1 || attempts !== 4)
            throw Error('Post-finish error was swallowed, retried, or left stale accounting')
          const afterError = await renderer.render(scene, true, false), recovery = compare(afterError.linear)
          if (internal.bytes !== ledger() || driver.scratchBytes !== 0 || driver.lost || attempts !== 5 || abortCalls !== 1)
            throw Error('Renderer is not reusable after the post-finish error')
          return { status: 'passed', zoom: selection.zoom, tileIndex: selection.tileIndex, rawSceneSha256: rawHash,
            scope: 'Real GPU and exact old-filter float-bit reference. Uniform capacity, oversized admission and post-finish errors are explicit test controls.',
            referenceFrameScratchBytes, uniformArenaBytes: driver.uniformData.byteLength, fault, oversizedCreated,
            abortCalls, attempts, encodedPasses, first, reuse, recovery, tailRejected, finalScratchBytes: driver.scratchBytes,
            finalLedgerBytes: internal.bytes, liveBytes: ledger(), driverLost: driver.lost }
        } finally { renderer.dispose() }
      }, { fixture, selection }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error(`GPU recovery gate timed out at zoom ${zoom}`)), 120_000) })]) }
      finally { clearTimeout(timeout) }
      rows.push(result)
      await evidence(`zoom-${zoom}.json`, result)
    } finally {
      try { await browser?.close() } catch (error) { browserErrors.push({ zoom, type: 'browser.close', message: String(error) }) }
      await stopOwned(server)
      await writeFile(join(output, `server-${zoom}.log`), serverLogs.join(''), { flag: 'wx' })
    }
  }
  after = await inputHashes()
  await evidence('inputs-after.json', after)
  if (browserErrors.length) throw Error(`${browserErrors.length} browser error events occurred`)
  if (changedInputs().length) throw Error(`Inputs changed during gate: ${changedInputs().join(', ')}`)
  await evidence('results.json', { status: prepareOnly ? 'prepared' : 'passed', runId, startedAt, finishedAt: new Date().toISOString(), prepareOnly,
    scope: prepareOnly ? 'Actual fixture/WASM CPU preparation only; GPU recovery has NOT run.' : 'Actual selected-tile GPU recovery gate; not full-frame performance or physical OOM testing.',
    prepared, rows, browserErrors, messages, changedInputs: changedInputs() })
  console.log(JSON.stringify({ output, status: prepareOnly ? 'prepared' : 'passed', zooms, rows }))
} catch (error) {
  const requestedOutput = output
  if (!ownedOutput) output = await mkdtemp(join(tmpdir(), `forma-prefix-recovery-failure-${runId}-`))
  let hashError: string | undefined
  if (before && !after) try { after = await inputHashes() } catch (failure) { hashError = String(failure) }
  await evidence('failure.json', { status: 'failed', runId, startedAt, finishedAt: new Date().toISOString(), requestedOutput,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    rows, browserErrors, messages, inputsBefore: before, inputsAfter: after, changedInputs: changedInputs(), hashError })
  console.error(JSON.stringify({ output, status: 'failed', error: String(error) }))
  process.exitCode = 1
}
