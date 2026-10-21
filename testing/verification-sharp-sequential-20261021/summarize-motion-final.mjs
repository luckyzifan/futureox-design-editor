// Read existing owned evidence only. Never launch tests, Electron or a GPU.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const directory = path.dirname(fileURLToPath(import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const inputs = {}
async function read(run, file, optional = false) {
  try {
    const raw = await readFile(path.join(directory, run, file))
    inputs[run + '/' + file] = hash(raw)
    return JSON.parse(raw)
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
}
const nullable = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : null
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, nullable(object, key)]))
function errors(rows) {
  if (!Array.isArray(rows)) return null
  return rows.map(row => {
    const text = String(row.error ?? row.message ?? '')
    const reason = text.includes('显示瓦片缓存预算超限') ? 'display-tile-cache-budget-exceeded' :
      text.includes('No bound GPU content capture') ? 'bound-content-capture-unavailable' :
      text.includes('Could not center the original anchor') ? 'anchor-centering-failed' : 'unclassified-see-ignored-raw-record'
    return { phase: typeof row.phase === 'string' ? row.phase : null, reason, rawErrorSha256: hash(text) }
  })
}
async function sourceIdentity(run) {
  const build = await read(run, 'build-manifest.json', true), artifacts = await read(run, 'runtime-artifacts.json', true)
  const before = await read(run, 'inputs-before.json', true), after = await read(run, 'inputs-after.json', true)
  return { buildManifestAvailable: build !== null, runtimeArtifactsAvailable: artifacts !== null,
    inputHashFilesAvailable: before !== null && after !== null,
    inputHashesStable: before !== null && after !== null ? JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(after).sort()) : null,
    inputHashCount: before ? Object.keys(before).length : null }
}
const motion = []
for (const run of ['final-visual-117', 'final-visual-fig', 'candidate-motion-117', 'candidate-motion-fig',
  'original-world-motion-117', 'original-world-motion-fig', 'original-world-fixed-117', 'original-world-fixed-fig',
  'final-default-motion-117', 'final-safe-motion-117', 'final-safe-motion-fig']) {
  const report = await read(run, 'results.json'), gate = report.gate ?? {}, visual = report.visualOmissionGate
  if (run === 'original-world-fixed-fig') {
    // Explicit run-validity correction from orchestration: the final default
    // build began while this process was still pending. Retain the raw result
    // identity/status but withhold metrics from a candidate comparison.
    motion.push({ run, kind: 'whole-electron-motion', status: report.status,
      evidenceValidity: 'invalid-interrupted-runtimebuild-overlap', metricsWithheld: true,
      exclusion: 'The orchestrator recorded that the final default build started while this owned run was still pending. Runtime assets/references and CPU/GPU load were therefore uncontrolled. Exclude this run from latency, visual acceptance and candidate comparisons even if its raw harness status passes.',
      sourceIdentity: await sourceIdentity(run), errors: errors(report.errors),
      visual: { recordedSamples: Array.isArray(report.visual) ? report.visual.length : null,
        sampledNoWhiteOmissionGatePassed: false, scope: 'Invalid overlapped run; no visual acceptance claim.' } })
    continue
  }
  const violations = Array.isArray(gate.violations) ? gate.violations : null
  const kinds = {}; for (const row of violations ?? []) kinds[row.kind ?? 'unclassified'] = (kinds[row.kind ?? 'unclassified'] ?? 0) + 1
  motion.push({ run, kind: 'whole-electron-motion', ...pick(report, ['status', 'mode', 'profile', 'latencyTimingComparable',
    'fixtureSha256', 'harnessSha256', 'documentSha256', 'documentPreserved', 'sourceFilePreserved']),
    recordedPolicyCheckpoint: run.startsWith('final-safe-motion-') ? 'Final safe default build: resident-filter scratch disabled; strict opt-in remains available only as value 1.' :
      run.startsWith('final-default-') ? 'Historical scratch candidate despite directory name; not current accepted default.' : 'Historical source checkpoint; see source identity and candidate scope.',
    evidenceValidity: 'recorded-separate-run', sourceIdentity: await sourceIdentity(run), errors: errors(report.errors),
    recordedStageCount: Array.isArray(report.stages) ? report.stages.length : null,
    sharpness: { ...pick(gate, ['expectedSharp', 'passed', 'minimumSharpCoverage', 'maximumUpscale', 'maximumRequestedZoom', 'maximumAcknowledgedZoom']),
      maximumUpscaleFieldPresent: Object.hasOwn(gate, 'maximumUpscale'), violationCount: violations?.length ?? null, violationKinds: kinds },
    acknowledgements: { ...pick(gate, ['acknowledgementCount', 'motionAcknowledgements', 'settlingAcknowledgements', 'measuredQualityCount']),
      inputToSubmissionAckMs: nullable(gate, 'inputToAckMs'), cameraRequestToSubmissionAckMs: nullable(gate, 'requestToAckMs'),
      actualInputGapsMs: nullable(gate, 'actualInputGapsMs'), meaning: 'Submission ACK, not GPU completion, physical FPS or input-to-photon.' },
    visual: { recordedSamples: Array.isArray(report.visual) ? report.visual.length : null, gatePresent: visual !== undefined,
      ...pick(visual, ['available', 'passed', 'capturedSamples', 'availableReferenceSamples', 'suspiciousComponentCount', 'missingTextureSamples', 'allIntermediateFramesVerified']),
      sampledNoWhiteOmissionGatePassed: visual?.available === true && visual?.passed === true,
      scope: 'Only the recorded bound samples and configured connected-component omission detector; no assertion about every intermediate frame or perceptual sharpness.' } })
}
const feasibilityRun = 'original-viewport-100-4g', feasibilityReport = await read(feasibilityRun, 'results.json'), feasibility = feasibilityReport.result ?? {}
const originalViewportFeasibility = { run: feasibilityRun, kind: 'isolated-original-renderer-feasibility', status: feasibilityReport.status,
  errors: errors(feasibilityReport.errors), sourceIdentity: await sourceIdentity(feasibilityRun),
  ...pick(feasibility, ['sceneSha256', 'documentSha256', 'wasmSha256', 'budgetMiB', 'budgetBytes', 'warmFrames', 'observedFrames',
    'compiledNodes', 'visibleEffects', 'imageSources', 'candidateFlags', 'queueWaitTiming', 'separateRawProbe', 'adapter', 'scope']),
  outputDimensions: feasibility.output ? { width: feasibility.output.w, height: feasibility.output.h } : null,
  effectExtentDimensions: feasibility.extent ? { width: feasibility.extent.w, height: feasibility.extent.h } : null,
  rawProbeAvailable: feasibility.rawProbe != null,
  rows: (feasibility.rows ?? []).map(row => pick(row, ['phase', 'frame', 'renderWallMs', 'graphMs', 'finishMs', 'checkpointMs',
    'postRenderCompletionProbeMs', 'peakTextureBytes', 'workingTextureBytes', 'workingBudgetBytes', 'rasterReadbackBytes'])),
  limitation: 'A single fixed captured scene with one warm and one observed frame at 4 GiB. No raw-pixel oracle, motion, screen/no-blur, edit/undo or low-latency acceptance is implied. Post-render completion probes are separate instrumentation.' }
