import { useSyncExternalStore } from 'react'

/** Figma Dev Mode is a view of the current file, not a document property.
 * It is session-local so a saved preference cannot turn spacing on for every file. */
let enabled = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function figmaDevMode() {
  return enabled
}

export function setFigmaDevMode(next: boolean) {
  if (enabled === next) return
  enabled = next
  emit()
}

export function resetFigmaDevMode() {
  setFigmaDevMode(false)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFigmaDevMode() {
  return useSyncExternalStore(subscribe, figmaDevMode, () => false)
}
