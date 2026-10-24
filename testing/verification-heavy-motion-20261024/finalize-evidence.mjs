import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildInputs } from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root = process.cwd(), directory = path.join(root, 'testing/verification-heavy-motion-20261024')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const source = await buildInputs(root), builds = []
for (const variant of ['native', 'quality']) {
  const candidate = await json(path.join(directory, 'candidate-images-' + variant + '-6.json'))
  const manifest = await json(path.join(candidate.host, 'dist/build-manifest.json'))
  assert.deepEqual(source, manifest.sources, 'Current source differs from the tested build')
  for (const [name, hash] of Object.entries(candidate.artifacts))
    assert.equal(await digest(path.join(candidate.host, name)), hash)
  builds.push({ ...candidate, sourceFiles: Object.keys(source).length, builtAt: manifest.builtAt })
}
const fixtures = [
  ['01有料素材 (Copy).fig', '701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46'],
  ['拓扑素材.sketch', 'b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12'],
  ['117.sketch', 'd494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70'],
  ['design-combined-f031-after-terminal-dev.zip', 'c61ad15d8396b172b0aa5e0885c765a66a0a0a159c23474d28228f61de1294b1'],
]
for (const [name, hash] of fixtures) assert.equal(await digest(path.join('/Users/Apple/Downloads', name)), hash)
const sketch = await json(path.join(directory, 'sketch-foreground-6.json'))
const exportHash = await digest(sketch.exportFile)
assert.equal(exportHash, '4eeae3b850e2807fec1b3d13fc9ed5f4172c1d02ac726828035af8f336918af2')
const hardware = await json(path.join(directory, 'tile-image-residency-6.json'))
assert.equal(hardware.status, 'passed')
const pixels = hardware.cases.flatMap(row => [...row.runs, ...row.emptyRegions])
assert(pixels.every(row => row.mismatches === 0))
const functional = []
for (const kind of ['fig', '117']) {
  const report = await json(path.join(directory, kind + '-foreground-6/report.json'))
  assert.equal(report.status, 'passed')
  assert(report.foreground.every(row => row.focused && row.visible === 'visible'))
  functional.push({ kind, status: report.status, checks: report.checks, foreground: report.foreground })
}
assert.equal(sketch.status, 'passed')
assert(sketch.foreground.every(row => row.focused && row.visible === 'visible'))
functional.push({ kind: 'sketch', status: sketch.status, cases: sketch.cases })
const motion = []
for (const kind of ['fig', '117', 'sketch']) {
  const report = await json(path.join(directory, kind + '-foreground-motion-6/report.json'))
  const quality = await json(path.join(directory, kind + '-foreground-motion-6-quality.json'))
  assert(report.foreground.focused && report.foreground.visible === 'visible')
  assert.deepEqual(report.foregroundEvents, [])
  assert.equal(report.inputs.length, 160)
  motion.push({ kind, status: 'FAIL', inputs: report.inputs.length, foreground: report.foreground,
    nonSharpSubmits: quality.nonSharpSubmits, cameraSubmits: quality.cameraSubmits,
    maxUpscale: quality.maxUpscale, dispatchStoppedToConvergenceMs: quality.dispatchStoppedToConvergenceMs,
    lastReceiptAfterDispatchStoppedMs: quality.lastReceiptAfterDispatchStoppedMs,
    foregroundRejects: quality.foregroundRejects, surfaceRejects: quality.surfaceRejects })
}
const regressions = await json(path.join(directory, 'regressions-6.json'))
assert(regressions.every(row => row.code === 0))
const evidence = {}
for (const name of [
  'tile-image-residency-6.json', 'image-profile-comparison.json', 'coverage-profile-comparison.json',
  'client-regressions-6.log', 'maintenance-regressions-6.log', 'host-regressions-6.log',
  'actual-5gib.log', 'native-tests.json', 'zip-integration-applied.json', 'zip-integration-resolved.json',
  'foreground-runs-6.json', 'admission-classification-audit.json',
]) evidence[name] = await digest(path.join(directory, name))
const result = {
  capturedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  outcome: 'NOT ACCEPTED: functional round trips and targeted hardware parity pass; native motion clarity still fails',
  policy: 'No GPU budget increase, precision reduction, original-file mutation or foreign-process control. Experiments remain default-off.',
  builds, fixtures: fixtures.map(([name, sha256]) => ({ path: path.join('/Users/Apple/Downloads', name), sha256 })),
  topologyExport: { path: sketch.exportFile, sha256: exportHash, bytes: sketch.exportBytes,
    oracle: 'byte-identical to the separately SAX-verified complete archive: 63 unchanged members and six authored field changes' },
  hardware: { outputFrames: pixels.length, referenceFrames: hardware.cases.length * 2 * 2,
    bitwiseComparisons: pixels.length - hardware.cases.length * 2 * 2, mismatches: 0, scope: hardware.scope }, functional, motion,
  tests: { client: 397, maintenance: 14, desktop: 27, result: 'PASS', scope: 'targeted regressions, not full G2/G5 or hardware-loss acceptance' },
  evidence,
}
await writeFile(path.join(directory, 'final-evidence.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ sourceFiles: Object.keys(source).length, hardwareOutputs: pixels.length, tests: result.tests, outcome: result.outcome }))
