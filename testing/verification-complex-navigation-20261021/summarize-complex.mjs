// Read existing owned results only. Never launch Electron, a profiler or a GPU.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const home = path.dirname(fileURLToPath(import.meta.url)), inputs = {}
const hash = raw => createHash('sha256').update(raw).digest('hex')
async function read(run, file) {
  try { const raw = await readFile(path.join(home, run, file)); inputs[run + '/' + file] = hash(raw); return JSON.parse(raw) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, Object.hasOwn(value ?? {}, key) ? value[key] : null]))
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value :
  typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null
const numbers = (value, keys) => Object.fromEntries(keys.map(key => [key, numeric(value?.[key])]))
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
const allowedKinds = new Set(['quality-not-fresh', 'incomplete-or-under-density', 'upscaled-content', 'camera-ack-lag', 'input-ack-lag', 'pan-input-ack-lag'])
const allowedPhases = new Set(['input-validation', 'sampled-visual-inconsistency', 'settling', 'visual-reference-unavailable'])
const enumCount = (values, allowed) => {
  const counts = {}
  for (const value of values) { const key = allowed.has(value) ? value : 'other'; counts[key] = (counts[key] ?? 0) + 1 }
  return counts
}
const state = value => ({
  canvasErrorCount: value ? (value.errors?.length ?? 0) : null,
  presentationReady: value?.presentation?.presentationReady === undefined ? null : value.presentation.presentationReady === 'true',
  detailReady: value?.tiles?.detailReady === undefined ? null : value.tiles.detailReady === 'true',
  compositor: numbers(value?.compositor, ['missingTextureCount', 'deviceLogicalPayloadBytes', 'deviceRetiringPayloadBytes', 'compositorBytes', 'compositorOverlayBytes']),
  cache: numbers(value?.tiles, ['residentBytes', 'residentBudget', 'activeResidentBudget', 'cacheSteadyBudget', 'cacheStagingLimit',
    'cacheAdmissionBudget', 'cacheActiveBytes', 'cacheActiveHighwater', 'cacheTotalHighwater']),
})
const cpuRun = '../verification-functional-merge-20261021'
const cpu = await read(cpuRun, 'final-cpu-summary.json')
const shaValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
const phaseNames = new Set(['client-vitest', 'desktop-node', 'desktop-preparation', 'frontend-node', 'mcp-check', 'mcp-unit', 'mcp-clipboard', 'mcp-socket'])
const fullCpuVerification = {
  summary: '../verification-functional-merge-20261021/final-cpu-summary.json',
  summarySha256: inputs[cpuRun + '/final-cpu-summary.json'] ?? null,
  available: !!cpu, completed: typeof cpu?.finishedAtUtc === 'string', passed: cpu?.passed === true,
  sourceStable: cpu?.sourceStable ?? null, runtimeStable: cpu?.runtimeStable ?? null,
  selectedDesktopDistStable: cpu?.selectedDesktopDistStable ?? null,
  sourceFiles: numeric(cpu?.sourceBefore?.files), sourceSha256: shaValue(cpu?.sourceBefore?.sha256),
  selectedManifestSha256: shaValue(cpu?.selectedDesktopDistBefore?.manifestSha256),
  selectedReleaseProfile: cpu?.selectedDesktopDistBefore?.profile === 'release',
  selectedManifestValidBefore: cpu?.selectedDesktopDistBefore?.valid ?? null,
  selectedManifestValidAfter: cpu?.selectedDesktopDistAfter?.valid ?? null,
  changedSourcePathCount: cpu?.changedSourcePaths?.length ?? null,
  optionalNativeCorpusEnabled: cpu?.optionalNativeCorpusEnabled ?? null,
  canvasReproducerEnabled: cpu?.canvasReproducerEnabled ?? null,
  fixtureSha256: { '117.sketch': shaValue(cpu?.fixtureInputs?.['117.sketch']), FIG: shaValue(cpu?.fixtureInputs?.FIG) },
  phases: (cpu?.gates ?? []).map(gate => ({ name: phaseNames.has(gate.name) ? gate.name : 'other',
    exitCode: numeric(gate.exitCode), passed: gate.status === 'passed',
    counts: numbers(gate.counts, ['total', 'passed', 'failed', 'skipped', 'todo', 'suitesPassed', 'suitesFailed', 'tests', 'pass', 'fail', 'cancelled']) })),
  scope: 'Read-only correlation with the completed CPU result. Historical motion observations, raw failures and GPU acceptance gates are unchanged.',
}
const runs = []
for (const run of ['baseline-stress-117', 'fixed-stress-117', 'fixed-stress-fig', 'final-stress-117', 'verified-stress-117', 'verified-stress-fig']) {
  const result = await read(run, 'results.json')
  if (!result) { runs.push({ run, available: false }); continue }
  const trace = await read(run, 'zoom-trace.json'), build = await read(run, 'build-manifest.json')
  const before = await read(run, 'inputs-before.json'), after = await read(run, 'inputs-after.json')
  const runtime = await read(run, 'runtime-artifacts.json')
  const gate = result.gate ?? {}, kinds = enumCount((gate.violations ?? []).map(row => row.kind), allowedKinds)
  const identity = object => object && JSON.stringify(Object.entries(object).sort())
  const errorPhases = enumCount((result.errors ?? []).map(row => row.phase), allowedPhases)
  const references = (result.visual ?? []).map(row => row.reference).filter(Boolean)
  const missingCounts = (trace?.acks ?? []).map(row => numeric(row.missingTextureCount))
  const quality = result.visualOmissionGate
  const driver = result.gpuMemory?.driverStats
  const appErrors = (result.errors ?? []).filter(row => row.phase !== 'visual-reference-unavailable')
  const assets = runtime?.artifacts && Object.fromEntries(Object.entries(runtime.artifacts).map(([name, sha]) => [path.basename(name), sha]))
  runs.push({ run, available: true, ...pick(result, ['status', 'mode', 'profile', 'latencyTimingComparable', 'fixtureSha256',
    'harnessSha256', 'documentPreserved', 'sourceFilePreserved']),
    buildProfile: build?.profile ?? null, inputHashFilesAvailable: !!before && !!after,
    inputHashesStable: before && after ? identity(before) === identity(after) : null,
    buildSourceFiles: build?.sources ? Object.keys(build.sources).length : null,
    buildSourceSha256: build?.sources ? hash(canonical(build.sources)) : null,
    runtimeCapturedAssetFiles: assets ? Object.keys(assets).length : null,
    runtimeCapturedAssetBasenameSha256: assets ? hash(canonical(assets)) : null,
    runtimeCapturedWasmSha256: assets ? Object.entries(assets).find(([name]) => /^design_kernel_bg.*\.wasm$/.test(name))?.[1] ?? null : null,
    workload: { ...numbers(result.workload, ['cycles', 'startZoom', 'reverseTo', 'intervalMs', 'maximumDelta']),
      stress: result.workload?.stress === true, stageCount: result.stages?.length ?? null,
      stagesSettledBetweenActions: (result.stages ?? []).filter(row => row.settledBetweenStages === true).length },
    wheelInputs: trace?.inputs.length ?? null, panPointerMoves: trace?.panInputs.length ?? null,
    panGestures: trace?.scriptedPans.length ?? null,
    traceDurationMs: trace ? trace.endAt - trace.startAt : null,
    sharpness: { ...pick(gate, ['passed', 'expectedSharp', 'minimumSharpCoverage', 'maximumUpscale', 'maximumRequestedZoom',
      'maximumAcknowledgedZoom', 'acknowledgementCount', 'panInputCount']), violationCount: gate.violations?.length ?? null, violationKinds: kinds },
    acknowledgements: { inputToAckMs: numbers(gate.inputToAckMs, ['p50', 'p95', 'max']),
      requestToAckMs: numbers(gate.requestToAckMs, ['p50', 'p95', 'max']), actualInputGapsMs: numbers(gate.actualInputGapsMs, ['p50', 'p95', 'max']),
      motion: numeric(gate.motionAcknowledgements), settling: numeric(gate.settlingAcknowledgements), measuredQuality: numeric(gate.measuredQualityCount),
      missingTextureNonzeroCount: missingCounts.filter(value => value !== null && value > 0).length,
      missingTextureUnknownCount: missingCounts.filter(value => value === null).length },
    visual: quality ? { ...numbers(quality, ['capturedSamples', 'availableReferenceSamples', 'boundSamples', 'suspiciousComponentCount', 'missingTextureSamples', 'errorCount']),
      ...pick(quality, ['available', 'passed', 'allIntermediateFramesVerified']), missingRequiredLabelCount: quality.missingRequiredLabels?.length ?? null } : null,
    referenceOnly: { ...numbers(result.referenceBudgetPolicy, ['requestedOverrideMiB']),
      actualAppPolicyUnchanged: result.referenceBudgetPolicy?.actualAppPolicyUnchanged ?? null,
      appExplicitWorkingBudgetMiB: numeric(result.visualReference?.observedExecutionPolicy?.gpuWorkingBudgetMiB),
      unavailableCount: references.filter(row => row.available === false).length,
      nativeSurfaceBudgetFailureCount: references.filter(row => row.available === false && row.error?.includes('GPU surface budget exceeded')).length },
    rawErrorCount: result.errors?.length ?? 0, rawErrorPhaseCounts: errorPhases,
    recordedApplicationErrorCount: appErrors.length,
    recordedApplicationBudgetErrorCount: appErrors.filter(row => /budget|预算/i.test(row.error ?? '')).length,
    observedState: { before: state(result.before), after: state(result.after) },
    queriedAppMemory: { observedAfterTrace: !!result.gpuMemoryObservation,
      observationErrorCount: result.gpuMemoryObservation?.errors?.length ?? null,
      ...numbers(result.gpuMemory?.rendererPolicy, ['workingBudgetBytes', 'interactionBudgetBytes']),
      driverStats: numbers(driver, ['textureBytes', 'displayTextureBytes', 'scratchBytes', 'transientBytes', 'curveBufferBytes', 'uniformBufferBytes', 'rasterReadbackBytes', 'crossDeviceBitmaps']),
      queueTimingEnabled: driver?.queueWaits?.timingEnabled ?? null,
      cpuQueueWaitMs: driver?.queueWaits?.timingEnabled === true ? numeric(driver.queueWaits.cpuWaitMs) : null },
    sampling: { cpuProfileEnabled: result.profile === true,
      rendererAndAutoAttachedWorkerProfiles: result.profileScope?.includes('renderer and CDP-auto-attached worker') ?? false,
      nativeSampler: result.profileScope?.includes('no native sampler') ? false : null,
      visualAudit: result.mode === 'visual-audit', cleanLatencyComparable: result.latencyTimingComparable === true },
    limitation: run === 'baseline-stress-117' ? 'Historical first harness: strict double-only wheel comparison rejected valid native float32 deltas; its transparent-white-page component was independently classified as white page background, not authored-content omission. Raw failed result remains unchanged. Wheel anchors also differ from the latest harness, so no matched latency comparison.' :
      'Bound recorded samples only. Submission ACK is not GPU completion, physical FPS or input-to-photon; visual/profile instrumentation prevents a clean production latency comparison.' })
}
await writeFile(path.join(home, 'complex-summary.json'), JSON.stringify({
  method: 'Allowlisted aggregate fields read from owned real Electron result/trace files; raw document, IDs, camera coordinates, pixels, private paths and unsanitized errors excluded.',
  acceptance: { continuousSharpZoomAccepted: false, allIntermediateFramesVerified: false,
    latestFullCpuRegressionPending: !fullCpuVerification.completed,
    latestFullCpuRegressionPassed: fullCpuVerification.passed, totalAcceptancePassed: false,
    reason: 'Per-run sharpness and omission gates are separate. A sampled no-omission result does not establish no blur or no missing content in every frame.' }, runs, inputSha256: inputs,
  fullCpuVerification,
}, null, 2) + '\n')
console.log(JSON.stringify(runs.map(row => ({ run: row.run, available: row.available, status: row.status,
  sharpnessPassed: row.sharpness?.passed, omissionPassed: row.visual?.passed }))))
