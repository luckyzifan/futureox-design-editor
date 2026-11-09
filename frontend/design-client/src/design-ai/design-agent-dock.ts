import type { AgentTargetDetail } from './target-event'

export type AgentDockState = {
  open: boolean
  initial: AgentTargetDetail | null
}

let state: AgentDockState = { open: false, initial: null }
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeAgentDock(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getAgentDock(): AgentDockState {
  return state
}

export function setAgentDockOpen(open: boolean) {
  if (state.open === open) return
  state = { ...state, open }
  emit()
}

/** Open the docked chat. A detail replaces the pending page target; omitting
 * it keeps the conversation already on screen. */
export function openAgentDock(detail?: AgentTargetDetail) {
  const initial = detail ?? state.initial
  if (state.open && initial === state.initial) return
  state = { open: true, initial }
  emit()
}

export function resetAgentDockForTests() {
  state = { open: false, initial: null }
  emit()
}
