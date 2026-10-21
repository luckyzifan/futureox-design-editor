import { validGpuWorkingBudgetMiB } from '../render-policy'

const MiB = 1024 * 1024
/** Admission policy, not a claim about free VRAM. WebGPU exposes per-resource
 * limits but no reliable remaining-memory query. Grow for the actual physical
 * render target; never lower sampling density to meet this policy. */
export function workingSetBudget(width: number, height: number, nativeDisplay: boolean, effectPixels=0,
  configuredMiB?: number) {
  if (configuredMiB !== undefined) {
    if (!validGpuWorkingBudgetMiB(configuredMiB)) throw Error('Invalid GPU working budget')
    // Keep Number arithmetic: 4096 MiB is 2^32 bytes and must not wrap to zero.
    return configuredMiB * MiB
  }
  const minimum = (nativeDisplay ? 512 : 256) * MiB
  if (!nativeDisplay || !Number.isFinite(width * height) || width <= 0 || height <= 0) return minimum
  // Four RGBA32F-sized working planes cover destination/source + a separable
  // filter pair. Real effects may require more; normal allocation/fallback
  // handling still applies. 1 GiB is a policy ceiling, never adapter free VRAM.
  const demand = Math.ceil(width * height * 16 * 4 / (64 * MiB)) * 64 * MiB
  // Live backdrop effects overlap destination, sampled backdrop and filtered
  // output. Account for those three exact-density planes separately from the
  // ordinary target allowance; this is bounded admission, not free VRAM.
  const optical=Number.isFinite(effectPixels)&&effectPixels>0
    ?Math.min(256*MiB,Math.ceil(effectPixels*16*3/(64*MiB))*64*MiB):0
  return Math.min(1024*MiB,Math.max(minimum,demand)+optical)
}
