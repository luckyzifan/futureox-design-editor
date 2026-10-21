import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import detector from '../../../testing/verification-electron-display-tier-20261021/visual-omission.cjs'

const thresholds = { transparentMaxAlpha: 4, referenceOpaqueMinAlpha: 240, nearWhiteMin: 250, referenceContentContrast: 32 }
const sample = label => ({ label, file: label + '.png', matchedAcknowledgement: 0,
  acknowledgement: { missingTextureCount: 0 }, reference: { available: true,
    comparison: { suspiciousComponentCount: 0, sampledOmissionPassed: true } } })
const stressSamples = () => [...detector.requiredVisualLabels.map(sample),
  ...Array.from({ length: 9 }, (_, i) => sample('stress-pan-' + i))]

const observedPolicy = () => ({ cpuOnly: false, hdrCompositing: false, imageMips: false,
  imageAtlas: false, desktopFullMath: true, desktopDisplay: true })
test('independent reference budget override changes only its cloned GPU working budget', () => {
  for (const existing of [undefined, 256, 4096]) {
    const observed = Object.freeze({ ...observedPolicy(), ...(existing === undefined ? {} : { gpuWorkingBudgetMiB: existing }) })
    const before = JSON.stringify(observed), reference = detector.referenceExecutionPolicy(observed, 1024)
    assert.notEqual(reference, observed)
    assert.deepEqual(reference, { ...observed, gpuWorkingBudgetMiB: 1024 })
    for (const key of Object.keys(observedPolicy())) assert.equal(reference[key], observed[key])
    assert.equal(JSON.stringify(observed), before)
  }
})
test('absent reference budget preserves all observed policy fields and omission exactly', () => {
  for (const observed of [observedPolicy(), { ...observedPolicy(), gpuWorkingBudgetMiB: 512 },
    { ...observedPolicy(), gpuWorkingBudgetMiB: undefined }]) {
    const copy = detector.referenceExecutionPolicy(observed)
    assert.notEqual(copy, observed)
    assert.deepEqual(copy, observed)
    assert.deepEqual(Object.keys(copy), Object.keys(observed))
    assert.equal(Object.hasOwn(copy, 'gpuWorkingBudgetMiB'), Object.hasOwn(observed, 'gpuWorkingBudgetMiB'))
  }
})
test('reference policy rejects invalid override and missing or invalid observed authority', () => {
  for (const invalid of [null, 255, 4097, 1024.5, NaN, Infinity, '1024', true, {}, { desktopFullMath: false }])
    assert.throws(() => detector.referenceExecutionPolicy(observedPolicy(), invalid), /Reference working budget/)
  for (const invalid of [null, undefined, {}, { ...observedPolicy(), desktopFullMath: undefined },
    { ...observedPolicy(), gpuWorkingBudgetMiB: 255 }])
    assert.throws(() => detector.referenceExecutionPolicy(invalid, 1024), /Reference requires|Reference working budget/)
  assert.equal(detector.referenceExecutionPolicy(observedPolicy(), 256).gpuWorkingBudgetMiB, 256)
  assert.equal(detector.referenceExecutionPolicy(observedPolicy(), 4096).gpuWorkingBudgetMiB, 4096)
})
test('stress capture reserves two distinct opportunities per cycle without consuming later cycles', () => {
  const captured = new Set(), select = phase => detector.nextStressVisualCapture(phase, 6, captured)
  for (let cycle = 1; cycle <= 6; cycle++) {
    for (const phase of [`cycle-${cycle}-pan-32-out`, `cycle-${cycle}-pan-0.25-return`]) {
      const label = select(phase)
      assert.equal(label, 'stress-' + phase)
      captured.add(label)
      for (let repeat = 0; repeat < 20; repeat++) assert.equal(select(phase), null)
    }
    assert.equal(captured.size, cycle * 2)
  }
  assert.deepEqual([...captured], detector.stressVisualCaptureLabels(6))
})
test('stress capture ignores unsupported phases, invalid cycles and pending capture without spending a reservation', () => {
  const captured = new Set()
  for (const phase of ['setup', 'settling', 'up-cycle-1-to-32', 'cycle-1-pan-32-return', 'cycle-1-pan-0.25-out',
    'cycle-1-pan-16-out', 'cycle-0-pan-32-out', 'cycle-7-pan-32-out', 'cycle-01-pan-32-out', 'cycle-1-pan-32-out-extra'])
    assert.equal(detector.nextStressVisualCapture(phase, 6, captured), null)
  for (const cycles of [0, 7, 1.5, NaN]) assert.equal(detector.nextStressVisualCapture('cycle-1-pan-32-out', cycles, captured), null)
  assert.equal(detector.nextStressVisualCapture('cycle-1-pan-32-out', 6, captured, true), null)
  assert.equal(captured.size, 0)
  assert.equal(detector.nextStressVisualCapture('cycle-1-pan-32-out', 6, captured, false), 'stress-cycle-1-pan-32-out')
})
test('sampled visual gate accepts the four required bound captures and all thirteen stress captures', () => {
  const gate = detector.assessSampledVisualOmission
  assert.equal(gate(detector.requiredVisualLabels.map(sample)).passed, true)
  const result = gate(stressSamples())
  assert.equal(result.available, true)
  assert.equal(result.passed, true)
  assert.equal(result.capturedSamples, 13)
  assert.equal(result.availableReferenceSamples, 13)
  assert.equal(result.boundSamples, 13)
  assert.equal(result.allIntermediateFramesVerified, false)
  assert.deepEqual(result.missingRequiredLabels, [])
})
test('sampled visual gate retains every additional stress capture failure', () => {
  const changes = [
    row => { row.reference.comparison.sampledOmissionPassed = false },
    row => { row.reference.comparison.suspiciousComponentCount = 1 },
    row => { row.reference.available = false },
    row => { row.reference.error = 'Reference worker failed' },
    row => { row.acknowledgement.missingTextureCount = 1 },
    row => { delete row.acknowledgement.missingTextureCount },
    row => { row.matchedAcknowledgement = -1 },
    row => { delete row.file },
    row => { row.error = 'Actual capture failed' },
  ]
  for (const change of changes) {
    const rows = stressSamples(); change(rows[12])
    assert.equal(detector.assessSampledVisualOmission(rows).passed, false)
  }
  assert.equal(detector.assessSampledVisualOmission(stressSamples(), [{ phase: 'visual-audit', error: 'Observed failure' }]).passed, false)
})
test('sample count and duplicate captures cannot replace any required bound milestone', () => {
  const gate = detector.assessSampledVisualOmission
  const omitted = stressSamples().filter(row => row.label !== 'down-below-700')
  assert.equal(gate(omitted).passed, false)
  assert.deepEqual(gate(omitted).missingRequiredLabels, ['down-below-700'])
  const duplicate = stressSamples(); duplicate[2] = sample('up-near-700')
  assert.equal(duplicate.length, 13)
  assert.equal(gate(duplicate).available, false)
  assert.deepEqual(gate(duplicate).missingRequiredLabels, ['down-below-700'])
  const unbound = stressSamples(); unbound[2].matchedAcknowledgement = -1
  assert.equal(gate(unbound).passed, false)
  assert.deepEqual(gate(unbound).missingRequiredLabels, ['down-below-700'])
})
test('native wheel validation accepts its actual binary32 event representation, not arbitrary changed input', () => {
  const match = detector.nativeWheelDeltaMatches, command = 81.34342130653886
  assert.equal(match(command, Math.fround(command)), true)
  assert.equal(match(command, command), true)
  assert.equal(match(command, command + .001), false)
  assert.equal(match(command, -command), false)
  assert.equal(match(command, NaN), false)
})
test('transparent white page background is not missing content, while missing dark content is', () => {
  const detect = detector.transparentContentOmission
  assert.equal(detect(0, [255, 255, 255, 255], 0, [255, 255, 255, 255], thresholds), false)
  assert.equal(detect(0, [0, 20, 64, 255], 0, [255, 255, 255, 255], thresholds), true)
  assert.equal(detect(0, [255, 255, 255, 0], 0, [255, 255, 255, 255], thresholds), false)
  assert.equal(detect(255, [0, 20, 64, 255], 0, [255, 255, 255, 255], thresholds), false)
  assert.equal(detect(0, [20, 40, 60, 255], 0, [20, 40, 60, 255], thresholds), true)
  assert.equal(detect(0, [255, 255, 255, 255], 0, undefined, thresholds), true)
})
test('browser initialization runs the same classifier as the Node regression', async () => {
  const context = vm.createContext({})
  vm.runInContext(await readFile(new URL('../../../testing/verification-electron-display-tier-20261021/visual-omission.cjs', import.meta.url), 'utf8'), context)
  const detect = context.__sharpTransparentContentOmission
  for (const color of [[255, 255, 255, 255], [0, 20, 64, 255], [240, 240, 240, 255]])
    assert.equal(detect(0, color, 0, [255, 255, 255, 255], thresholds), detector.transparentContentOmission(0, color, 0, [255, 255, 255, 255], thresholds))
  const select = context.__sharpNextStressVisualCapture, captured = new Set(['stress-cycle-1-pan-32-out'])
  for (const phase of ['cycle-1-pan-32-out', 'cycle-2-pan-32-out', 'cycle-6-pan-0.25-return', 'settling'])
    assert.equal(select(phase, 6, captured), detector.nextStressVisualCapture(phase, 6, captured))
  const original = observedPolicy(), reference = context.__sharpReferenceExecutionPolicy(original, 1024)
  assert.equal(JSON.stringify(reference), JSON.stringify(detector.referenceExecutionPolicy(original, 1024)))
  assert.equal(Object.hasOwn(original, 'gpuWorkingBudgetMiB'), false)
})
