/** Test-only screen classifier. Transparent pixels over an opaque white page
 * have the same visible color as the reference's white background. They are
 * not evidence of missing authored content. Colored reference content and
 * unsupported/nonwhite background cases remain conservatively reportable. */
function transparentContentOmission(actualAlpha, expected, offset, background, thresholds) {
  if (actualAlpha > thresholds.transparentMaxAlpha || expected[offset + 3] < thresholds.referenceOpaqueMinAlpha) return false
  const whitePage = background && background[3] >= thresholds.referenceOpaqueMinAlpha &&
    background.slice(0, 3).every(value => value >= thresholds.nearWhiteMin)
  const sameWhiteBackground = whitePage && [0, 1, 2].every(channel =>
    Math.abs(expected[offset + channel] - background[channel]) < thresholds.referenceContentContrast)
  return !sameWhiteBackground
}

function nativeWheelDeltaMatches(command, observed) {
  return Number.isFinite(command) && Number.isFinite(observed) &&
    (Math.abs(command - observed) <= 1e-7 || Math.abs(Math.fround(command) - observed) <= 1e-7)
}

const requiredVisualLabels = Object.freeze(['up-near-700', 'up-near-3200', 'down-below-700', 'settled-return-100'])

function stressVisualCaptureLabels(cycles) {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 6) return []
  return Array.from({ length: cycles }, (_, index) => [
    `stress-cycle-${index + 1}-pan-32-out`, `stress-cycle-${index + 1}-pan-0.25-return`,
  ]).flat()
}

function nextStressVisualCapture(phase, cycles, captured, pending = false) {
  if (pending) return null
  const label = 'stress-' + phase
  return stressVisualCaptureLabels(cycles).includes(label) && !captured.has(label) ? label : null
}

function validateReferenceBudgetMiB(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 256 || value > 4096))
    throw Error('Reference working budget must be an integer from 256 to 4096 MiB')
  return value
}

function referenceExecutionPolicy(observed, requestedOverride) {
  const budget = validateReferenceBudgetMiB(requestedOverride)
  const keys = ['cpuOnly', 'hdrCompositing', 'imageMips', 'imageAtlas', 'desktopFullMath', 'desktopDisplay']
  if (!observed || !keys.every(key => typeof observed[key] === 'boolean'))
    throw Error('Reference requires the actual observed host execution policy')
  validateReferenceBudgetMiB(observed.gpuWorkingBudgetMiB)
  return { ...observed, ...(budget === undefined ? {} : { gpuWorkingBudgetMiB: budget }) }
}

// A stress run adds samples to the same four required milestones. Every added
// sample remains part of the gate; neither its count nor a duplicate milestone
// may substitute for a missing, owner-bound required capture.
function assessSampledVisualOmission(samples, errors = []) {
  const bound = sample => typeof sample?.file === 'string' && sample.file.length > 0 &&
    Number.isSafeInteger(sample.matchedAcknowledgement) && sample.matchedAcknowledgement >= 0 && !sample.error
  const missingRequiredLabels = requiredVisualLabels.filter(label => !samples.some(sample => sample.label === label && bound(sample)))
  const availableReferenceSamples = samples.filter(sample => sample.reference?.available === true && !sample.reference.error).length
  const boundSamples = samples.filter(bound).length
  const suspiciousComponentCount = samples.reduce((sum, sample) => {
    const count = sample.reference?.comparison?.suspiciousComponentCount
    return sum + (Number.isSafeInteger(count) && count >= 0 ? count : 0)
  }, 0)
  const missingTextureSamples = samples.filter(sample => sample.acknowledgement?.missingTextureCount !== 0).length
  const available = missingRequiredLabels.length === 0 && boundSamples === samples.length &&
    availableReferenceSamples === samples.length
  return { capturedSamples: samples.length, availableReferenceSamples, boundSamples, missingRequiredLabels,
    suspiciousComponentCount, missingTextureSamples, errorCount: errors.length, available,
    passed: available && errors.length === 0 && missingTextureSamples === 0 && suspiciousComponentCount === 0 &&
      samples.every(sample => sample.reference.comparison?.sampledOmissionPassed === true &&
        sample.reference.comparison.suspiciousComponentCount === 0),
    allIntermediateFramesVerified: false }
}

if (typeof module === 'object' && module.exports) module.exports = {
  transparentContentOmission, nativeWheelDeltaMatches, requiredVisualLabels, assessSampledVisualOmission,
  stressVisualCaptureLabels, nextStressVisualCapture, validateReferenceBudgetMiB, referenceExecutionPolicy }
else {
  globalThis.__sharpTransparentContentOmission = transparentContentOmission
  globalThis.__sharpNextStressVisualCapture = nextStressVisualCapture
  globalThis.__sharpReferenceExecutionPolicy = referenceExecutionPolicy
}
