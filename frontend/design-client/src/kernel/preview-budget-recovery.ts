type PreviewRenderer = {
  driver: { lost?: boolean; abortFrameAndReleaseFilterScratch?(): Promise<void> }
  abortFrameAndReleaseFilterScratch(): Promise<void>
  dispose(): void
}

export function isRecoverablePreviewBudget(error: unknown, rendererLost = false) {
  const message = String(error)
  return !rendererLost && !/device lost|GPU device|has been lost|设备已丢失/i.test(message) &&
    /^(?:Error: )?(?:GPU (?:表面内存预算超限|surface budget exceeded|analytic interval program budget exceeded)|Invalid GPU (?:tile )?viewport|Scene path budget exceeded)(?:$|[\s(:;])/.test(message)
}

/** A failed optional preview does not own the last displayed frame. Retire its
 * encoder and temporary scratch before another request borrows this renderer;
 * keep the device, resident pictures, and exact CPU certificates intact. */
export async function recoverPreviewBudget(
  error: unknown, renderer: PreviewRenderer | undefined, invalidate: () => void,
): Promise<boolean> {
  if (!isRecoverablePreviewBudget(error, renderer?.driver.lost) || !renderer?.driver.abortFrameAndReleaseFilterScratch) return false
  try {
    // The renderer wrapper reconciles its scratch-byte ledger as well as the
    // driver's asynchronous command/resource ownership.
    await renderer.abortFrameAndReleaseFilterScratch()
    if (renderer.driver.lost) throw Error('GPU device lost during preview recovery')
    return true
  } catch (cause) {
    invalidate()
    renderer.dispose()
    // Existing surface recovery recognizes a GPU-device failure and retries
    // the unchanged request rather than leaving its old residents stranded.
    throw new Error('GPU device preview recovery failed', { cause })
  }
}