// Prefer the newest proof even when it failed; never hide a latest failure
// behind an earlier passing source checkpoint. Before v5 exists, v4 remains
// explicitly historical evidence while the final opt-in proof is pending.
const proofV5 = await read('gpu-resident-filter-v5', 'results.json', true)
const proofV5Failure = proofV5 ? null : await read('gpu-resident-filter-v5', 'failure.json', true)
const proofRun = proofV5 || proofV5Failure ? 'gpu-resident-filter-v5' : 'gpu-resident-filter-v4'
const proofReport = proofV5 ?? proofV5Failure ?? await read(proofRun, 'results.json'), proof = proofReport.result ?? {}
const gpuResidentFilterProof = { run: proofRun, kind: 'isolated-actual-webgpu-pixel-and-lifetime-proof', status: proofReport.status,
  policy: { flag: 'VITE_DESIGN_RESIDENT_FILTER_SCRATCH', requiredValue: '1', currentDefaultEnabled: false,
    defaultAcceptance: 'not-accepted', latestOptInSourceProofPending: !proofV5 && !proofV5Failure,
    historicalSourceCheckpoint: proofRun === 'gpu-resident-filter-v4' },
  errors: errors(proofReport.errors), sourceIdentity: await sourceIdentity(proofRun),
  ...pick(proof, ['wasmSha256', 'pngSha256', 'cases', 'components', 'rawDifferences', 'nonfinite', 'proofReadbackBytes', 'source', 'deviceIsolation', 'scope']),
  comparisonFrames: Array.isArray(proof.comparisons) ? proof.comparisons.length : null,
  groups: (proof.records ?? []).map(row => ({ ...pick(row, ['name', 'candidate', 'adapter', 'effectiveRadius', 'frames']),
    beforeProofDrain: pick(row.beforeProofDrain, ['scratchBytes', 'prefixCounterSamples', 'prefixCounterDeferredFrames', 'residentCaptures', 'rasterReadbackBytes']),
    tableRetirements: row.retirements?.length ?? null, actualTableBuilds: row.tableAttempts?.filter(attempt => attempt.admitted).length ?? null,
    frameLedgerEqual: Array.isArray(row.frameRecords) ? row.frameRecords.every(frame => frame.rendererBytes === frame.actualTextureAndScratchBytes) : null,
    pressure: row.pressure ? { ...pick(row.pressure, ['requiredBytes', 'allocated', 'budgetRejected', 'scratchBytes', 'retiredImageTableBytes']),
      admissionCheckpoints: row.pressure.checkpoints?.filter(checkpoint => checkpoint.reason === 'admission').length ?? null } : null,
    cancellation: row.cancellation ? { ...pick(row.cancellation, ['cancelled', 'cancelledPrefixEncodes', 'finishObservationsBefore',
      'finishObservationsAfterCancel', 'recoveryFinishObservations']), scratchAfterAbort: nullable(row.cancellation.afterAbort, 'scratchBytes') } : null })) }
