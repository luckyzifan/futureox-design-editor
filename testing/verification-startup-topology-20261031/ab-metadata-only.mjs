import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const [baseline, candidate, output, variable = 'CORE_SOURCE_SNAPSHOT_METADATA_ONLY'] = process.argv.slice(2)
if (!baseline || !candidate || !output || !path.isAbsolute(output)) throw Error('Usage: ab-metadata-only.mjs BASELINE_PRODUCTS CANDIDATE_PRODUCTS ABSOLUTE_OUTPUT [ENV_FLAG]')
await fs.mkdir(output, { recursive: true })
const runner = path.resolve('testing/verification-interaction-layout-20261030/native-source-startup.mjs')
const definitions = [
  { name: 'baseline-1', products: baseline, metadataOnly: false },
  { name: 'candidate-1', products: candidate, metadataOnly: true },
  { name: 'candidate-2', products: candidate, metadataOnly: true },
  { name: 'baseline-2', products: baseline, metadataOnly: false },
]
const runs = []
for (const definition of definitions) {
  const directory = path.join(output, definition.name)
  const child = spawn(process.execPath, [runner, definition.products, directory], {
    cwd: process.cwd(),
    env: { ...process.env, ...(definition.metadataOnly ? { [variable]: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.once('close', resolve))
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
  runs.push({ ...definition, code, manifest, stdout, stderr })
  await fs.writeFile(path.join(output, 'ab-summary.json'), JSON.stringify({ runs }, null, 2))
  if (code !== 0 || manifest.status !== 'passed') throw Error(`${definition.name} failed: ${manifest.error || stderr || stdout}`)
}
const stage = (run, name) => run.manifest.stages.find(stage => stage.stage === name)?.ms
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const groups = {}
for (const name of ['source-open', 'whole-source-snapshot', 'native-source-load']) {
  const baselineMs = runs.filter(run => !run.metadataOnly).map(run => stage(run, name))
  const candidateMs = runs.filter(run => run.metadataOnly).map(run => stage(run, name))
  const before = median(baselineMs), after = median(candidateMs)
  groups[name] = { baselineMs, candidateMs, baselineMedian: before, candidateMedian: after,
    deltaMs: after - before, deltaPercent: (after - before) / before * 100 }
}
const summary = { runs, groups }
await fs.writeFile(path.join(output, 'ab-summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(groups, null, 2))
