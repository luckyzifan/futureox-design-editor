import { captureViewportPreview, reusableViewportPreview, viewportPreviewKey,
  type ViewportPreviewIdentity } from './viewport-preview-cache'

export type NativeNavigationCapture = {
  readonly identity: ViewportPreviewIdentity
  /** A real, previously acknowledged presenter owner, never a predicted ID. */
  readonly device?: string
  state: 'running' | 'delivered' | 'failed'
}

/** One running navigation capture may finish across quiet/pointer release.
 * This holds metadata and one wake callback, never pixels or another queue.
 * Content/device invalidation remains the surface's existing scope boundary. */
export class NativeNavigationHandoff {
  private capture?: NativeNavigationCapture
  private waiting?: { capture: NativeNavigationCapture; wake: () => void }

  get current() { return this.capture }
  start(identity: ViewportPreviewIdentity, device: string | undefined) {
    const capture: NativeNavigationCapture = { identity: captureViewportPreview(identity).identity, device, state: 'running' }
    this.capture = capture
    this.waiting = undefined
    return capture
  }
  invalidate() { this.capture = undefined; this.waiting = undefined }
  stopWaiting() { this.waiting = undefined }
  waitingFor(capture: NativeNavigationCapture) { return this.capture === capture && this.waiting?.capture === capture }
  forIdentity(identity: ViewportPreviewIdentity) {
    const capture = this.capture, previous = capture?.identity
    return capture && capture.state !== 'failed' && previous && previous.client === identity.client &&
      previous.document === identity.document && previous.capability === identity.capability &&
      viewportPreviewKey(previous) === viewportPreviewKey(identity) ? capture : undefined
  }
  matching(identity: ViewportPreviewIdentity, device: string | undefined) {
    const capture = this.forIdentity(identity)
    // Unknown owners can finish into ordinary history, but cannot hold up or
    // certify the settled plan when their ownership was unknown at capture.
    return capture && !!device && capture.device === device ? capture : undefined
  }
  wait(capture: NativeNavigationCapture, wake: () => void) {
    if (this.capture !== capture || capture.state === 'failed') return false
    this.waiting = { capture, wake }
    return true
  }
  finish(capture: NativeNavigationCapture, delivered: boolean) {
    capture.state = delivered ? 'delivered' : 'failed'
    // A delivered bitmap still needs its actual import/presentation ACK. A
    // failure wakes the original plan immediately, without waiting for input.
    if (!delivered) this.wake(capture)
  }
  wake(capture: NativeNavigationCapture) {
    const waiting = this.waiting
    if (this.capture !== capture || waiting?.capture !== capture) return
    this.waiting = undefined
    waiting.wake()
  }
}

/** Native handoff additionally binds the owner known when work began. The
 * general viewport helper still proves exact camera/policy, live payload,
 * import readiness and an actual presentation ACK on that same device. */
export function reusableNativeNavigationPreview(tile: Parameters<typeof reusableViewportPreview>[0] & {
  nativeNavigationDevice?: string
}, identity: ViewportPreviewIdentity, ready: boolean, device: string | undefined) {
  return !!device && tile.nativeNavigationDevice === device &&
    reusableViewportPreview(tile, identity, ready, device)
}