const result = { method: 'Read existing JSON evidence, preserve missing metrics as null, hash inputs, and allowlist numeric/status fields. Raw profiles, documents, camera coordinates, snapshots and embedded camera-bearing error JSON are deliberately omitted.',
  acceptance: { wholeAppMotionSharpnessAccepted: false,
    reason: 'Every recorded whole-app sharpness gate fails or never completes. Isolated GPU parity/feasibility passes are separate gates.',
    residentFilterScratch: { flag: 'VITE_DESIGN_RESIDENT_FILTER_SCRATCH', enabledOnlyBy: '1', defaultEnabled: false,
      acceptedAsDefault: false, retainedOrdinaryChanges: ['logical image-table retirement', 'fits-pool reclamation'],
      decision: 'Final candidate warm-check first 3200% was 1993.338 ms; CPU GPU-queue-completion waits were 1389.6 ms over 10 fences (5 admission/1111.2 ms, 5 periodic/278.4 ms), versus the recorded earlier 878.9 ms wait. Fewer fences did not establish lower latency; scratch residency was restored to strict opt-in.',
      historicalRunLabels: { 'resident-filter-v1-*': 'scratch candidate; not accepted current default',
        'resident-filter-v2-*': 'scratch candidate; not accepted current default',
        'final-default-*': 'directory name is historical; this raw checkpoint still used scratch candidate; not accepted current default' } },
    timingScope: 'All listed whole-app runs are visual-audit; candidate-motion also profiles CPU. Their ACK times are retained as observations, not clean production latency comparisons.',
    missingFields: 'Null is unavailable, unmeasured, or a raw JSON null; never a zero or a passing result. final-visual-117 maximumUpscale null does not establish finite/no enlargement.' },
  motion, originalViewportFeasibility, gpuResidentFilterProof, inputSha256: inputs }
await writeFile(path.join(directory, 'motion-final-summary.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ motion: motion.map(row => ({ run: row.run, status: row.status, sharpnessPassed: row.sharpness?.passed ?? null,
  evidenceValidity: row.evidenceValidity,
  errors: row.errors?.length, visualSamples: row.visual.recordedSamples, visualAvailable: row.visual.available })),
  isolatedFeasibility: originalViewportFeasibility.status, isolatedGpuProof: gpuResidentFilterProof.status }, null, 2))
