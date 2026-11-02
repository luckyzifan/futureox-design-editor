import { useSyncExternalStore } from 'react'

export type PropertiesTab = 'design' | 'prototype'

let tab: PropertiesTab = 'design'
const listeners = new Set<() => void>()

export function getPrototypeTab(): PropertiesTab {
  return tab
}

export function setPrototypeTab(next: PropertiesTab) {
  if (next !== 'design' && next !== 'prototype') return
  if (next === tab) return
  tab = next
  listeners.forEach(listener => listener())
}

/** Figma Mac Shift+E outside vector edit toggles Design and Prototype. */
export function togglePrototypeTab() {
  setPrototypeTab(tab === 'prototype' ? 'design' : 'prototype')
}

export function subscribePrototypeTab(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePrototypeTab() {
  return useSyncExternalStore(subscribePrototypeTab, getPrototypeTab, getPrototypeTab)
}
