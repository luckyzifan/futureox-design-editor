// Shared pure checks for captured display samples and the browser-side audit.
// Passing sampled captures never proves every intermediate frame.
(function (scope) {
  const requiredVisualLabels = Object.freeze(['up-near-700', 'up-above-700', 'down-below-700', 'settled'])
  const validBudget = value => Number.isInteger(value) && value >= 256 && value <= 4096
  function referenceExecutionPolicy(observed, budget) {
    const keys = ['cpuOnly', 'hdrCompositing', 'imageMips', 'imageAtlas', 'desktopFullMath', 'desktopDisplay']
    if (!observed || typeof observed !== 'object' || keys.some(key => typeof observed[key] !== 'boolean'))
      throw Error('Reference requires the observed execution policy')
    if (observed.gpuWorkingBudgetMiB !== undefined && !validBudget(observed.gpuWorkingBudgetMiB))
      throw Error('Reference working budget is invalid')
    if (budget !== undefined && !validBudget(budget)) throw Error('Reference working budget is invalid')
    return budget === undefined ? { ...observed } : { ...observed, gpuWorkingBudgetMiB: budget }
  }
  function stressVisualCaptureLabels(cycles) {
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 6) return []
    return Array.from({ length: cycles }, (_, i) => [
      `stress-cycle-${i + 1}-pan-32-out`, `stress-cycle-${i + 1}-pan-0.25-return`,
    ]).flat()
  }
  function nextStressVisualCapture(phase, cycles, captured, pending = false) {
    if (pending || typeof phase !== 'string') return null
    const label = 'stress-' + phase
    return stressVisualCaptureLabels(cycles).includes(label) && !captured.has(label) ? label : null
  }
  function nativeWheelDeltaMatches(command, observed) {
    return Number.isFinite(command) && Number.isFinite(observed) && (command === observed || Math.fround(command) === observed)
  }
  function transparentContentOmission(alpha, reference, offset, background, thresholds) {
    if (alpha > thresholds.transparentMaxAlpha || reference[offset + 3] < thresholds.referenceOpaqueMinAlpha) return false
    const whitePage = background && background[3] >= thresholds.referenceOpaqueMinAlpha &&
      background.slice(0, 3).every(v => v >= thresholds.nearWhiteMin) &&
      reference.slice(offset, offset + 3).every(v => v >= thresholds.nearWhiteMin)
    return !whitePage
  }
  function assessSampledVisualOmission(samples, errors = []) {
    const counts = new Map()
    for (const row of samples) counts.set(row.label, (counts.get(row.label) || 0) + 1)
    const bound = row => typeof row.file === 'string' && row.file.length > 0 &&
      Number.isInteger(row.matchedAcknowledgement) && row.matchedAcknowledgement >= 0 && row.acknowledgement?.missingTextureCount === 0
    const reference = row => row.reference?.available === true && !row.reference.error
    const missingRequiredLabels = requiredVisualLabels.filter(label =>
      !samples.some(row => row.label === label && bound(row)))
    const available = samples.length > 0 && missingRequiredLabels.length === 0 && [...counts.values()].every(n => n === 1)
    return {
      available,
      passed: available && !errors.length && samples.every(row => !row.error && bound(row) && reference(row) &&
        row.reference.comparison?.sampledOmissionPassed === true && row.reference.comparison.suspiciousComponentCount === 0),
      capturedSamples: samples.length,
      availableReferenceSamples: samples.filter(reference).length,
      boundSamples: samples.filter(bound).length,
      missingRequiredLabels,
      allIntermediateFramesVerified: false,
    }
  }
  const api = { requiredVisualLabels, referenceExecutionPolicy, stressVisualCaptureLabels, nextStressVisualCapture,
    nativeWheelDeltaMatches, transparentContentOmission, assessSampledVisualOmission }
  if (typeof module !== 'undefined') module.exports = api
  scope.__sharpTransparentContentOmission = transparentContentOmission
  scope.__sharpNextStressVisualCapture = nextStressVisualCapture
  scope.__sharpReferenceExecutionPolicy = referenceExecutionPolicy
})(globalThis)
