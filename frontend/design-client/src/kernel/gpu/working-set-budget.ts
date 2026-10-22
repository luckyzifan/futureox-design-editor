import { validGpuWorkingBudgetMiB } from '../render-policy'

const MiB = 1024 * 1024
/** Default working-resource admission, not a total VRAM limit or allocation. */
export const DEFAULT_GPU_WORKING_BUDGET_BYTES = 1024 * MiB
/** The launch flag and actual render-call output are trusted host inputs.
 * Scene display hints and captureDisplay do not grant this new admission.
 * Bitmap assembly is also a real SDR presentation, so it keeps the same
 * working policy as the resident four-phase producer. Sampling is unchanged. */
export function usesNativeNavigationWorkingBudget(flag: unknown, boundary: {
  driverName?: unknown; managed?: unknown; hdr?: unknown;
  readback?: unknown; present?: unknown; softwareRaster?: unknown
}) {
  return flag === '1' && boundary.driverName === 'webgpu' && boundary.managed === true && boundary.hdr === false &&
    boundary.readback === false && boundary.present === true &&
    (boundary.softwareRaster === undefined || boundary.softwareRaster === false)
}
/** Working-resource policy, not a claim about free VRAM. No scene or output
 * mode silently lowers the default. Explicit host limits remain authoritative;
 * per-resource device limits and all allocation/fence checks still apply. */
export function workingSetBudget(_width: number, _height: number, _nativeDisplay: boolean, _effectPixels=0,
  configuredMiB?: number) {
  if (configuredMiB !== undefined) {
    if (!validGpuWorkingBudgetMiB(configuredMiB)) throw Error('Invalid GPU working budget')
    // Keep Number arithmetic: 4096 MiB is 2^32 bytes and must not wrap to zero.
    return configuredMiB * MiB
  }
  return DEFAULT_GPU_WORKING_BUDGET_BYTES
}
