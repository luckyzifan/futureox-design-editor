import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const [output, ...flags] = process.argv.slice(2)
if (!output || !path.isAbsolute(output) || !flags.length) throw Error('Usage: ab-render-candidate.mjs ABSOLUTE_OUTPUT ENV_FLAG=1 ...')
const products = path.resolve('frontend/design-desktop/dist')
const runner = path.resolve('testing/verification-sparse-canvas-20261030/run.mjs')
await fs.mkdir(output, { recursive: true })
const variants = [
  { name: 'baseline-1', candidate: false },
  { name: 'candidate-1', candidate: true },
  { name: 'candidate-2', candidate: true },
  { name: 'baseline-2', candidate: false },
]
const runs = []
for (const variant of variants) {
  const directory = path.join(output, variant.name)
  const env = {
    ...process.env,
    VERIFY_FROZEN_BASELINE: '1',
    VERIFY_TIMING_ONLY: '1',
    VERIFY_EXTRA: '1',
    VERIFY_PAN_CYCLES: '1',
  }
  for (const flag of flags) {
    const [key, value] = flag.split('=')
    if (!key || !value) throw Error(`Invalid flag ${flag}`)
    if (variant.candidate) env[key] = value
    else delete env[key]
  }
  const child = spawn(process.execPath, [runner, products, directory, 'topology'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.once('close', resolve))
  if (code !== 0) throw Error(`${variant.name} exited ${code}: ${stderr || stdout}`)
  const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'))
  runs.push({ ...variant, code, report, stdout, stderr })
  await fs.writeFile(path.join(output, 'ab-summary.json'), JSON.stringify({ flags, runs }, null, 2))
  if (code !== 0 || report.status === 'failed' || !report.sourceUnchanged) throw Error(`${variant.name} failed: ${report.error || stderr || stdout}`)
}
const caseData = (run, id) => run.report.cases.find(item => item.id === id)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const compare = (id, field) => {
  const baseline = runs.filter(run => !run.candidate).map(run => caseData(run, id)?.[field]).filter(Number.isFinite)
  const candidate = runs.filter(run => run.candidate).map(run => caseData(run, id)?.[field]).filter(Number.isFinite)
  if (!baseline.length || !candidate.length) return { status: 'NOT_RUN' }
  const before = median(baseline), after = median(candidate)
  return { baseline, candidate, baselineMedian: before, candidateMedian: after, deltaMs: after - before, deltaPercent: (after - before) / before * 100 }
}
const groups = {
  import: compare('import-original', 'wallMs'),
  panStop: compare('continuous-large-pan', 'stopToReadyMs'),
  zoomStop: compare('continuous-reverse-zoom', 'stopToReadyMs'),
  dragStop: compare('selected-material-drag', 'stopToReadyMs'),
  nestedStop: compare('nested-selection-drag-and-history', 'stopToReadyMs'),
}
for (const zoom of [3200, 125, 950, 40.4]) {
  const baseline = runs.filter(run => !run.candidate).flatMap(run => caseData(run, 'high-zoom-return')?.samples || []).filter(sample => sample.zoom === zoom && sample.status === 'PASS').map(sample => sample.readyMs)
  const candidate = runs.filter(run => run.candidate).flatMap(run => caseData(run, 'high-zoom-return')?.samples || []).filter(sample => sample.zoom === zoom && sample.status === 'PASS').map(sample => sample.readyMs)
  if (baseline.length && candidate.length) groups[`zoom-${zoom}`] = { baseline, candidate, baselineMedian: median(baseline), candidateMedian: median(candidate), deltaMs: median(candidate) - median(baseline), deltaPercent: (median(candidate) - median(baseline)) / median(baseline) * 100 }
  else groups[`zoom-${zoom}`] = { status: 'NOT_RUN', baseline, candidate }
}
await fs.writeFile(path.join(output, 'ab-summary.json'), JSON.stringify({ flags, runs, groups }, null, 2))
console.log(JSON.stringify(groups, null, 2))
