#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execute, executedAssertions } from './lib/runner.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const client = join(root, 'frontend/design-client'), desktop = join(root, 'frontend/design-desktop')
const args = process.argv.slice(2)
let profile = 'portable', suites, output, list = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--help') {
    console.log('node testing/verify-local.mjs [--profile contracts|portable|native|all] [--suites id,id] [--output directory] [--list]')
    console.log('No installs, downloads, browser or GPU launch. Real local sockets require --suites socket-integration and permission; excluded from every profile. Missing required inputs fail with NOT RUN. Outputs are per-suite logs + results.json. Explicit --suites runs only those suites. Native means real CPU Rust/sidecar processes, not a GUI or GPU.')
    process.exit(0)
  } else if (arg === '--list') list = true
  else if (['--profile', '--suites', '--output'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
    const value = args[++i]
    if (arg === '--profile') profile = value
    if (arg === '--suites') suites = value.split(',')
    if (arg === '--output') output = resolve(value)
  } else throw new Error(`Unknown or incomplete argument: ${arg}`)
}
if (!['contracts', 'portable', 'native', 'all'].includes(profile)) throw new Error(`Unknown profile: ${profile}`)
async function walk(directory) {
  const files = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'generated', 'target', 'dist', '__pycache__'].includes(item.name)) continue
    const path = join(directory, item.name)
    if (item.isDirectory()) files.push(...await walk(path))
    else if (item.isFile()) files.push(path)
  }
  return files.sort()
}
const clientFiles = await walk(join(client, 'src')), scriptFiles = await walk(join(client, 'scripts'))
const desktopFiles = await walk(join(desktop, 'test'))
const mcp = join(root, 'frontend/design-mcp')
let mcpFiles = []
try { mcpFiles = await walk(join(mcp, 'test')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const runnerFiles = (await readdir(join(root, 'testing'))).filter(n => n.endsWith('.test.mjs')).map(n => join(root, 'testing', n)).sort()
const bunFiles = []
for (const path of scriptFiles) if (/from ['"]bun:test['"]/.test(await readFile(path, 'utf8'))) bunFiles.push(path)
const wasm = [join(client, 'src/generated/design-kernel/design_kernel.js'), join(client, 'public/kernel/design_kernel_bg.wasm'), join(client, 'public/fonts/NotoSansSC.ttf')]
const nativeDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR, 'debug') : join(root, 'design-studio/target/debug')
const exe = process.platform === 'win32' ? '.exe' : ''
const prepare = process.env.DESIGN_PREPARE_BINARY || join(nativeDir, `design-prepare${exe}`)
const sidecar = process.env.CORE_DESKTOP_SIDECAR || join(nativeDir, `futureox-design-desktop-backend${exe}`)
const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', DESIGN_PREPARE_BINARY: prepare, CORE_DESKTOP_SIDECAR: sidecar,
  FUTUREOX_BACKEND_TEST_BINARY: process.env.FUTUREOX_BACKEND_TEST_BINARY || sidecar, CORE_DESKTOP_TEST_SOURCE: pathToFileURL(join(desktop, 'src') + '/').href }
const nodePhase = (id, files, cwd, category, group, prerequisites = []) => ({ id, files, cwd, category, group, prerequisites,
  command: process.execPath, args: ['--test', '--test-timeout=120000', '--test-reporter=tap', ...files], format: 'tap' })
const phases = [
  nodePhase('runner-contracts', runnerFiles, root, 'runner-negative-controls', 'contracts'),
  nodePhase('frontend-contracts', [...clientFiles.filter(p => p.endsWith('.test.mjs')), join(client, 'src/kernel/render-policy.test.ts')], client, 'CPU production logic + sandboxed callbacks/source contracts/mock DOM; not native UI', 'contracts', [join(client, 'node_modules/vite/package.json')]),
  nodePhase('desktop-contracts', desktopFiles.filter(p => dirname(p) === join(desktop, 'test') && p.endsWith('.test.mjs') && !/automation-(bridge-socket|storage-bridge)\.test\.mjs$/.test(p)), desktop, 'mock host/IPC and file-policy contracts; not Electron GUI', 'contracts'),
  { id: 'python-tools', group: 'contracts', category: 'CPU tool unit tests', cwd: join(root, 'design-studio/scripts'), command: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), args: ['-m', 'unittest', 'discover', '-p', 'test_*.py'], files: (await readdir(join(root, 'design-studio/scripts'))).filter(n => /^test_.*\.py$/.test(n)).map(n => join(root, 'design-studio/scripts', n)), format: 'python' },
  { id: 'typecheck', group: 'portable', category: 'static TypeScript check', cwd: client, command: process.execPath, args: [join(client, 'node_modules/typescript/bin/tsc'), '--noEmit'], prerequisites: [...wasm, join(client, 'node_modules/typescript/bin/tsc')], files: [] },
  { id: 'frontend-vitest', group: 'portable', category: 'real CPU WASM + pure logic + mocked DOM/driver suites; not real GPU/UI', cwd: client, command: process.execPath, args: [join(client, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=default', '--reporter=json'], prerequisites: [...wasm, join(client, 'node_modules/vitest/vitest.mjs')], files: clientFiles.filter(p => /\.test\.tsx?$/.test(p) && !p.replaceAll('\\', '/').endsWith('/render-policy.test.ts')), format: 'vitest' },
  { id: 'mcp-example', group: 'portable', category: 'real Editor/WASM via in-memory MCP, synthetic HTML/CSS and native-file outputs', cwd: client, command: process.execPath, args: [join(client, 'node_modules/vitest/vitest.mjs'), 'run', '--config', '../design-mcp/examples/vitest.config.mjs', '--reporter=default', '--reporter=json'], prerequisites: [...wasm, join(client, 'node_modules/vitest/vitest.mjs')], files: [join(mcp, 'examples/generate-example.test.ts')], format: 'vitest' },
  { id: 'bun-unit', group: 'portable', category: 'CPU budget/policy logic; no actual GPU', cwd: client, command: process.env.BUN || 'bun', args: ['test', ...bunFiles], files: bunFiles, format: 'bun' },
  { id: 'rust-cpu', group: 'native', category: 'real CPU Rust kernel + local SQLite/backend; no cloud server or GPU', cwd: join(root, 'design-studio'), command: process.env.CARGO || 'cargo', args: ['test', '--locked', '-p', 'futureox-design-kernel', '-p', 'futureox-design-desktop-backend'], files: [join(root, 'design-studio/Cargo.lock')], format: 'rust', timeoutMs: 1800000 },
  nodePhase('automation-storage', desktopFiles.filter(p => p.endsWith('automation-storage-bridge.test.mjs')), desktop, 'real SQLite sidecar + mocked IPC host', 'native', [env.FUTUREOX_BACKEND_TEST_BINARY]),
  nodePhase('mcp-contracts', mcpFiles.filter(p => p.endsWith('.test.mjs') && !p.endsWith('socket-integration.test.mjs')), mcp, 'in-memory protocol/transport + real stdio; no OS socket', 'contracts'),
  nodePhase('socket-integration', [...desktopFiles.filter(p => p.endsWith('automation-bridge-socket.test.mjs')), ...mcpFiles.filter(p => p.endsWith('socket-integration.test.mjs'))], root, 'real OS socket IPC; explicit opt-in only, permission required', 'manual'),
  nodePhase('native-preparation', [join(desktop, 'test/runtime/preparation-runtime.test.mjs')], desktop, 'real native CPU binary / WASM packet + pixel comparison', 'native', [...wasm, prepare]),
  nodePhase('native-sidecar', desktopFiles.filter(p => /\/runtime\/(sidecar|workspace)-runtime\.test\.mjs$/.test(p.replaceAll('\\', '/'))), desktop, 'real owned Rust processes + local SQLite; not OS dialogs', 'native', [sidecar]),
]
const selected = p => suites ? suites.includes(p.id) : (profile === 'all' && p.group !== 'manual') || p.group === profile || (profile === 'portable' && p.group === 'contracts')
if (suites?.some(id => !phases.some(p => p.id === id))) throw new Error(`Unknown suite: ${suites.filter(id => !phases.some(p => p.id === id)).join(',')}`)
if (list) { console.log(JSON.stringify(phases.map(p => ({ id: p.id, selected: selected(p), category: p.category, discoveredFiles: p.files.length, command: [p.command, ...p.args] })), null, 2)); process.exit(0) }
output ||= join(root, 'test-results', `local-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`)
await mkdir(output, { recursive: true })
let revision = null, dirty = null
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) } catch {}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, revision, dirty, profile, explicitSuites: suites || null, suites: [], limitations: [
  'Passing only applies to the selected named suites; test files are not assertions or line coverage.',
  'No browser, Electron GUI, GPU driver/readback, installed-app packaging, accessibility or native OS dialog was launched. Real socket tests are separate opt-in and never automatically selected.',
  'No Windows/macOS run is inferred from Linux; consult each actual CI artifact.',
  'Private external corpora may be explicitly skipped unless DESIGN_REQUIRE_PRIVATE_FIXTURES=1.',
  'WASM scalar/SIMD experiments, performance benchmarks and browser check scripts remain separate explicitly requested gates.',
] }
for (const phase of phases) {
  const entry = { id: phase.id, category: phase.category, status: 'not-selected', files: [] }
  report.suites.push(entry)
  if (!selected(phase)) continue
  entry.command = [phase.command, ...phase.args]
  entry.cwd = relative(root, phase.cwd)
  const missing = []
  for (const path of phase.prerequisites || []) try { await access(path) } catch { missing.push(relative(root, path)) }
  if ((phase.format && !phase.files.length) || missing.length) {
    entry.status = 'not-run'; entry.reason = missing.length ? `Missing prerequisites: ${missing.join(', ')}` : 'No discovered test files'
    console.error(`NOT RUN ${phase.id}: ${entry.reason}`); continue
  }
  for (const path of phase.files) entry.files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
  const log = join(output, `${phase.id}.log`)
  const commandArgs = [...phase.args]
  if (phase.id === 'frontend-contracts') commandArgs.unshift('--experimental-transform-types', '--import', pathToFileURL(join(root, 'testing/lib/register-typescript.mjs')).href)
  const jsonReport = join(output, `${phase.id}.json`)
  if (phase.format === 'vitest') commandArgs.push(`--outputFile.json=${jsonReport}`)
  entry.command = [phase.command, ...commandArgs]
  const phaseEnv = { ...env, FUTUREOX_MCP_EXAMPLE_DIR: join(output, 'mcp-example') }
  console.log(`RUN ${phase.id}: ${phase.category}`)
  try {
    const result = await execute(phase.command, commandArgs, { cwd: phase.cwd, env: phaseEnv, log, timeoutMs: phase.timeoutMs || 600000 })
    const { output: text, ...summary } = result
    Object.assign(entry, summary, { log: relative(output, log) })
    let nonempty = executedAssertions(text, phase.format)
    if (phase.format === 'vitest' && result.status === 'passed') {
      const data = JSON.parse(await readFile(jsonReport, 'utf8'))
      entry.tests = { total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests, pending: data.numPendingTests }
      nonempty = data.numTotalTests > 0 && data.numPassedTests > 0
    }
    if (entry.status === 'passed' && !nonempty) { entry.status = 'failed'; entry.reason = 'No positive evidence of executed tests; empty/all-skipped suites cannot pass' }
  } catch (error) { entry.status = 'failed'; entry.reason = String(error) }
  console.log(`${entry.status.toUpperCase()} ${phase.id}: ${entry.log || entry.reason}`)
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
}
report.finishedAt = new Date().toISOString()
report.selectedSuiteResult = report.suites.some(p => ['failed', 'not-run'].includes(p.status)) ? 'failed' : 'passed'
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`Selected suites: ${report.selectedSuiteResult}. Evidence: ${output}`)
console.log('Native GUI, real GPU, OS integration and full Figma/Sketch equivalence are NOT established by this run.')
process.exitCode = report.selectedSuiteResult === 'passed' ? 0 : 1
