// Isolated test-only native boundary. Never a successful kernel substitute.
// Explicit f03197e import-surface adaptation: all four exports share one counter.
export let kernelBoundsCalls = 0
function forbiddenApplicationKernelBoundary(): never {
  kernelBoundsCalls++
  throw new Error('ForbiddenApplicationKernelBoundary')
}
export function kernelBounds(..._args: unknown[]): never { return forbiddenApplicationKernelBoundary() }
export function kernelGeometryNetwork(..._args: unknown[]): never { return forbiddenApplicationKernelBoundary() }
export function kernelHit(..._args: unknown[]): never { return forbiddenApplicationKernelBoundary() }
export function kernelSvgPaths(..._args: unknown[]): never { return forbiddenApplicationKernelBoundary() }
