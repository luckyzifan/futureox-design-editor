const finite = n => typeof n === 'number' && Number.isFinite(n)
const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
export function imageName(index, stage) {
  if (!Number.isSafeInteger(index) || index < 0 || !['ready', 'quiet'].includes(stage)) throw Error('Invalid evidence identity')
  return `pose-${index}-${stage === 'ready' ? 'live' : 'fresh'}`
}
export const sameCamera = (a, b) => !!a && !!b && ['x', 'y', 'zoom'].every(k => finite(a[k]) && a[k] === b[k])
export const countRenderStalls = rows => rows.filter(r => r.visible === true && ['render', 'motion', 'drain'].includes(r.stage)).length
export function rasterMetric(requests, key, mode = 'sum') {
  const values = requests.filter(r => r.tiles > 0 && !r.error).map(r => r[key]).filter(finite)
  return values.length ? mode === 'max' ? Math.max(...values) : values.reduce((a,b) => a+b, 0) : null
}
export function pixelFailures(pixels, target, runtime, config) {
  const errors = []
  if (!pixels || !sha(pixels.sha256) || !finite(pixels.changedPixels) || pixels.changedPixels < config.guards.minChangedPixels) errors.push('blank-or-missing-pixels')
  if (!pixels || !finite(pixels.transparentPixels) || pixels.transparentPixels > config.guards.maxTransparentPixels) errors.push('unexpected-transparency')
  if (!sameCamera(pixels?.frame?.view, target) || pixels?.frame?.dpr !== runtime?.dpr) errors.push('stale-pixels')
  if (pixels?.width !== Math.ceil(config.viewport.width * runtime?.dpr) || pixels?.height !== Math.ceil(config.viewport.height * runtime?.dpr)) errors.push('pixel-size')
  return errors
}
/** Facts are validated separately from latency policy and visual fidelity. */
export function evaluateReport(report, config) {
  const failures = [], cases = []
  if (report.source?.roots !== config.sourceRoots || report.source?.nodes !== config.sourceNodes) failures.push('source-coverage')
  if (!finite(report.runtime?.dpr) || report.runtime.dpr <= 0 || report.runtime?.executionPolicy?.cpuOnly !== false) failures.push('runtime-unproved')
  const rows = report.samples || []
  if (new Set(rows.map(r => r.id)).size !== rows.length) failures.push('duplicate-case')
  for (const spec of config.cases) {
    const row = rows.find(r => r.id === spec.id), errors = []
    if (!row || row.status !== 'complete') errors.push('incomplete')
    else {
      if (row.errors?.length) errors.push('render-error')
      for (const stage of ['readyPixels', 'quietPixels']) errors.push(...pixelFailures(row[stage], row.target, report.runtime, config).map(e => `${stage}:${e}`))
      if (row.readyPixels?.sha256 !== row.quietPixels?.sha256) errors.push('settled-pixel-drift')
      const q = row.qualityAtReady
      if (!q || q.presented?.presentationId !== row.readyFrame?.presentationId || !sameCamera(q.presented?.view, row.target) || q.presented?.dpr !== report.runtime.dpr || q.nativeCoverageComplete !== true || q.pixelCoverageComplete !== true || !finite(q.maxUpscale) || q.maxUpscale > 1 + 1e-10 || q.nativePhaseCoverage !== 1) errors.push('ready-quality-unproved')
      if (!row.requests?.some(r => r.tiles > 0 && r.backend === 'webgpu' && !r.error)) errors.push('backend-unproved')
      if (!finite(row.visibleUiStalls) || row.visibleUiStalls > 0) errors.push('ui-stall-or-missing')
      if (row.drained !== true || row.activeAfterQuiet !== 0) errors.push('queue-not-drained')
      if (!finite(row.readyAt) || !finite(row.finalTargetAt) || row.readyAt < row.finalTargetAt || !finite(row.stopToReadyMs) || Math.abs(row.readyAt - row.finalTargetAt - row.stopToReadyMs) > 1e-6) errors.push('timing-inconsistent')
      if (spec.motion === 'fresh' && (sameCamera(row.initialTarget, row.target) || row.target.zoom !== spec.zoom || !row.inputs?.length)) errors.push('fresh-target-not-exercised')
    }
    failures.push(...errors.map(e => `${spec.id}:${e}`)); cases.push({id: spec.id, status: errors.length ? 'FAIL' : 'PASS', failures: errors})
  }
  for (const group of new Set(config.cases.map(c => c.equivalence).filter(Boolean))) {
    const specs = config.cases.filter(c => c.equivalence === group), members = specs.map(s => rows.find(r => r.id === s.id))
    if (members.some(r => r?.status !== 'complete' || !sha(r.quietPixels?.sha256)) || new Set(members.map(r => r?.quietPixels?.sha256)).size !== 1) failures.push(`equivalence:${group}`)
  }
  return {status: failures.length ? 'FAIL' : 'PASS', failures, cases,
    latency: {status: 'BLOCKED', reason: 'No approved absolute input-to-pixel thresholds; controller inputs and GPU readback are not physical presentation.'},
    visualFidelity: {status: 'NOT_RUN', reason: 'Repeatability does not establish independent font/effect visual correctness.'}}
}
