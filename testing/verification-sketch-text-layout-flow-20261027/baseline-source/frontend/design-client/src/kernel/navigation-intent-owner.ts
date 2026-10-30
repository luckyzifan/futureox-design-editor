/** Isolated prototype: presentation ownership, never document revision ownership. */
export type NavigationScope = {
  livePreview?: boolean; renderIntent?: string; tileViewport?: unknown;
  interactionChannel?: unknown; retainInteractionGraph?: boolean; captureViewport?: unknown;
  exportFormat?: unknown; exportRegion?: unknown; pixelPreview?: boolean;
  png?: boolean; readback?: boolean;
}
export function optionalNavigation(scope: NavigationScope) {
  return scope.livePreview === true && scope.renderIntent === 'preview' &&
    !scope.tileViewport && !scope.interactionChannel && !scope.retainInteractionGraph &&
    !scope.captureViewport && !scope.exportFormat && !scope.exportRegion &&
    !scope.pixelPreview && !scope.png && !scope.readback
}
export class NavigationIntentOwner {
  private active?: { cancel: () => void }
  private session: object
  constructor(session: object = {}) { this.session = session }
  reset(session: object) { this.active?.cancel(); this.active = undefined; this.session = session }
  begin(session: object, intent: object, scope: NavigationScope, caller?: AbortSignal) {
    if (session !== this.session || !optionalNavigation(scope)) return undefined
    this.active?.cancel()
    const controller = new AbortController()
    const propagate = () => controller.abort(caller?.reason)
    const cleanup = () => caller?.removeEventListener('abort', propagate)
    const entry = { cancel: () => { cleanup(); controller.abort(); } }
    if (caller?.aborted) propagate()
    else caller?.addEventListener('abort', propagate, { once: true })
    this.active = entry
    return {
      intent, signal: controller.signal, cancel: entry.cancel,
      current: () => this.session === session && this.active === entry && !controller.signal.aborted,
      settle: () => { cleanup(); if (this.active === entry) this.active = undefined },
    }
  }
}
