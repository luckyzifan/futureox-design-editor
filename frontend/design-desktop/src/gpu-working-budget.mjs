// Launch-only admission ceiling. This does not allocate GPU memory, change
// device limits, or cap the whole application's memory and persistent caches.
export const MIN_GPU_WORKING_BUDGET_MIB = 256
export const MAX_GPU_WORKING_BUDGET_MIB = 4096
const GiB = 1024 ** 3

export function parseGpuWorkingBudgetMiB(value) {
  if (value === undefined || value === 'auto') return undefined
  const invalid = () => new TypeError('CORE_GPU_WORKING_BUDGET_MIB must be auto or a decimal integer from 256 to 4096 MiB')
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw invalid()
  const budget = Number(value)
  if (!Number.isSafeInteger(budget) || String(budget) !== value || budget < MIN_GPU_WORKING_BUDGET_MIB || budget > MAX_GPU_WORKING_BUDGET_MIB) throw invalid()
  return budget
}

export function selectGpuWorkingBudgetMiB(value, { platform, arch, total, available, constrained } = {}) {
  const configured = parseGpuWorkingBudgetMiB(value)
  if (configured !== undefined) return configured
  if (platform !== 'darwin' || arch !== 'arm64') return undefined
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(available)) return undefined
  const usable = constrained > 0 ? Math.min(available, constrained) : available
  // macOS reports unified memory. Allow a larger working set only when
  // startup has enough reclaimable memory for both the renderer and the OS.
  return total >= 16 * GiB && usable >= 4 * GiB ? 2048 : undefined
}
