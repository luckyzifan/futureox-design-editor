// Runtime branch facts only. Never accept environment strings, resource names,
// document payloads, getters or prototype properties.
export const RUNTIME_CONFIGURATION_LIMITS = Object.freeze({
  runtimeConfigVersion: 1, runtimeDriverCode: 2,
  runtimeImageAtlas: 1, runtimeImageMips: 1, runtimeDriverManaged: 1,
  runtimeLinearLight: 1, runtimeHdr: 1, runtimeDisplayMath: 1,
  runtimeCaptureDisplay: 1, runtimeFloatUpload: 1, runtimeFloatAtlasUpload: 1,
  runtimeFloatCompositing: 1, runtimeColorManaged: 1, runtimeCoherentSamples: 1,
  runtimeReadback: 1, runtimePresent: 1, runtimeSoftwareRaster: 1,
  runtimeCompactImageFields: 1, runtimeImageAxesEnabled: 1, runtimeImageAxesEligible: 1, runtimeStreamImageFields: 1,
  runtimeWorkingBudgetBytes: 4294967296, runtimeBudgetSource: 2,
  runtimeConfiguredBudgetMiB: 4096,
})
const limits = Object.entries(RUNTIME_CONFIGURATION_LIMITS)
export function sanitizeRuntimeConfiguration(value) {
  const out = {}
  try {
    if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, 'runtimeConfigVersion')?.value !== 1) return out
    for (const [key, maximum] of limits) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value
      if (!Number.isSafeInteger(item) || item < 0 || item > maximum) continue
      if (key === 'runtimeConfigVersion' && item !== 1) continue
      if (key === 'runtimeBudgetSource' && item !== 1 && item !== 2) continue
      if (key === 'runtimeWorkingBudgetBytes' && item < 268435456) continue
      if (key === 'runtimeConfiguredBudgetMiB' && item !== 0 && item < 256) continue
      out[key] = item
    }
  } catch { return {} }
  return out
}
const errors = new WeakMap()
const object = value => (typeof value === 'object' && value !== null) || typeof value === 'function'
export function markRuntimeConfiguration(error, snapshot) {
  const fields = sanitizeRuntimeConfiguration(snapshot)
  if (object(error) && fields.runtimeConfigVersion === 1)
    errors.set(error, Object.freeze(fields))
  return error
}
export function runtimeConfigurationFields(error) {
  return object(error) ? { ...errors.get(error) } : {}
}
export function inheritRuntimeConfiguration(source, target) {
  if (object(source) && object(target) && errors.has(source)) errors.set(target, errors.get(source))
  return target
}
