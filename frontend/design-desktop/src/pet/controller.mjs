// Futureox-owned semantic adapter. No document payloads, upstream runtime, or GPU APIs.
export const PET_MODES = Object.freeze(['off', 'quiet', 'active'])
export const PET_EVENTS = Object.freeze(['edit', 'save', 'undo', 'export', 'error', 'navigation-start', 'navigation-end'])
const actions = Object.freeze({ edit: 'work', save: 'nod', undo: 'puzzled', export: 'celebrate', error: 'puzzled' })
const priority = { edit: 0, undo: 1, save: 2, export: 3, error: 4 }
export function createPetController({ publish, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let mode = 'off', action = 'idle', sequence = 0, navigation = false, suspended = false, disposed = false
  let lastAction = -Infinity, pending = null, cooldownTimer = null, idleTimer = null
  const paused = () => navigation || suspended
  const state = () => ({ mode, action, sequence, paused: paused() })
  const emit = () => { if (!disposed) { sequence++; publish(state()) } }
  function cancel() {
    if (cooldownTimer !== null) clearTimer(cooldownTimer)
    if (idleTimer !== null) clearTimer(idleTimer)
    cooldownTimer = idleTimer = null; pending = null; action = 'idle'
  }
  function play(event) {
    action = actions[event]; lastAction = now(); emit()
    if (idleTimer !== null) clearTimer(idleTimer)
    idleTimer = setTimer(() => { idleTimer = null; action = 'idle'; emit() }, 1600)
  }
  return {
    state,
    configure(value) {
      if (!PET_MODES.includes(value)) throw new TypeError('Invalid pet mode')
      if (disposed) return state()
      if (mode !== value) { cancel(); mode = value; lastAction = -Infinity; emit() }
      return state()
    },
    event(value) {
      if (!PET_EVENTS.includes(value)) throw new TypeError('Invalid pet event')
      if (disposed) return false
      if (value.startsWith('navigation-')) {
        const active = value === 'navigation-start'
        if (navigation !== active) { navigation = active; cancel(); if (mode !== 'off') emit() }
        return true
      }
      if (mode !== 'active' || paused()) return false
      const delay = 900 - (now() - lastAction)
      if (delay <= 0) { play(value); return true }
      if (pending === null || priority[value] >= priority[pending]) pending = value
      if (cooldownTimer === null) cooldownTimer = setTimer(() => {
        cooldownTimer = null; const event = pending; pending = null
        if (event && mode === 'active' && !paused()) play(event)
      }, delay)
      return true
    },
    suspend(value) {
      if (disposed || suspended === !!value) return
      suspended = !!value; cancel(); if (mode !== 'off') emit()
    },
    dispose() { cancel(); disposed = true },
  }
}
