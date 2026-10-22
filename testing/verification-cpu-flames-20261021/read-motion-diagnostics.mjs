// Existing-log attribution alongside, never in place of, sampled CPU flames.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const arguments_ = process.argv.slice(2), prefix = arguments_.shift() ?? 'candidate-motion'
if (!/^[a-z0-9-]+$/.test(prefix)) throw Error('Expected a run prefix')
let runsRoot = path.join(root, 'testing/verification-sharp-sequential-20261021'),
  output = path.join(root, 'testing/verification-cpu-flames-20261021', prefix, 'diagnostics')
for (let index = 0; index < arguments_.length; index += 2) {
  const flag = arguments_[index], value = arguments_[index + 1]
  if (!value || !['--runs-root', '--out-dir'].includes(flag)) throw Error('Expected --runs-root DIR or --out-dir DIR')
  if (flag === '--runs-root') runsRoot = path.resolve(value)
  else output = path.resolve(value)
}
const sha = data => createHash('sha256').update(data).digest('hex')
const count = (rows, key) => Object.fromEntries([...rows.reduce((map, row) => {
  const value = key(row); map.set(value, (map.get(value) ?? 0) + 1); return map
}, new Map())].sort(([a], [b]) => String(a).localeCompare(String(b))))
const results = []
for (const fixture of ['117', 'fig']) {
  const directory = path.join(runsRoot, prefix + '-' + fixture)
  const inputs = {}, read = async file => { const raw = await readFile(path.join(directory, file)); inputs[file] = sha(raw); return raw.toString('utf8') }
  const report = JSON.parse(await read('results.json')), trace = JSON.parse(await read('zoom-trace.json'))
  const boundary = report.cpuProfileTraceBoundary
  if (report.profile !== true || !Number.isFinite(boundary?.startAt) || !Number.isFinite(boundary?.endAt)) throw Error('Missing actual profiled trace boundary')
  const rows = [], seen = new Set(); let duplicateRows = 0
  for (const line of (await read('host-stdout.log')).split('\n')) {
    const marker = line.indexOf('[render-diag] ')
    if (marker < 0) continue
    const value = JSON.parse(line.slice(marker + '[render-diag] '.length))
    for (const row of value.batch ?? [value]) if (row.at >= boundary.startAt && row.at <= boundary.endAt) {
      // Forwarded worker batches may reach the same native log twice. Only
      // complete source/session/sequence identities can certify duplication;
      // missing identities remain distinct rather than being guessed away.
      const complete = Number.isSafeInteger(row.session) && row.session > 0 &&
        typeof row.source === 'string' && row.source.length > 0 && Number.isSafeInteger(row.seq) && row.seq >= 0
      const key = complete ? JSON.stringify([row.session, row.source, row.seq]) : undefined
      if (key && seen.has(key)) { duplicateRows++; continue }
      if (key) seen.add(key)
      rows.push(row)
    }
  }
  const only = (source, event) => rows.filter(row => row.source === source && row.event === event)
  const requests = only('main', 'request'), errors = only('worker', 'error'), completed = only('main', 'result')
  const cancellations = new Map(errors.filter(row => row.failureCategory === 1 && row.failureCode === 1).map(row => [row.requestId, row]))
  const unsupported = errors.filter(row => row.failureCategory === 2 && row.failureCode === 65)
  const fences = only('worker', 'fence'), starts = only('worker', 'queue-start'), skips = only('worker', 'skip')
  const lastInput = trace.inputs.at(-1)?.at
  const fallbackRequests = requests.filter(row => row.tileViewport === 1).map(row => ({ requestId: row.requestId,
    sinceLastInputMs: Number((row.at - lastInput).toFixed(3)), livePreview: row.livePreview, tileViewport: row.tileViewport,
    cancelled: cancellations.has(row.requestId), completed: completed.some(result => result.requestId === row.requestId),
    tilesObserved: only('main', 'tile').filter(tile => tile.requestId === row.requestId).length }))
  results.push({ fixture, inputs, traceBoundary: boundary, reportMode: report.mode, latencyTimingComparable: report.latencyTimingComparable,
    rowsInTrace: rows.length, duplicateRows, eventCounts: count(rows, row => row.source + '/' + row.event),
    requests: requests.length, completedResults: completed.length, unsupportedErrors: unsupported.length, truePreviewCancellations: cancellations.size,
    rejectionStates: count(skips, row => `reason=${row.reasonCode},state=${row.state}`),
    rejectionCandidateCounts: count(skips, row => `reason=${row.reasonCode},state=${row.state},candidates=${row.count}`),
    queueStarts: starts.length, maximumObservedQueueStartWaitMs: Math.max(0, ...starts.map(row => row.waitMs ?? 0)),
    fences: [...new Set(fences.map(row => row.reasonCode))].sort((a,b) => a-b).map(reasonCode => ({ reasonCode,
      count: fences.filter(row => row.reasonCode === reasonCode).length,
      observedCpuQueueCompletionWaitSumMs: Number(fences.filter(row => row.reasonCode === reasonCode).reduce((sum,row) => sum + row.queueWaitMs, 0).toFixed(3)),
      unsupportedRequestCount: fences.filter(row => row.reasonCode === reasonCode && unsupported.some(error => error.requestId === row.requestId)).length })),
    fallbackRequests, sharpnessGate: { maximumUpscale: report.gate.maximumUpscale, minimumSharpCoverage: report.gate.minimumSharpCoverage,
      passed: report.gate.passed }, visualOmissionGate: report.visualOmissionGate })
}
await mkdir(output, { recursive: true })
await writeFile(path.join(output, 'summary.json'), JSON.stringify({
  method: 'Parse actual existing host render-diag records, expand batches, retain rows whose epoch timestamp lies in the recorded native motion trace boundary; correlate existing request IDs. No new application/test/GPU work. CPU flamegraphs are separate evidence.',
  classifications: { failureCategory1Code1: 'PREVIEW_CANCELLED', failureCategory2Code65: 'SEQUENTIAL_DISPLAY_UNSUPPORTED',
    skip602State1: 'sequential plan scenePolicy', skip602State14: 'sequential plan materialCount (>1)',
    fenceReason5: 'periodic', fenceReason6: 'admission', fenceReason8: 'cancel cleanup (also used after an unsupported sequential graph)' },
  limitations: ['Diagnostic durations are actual logged CPU queue-completion observations, not sampled CPU weights, hardware timestamps or a partition of idle time.',
    'A cancel cleanup fence does not establish a PREVIEW_CANCELLED result. Actual error classifications and request IDs are correlated separately.',
    'The scenePolicy code does not identify its individual rejected boolean; that subcondition was not recorded.',
    'A missing completed result during motion and later native tile completion support an admission/fallback progression diagnosis, not proof of CPU saturation.',
    'These runs enable CPU profiling and visual capture; their latency values cannot be used as clean production benchmarks.'], results }, null, 2) + '\n')
console.log(JSON.stringify(results.map(row => ({ fixture: row.fixture, requests: row.requests, unsupported: row.unsupportedErrors,
  trueCancellations: row.truePreviewCancellations, completed: row.completedResults,
  fallbackRequests: row.fallbackRequests.length, completedFallbackRequests: row.fallbackRequests.filter(request => request.completed).length,
  duplicateRows: row.duplicateRows, fences: row.fences })), null, 2))
