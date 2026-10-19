import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const evidence = dirname(fileURLToPath(import.meta.url))
const root = join(evidence, '../..')
const desktop = join(root, 'frontend/design-desktop')
const rawOutput = await mkdtemp(join(tmpdir(), 'native-paste-over-evidence-raw-'))
const sanitize = value => value.replaceAll(root, '<repository>').replaceAll(homedir(), '<user-home>')
async function record(name, value) {
  await writeFile(join(rawOutput, name), value)
  await writeFile(join(evidence, name), sanitize(value))
}
async function publishManifest() {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && path !== join(evidence, 'publication.sha256')) files.push(path)
      else if (!entry.isFile()) throw new Error(`Unexpected non-file evidence entry: ${entry.name}`)
    }
  }
  await visit(evidence)
  const lines = await Promise.all(files.sort().map(async path => `${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(evidence, path).split('\\').join('/')}`))
  await writeFile(join(evidence, 'publication.sha256'), lines.join('\n') + '\n')
}
const tests = ['keyboard-shortcuts.test.mjs', 'main.test.mjs', 'preload.test.mjs']
const sources = ['keyboard-shortcuts.mjs', 'main.mjs', 'preload.cjs']
const env = { ...process.env, NODE_DISABLE_COLORS: '1' }
delete env.CORE_DESKTOP_TEST_SOURCE
const hashes = async (base, files) => Promise.all(files.map(async file => ({
  path: file, sha256: createHash('sha256').update(await readFile(join(base, file))).digest('hex'),
})))
function run(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000, env })
  assert.ifError(result.error)
  return { ...result, output: result.stdout + result.stderr }
}
const expected = JSON.parse(await readFile(join(evidence, 'source-manifest.json'), 'utf8'))
for (const file of expected.files) {
  const actual = createHash('sha256').update(await readFile(join(root, file.path))).digest('hex')
  assert.equal(actual, file.afterSha256, `Scoped source changed since publication: ${file.path}`)
}
const args = ['--test', '--test-reporter=tap', ...tests.map(file => `test/${file}`)]
const positive = run(desktop, args)
await record('focused.tap', positive.output)
assert.equal(positive.status, 0, positive.output)
assert.match(positive.output, /# tests 66\b/)
assert.match(positive.output, /# pass 66\b/)
assert.match(positive.output, /# skipped 0\b/)
const scratch = await mkdtemp(join(evidence, '.negative-control-'))
let negative
try {
  await cp(join(desktop, 'src'), join(scratch, 'src'), { recursive: true })
  await mkdir(join(scratch, 'test'))
  for (const file of tests) await cp(join(desktop, 'test', file), join(scratch, 'test', file))
  // Only the three scoped production modules are restored to exact preimages.
  // Current tests, preserved automation APIs, and other dependencies stay real.
  for (const file of sources) await cp(join(evidence, 'before/frontend/design-desktop/src', file), join(scratch, 'src', file))
  negative = run(scratch, args)
  // Remove the temporary location, leaving actionable test names and stack lines.
  await writeFile(join(rawOutput, 'old-code-negative-control.tap'), negative.output)
  await writeFile(join(evidence, 'old-code-negative-control.tap'), sanitize(negative.output.replaceAll(scratch, '<isolated-preimage>')))
  assert.equal(negative.status, 1, 'Old code must fail the current behavioral tests')
  assert.match(negative.output, /# tests 66\b/)
  assert.match(negative.output, /# fail 13\b/)
  assert.match(negative.output, /# skipped 0\b/)
  const failures = [...negative.output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1])
  assert.equal(failures.length, 13)
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const suffix of [
      'native aliases and renderer profile commands remain distinct',
      'paste-over-selection preserves native repeat, IME, modifier and keyup policy',
      'native paste-over-selection menu is distinct from paste-in-place and replacement',
      'registered paste-over-selection shortcut forwards once and preserves IME and repeat suppression',
    ]) assert.ok(failures.includes(`${platform}: ${suffix}`), `Missing behavioral failure: ${platform}: ${suffix}`)
  }
  assert.ok(failures.includes('command subscription strips IPC event, rejects invalid payloads and removes its own listener'))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
const files = sources.map(file => `src/${file}`)
const result = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  command: `node ${relative(root, fileURLToPath(import.meta.url))}`,
  productionSnapshot: await hashes(desktop, sources.map(file => `src/${file}`)),
  testSnapshot: await hashes(desktop, tests.map(file => `test/${file}`)),
  preimageSnapshot: await hashes(join(evidence, 'before/frontend/design-desktop'), files),
  positive: { status: 'passed', exitCode: positive.status, tests: 66, passed: 66, failed: 0, skipped: 0 },
  oldCodeNegativeControl: { status: 'expected-failure', exitCode: negative.status, tests: 66, passed: 53, failed: 13, skipped: 0 },
  limits: ['Mock Electron and VM preload; not real Electron GUI, OS clipboard, or packaged app.', 'Policy coverage names three platforms, but this process ran on Linux only.', 'No socket, GPU, Rust/WASM build, or native backend runtime test.', 'Renderer graph semantics and editable/modal dispatch belong to the companion client verification.'],
}
await record('results.json', JSON.stringify(result, null, 2) + '\n')
await publishManifest()
console.log('Current production: 66/66 pass. Exact preimage negative control: 13 expected behavioral failures, 53 pass, zero skipped.')
