import type { ShortcutBinding } from './shortcut-profiles'

let opener: HTMLElement | null = null
let open = false
const listeners = new Set<() => void>()
let used: ReadonlySet<string> = new Set()
const usedListeners = new Set<() => void>()

export function requestShortcutReference(target: EventTarget | null) {
  if (open) return
  opener = typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target : null
  open = true
  listeners.forEach(listener => listener())
}

export function closeShortcutReference(restore = true) {
  if (!open) return
  const target = opener
  open = false
  opener = null
  listeners.forEach(listener => listener())
  if (restore) queueMicrotask(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')
    const fallback = target?.isConnected && !target.closest('[hidden]') && target.getClientRects().length ? target : canvas
    fallback?.focus({ preventScroll: true })
  })
}

export function shortcutReferenceOpen() { return open }
export function subscribeShortcutReference(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function shortcutUseKey(binding: ShortcutBinding) { return `${binding.command}:${binding.combo}` }
export function recordShortcutUse(binding: ShortcutBinding) {
  const key = shortcutUseKey(binding)
  if (used.has(key)) return
  used = new Set([...used, key])
  usedListeners.forEach(listener => listener())
}
export function usedShortcutSnapshot() { return used }
export function subscribeUsedShortcuts(listener: () => void) {
  usedListeners.add(listener)
  return () => { usedListeners.delete(listener) }
}
