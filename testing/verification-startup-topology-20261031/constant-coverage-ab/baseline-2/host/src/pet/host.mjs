// The old sprite backend is removed. Do not instantiate a renderer, load an
// unverified replacement, or silently fall back while v2 verification is pending.
const modes = new Set(['off', 'quiet', 'active'])
const events = new Set(['edit', 'save', 'undo', 'export', 'error', 'navigation-start', 'navigation-end'])
export function createPetHost() {
  let editor = null, disposed = false, revision = 0
  const status = (requested = 'off') => ({ mode: 'off', phase: requested === 'off' ? 'off' : 'unavailable', revision: ++revision })
  return {
    configure(mode) {
      if (!modes.has(mode)) throw new TypeError('Invalid companion mode')
      const value = status(mode)
      if (!disposed && editor && !editor.isDestroyed()) editor.webContents.send('design-desktop:pet-status', value)
      return { ok: mode === 'off' && !disposed, ...value, backend: 'unavailable', reason: 'replacement-verification-pending' }
    },
    event(value) {
      if (!events.has(value)) throw new TypeError('Invalid companion event')
      return { ok: !disposed, accepted: false }
    },
    attachEditor(value) { if (!disposed) editor = value },
    dispose() { disposed = true; editor = null },
  }
}
