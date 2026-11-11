/** UI session for the command search. It is not document state and never enters history. */
type Listener = () => void
const listeners = new Set<Listener>()
let generation = 0
let returnFocus: HTMLElement | null = null

function emit() {
  for (const listener of [...listeners]) listener()
}

export function subscribeCommandSearch(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Zero while closed. A new positive generation starts a fresh query. */
export function commandSearchSnapshot() {
  return generation
}

export function commandSearchReturnTarget() {
  return returnFocus
}

function htmlElement(value: EventTarget | null | undefined): HTMLElement | null {
  if (typeof HTMLElement === 'undefined' || !(value instanceof HTMLElement) || value === document.body) return null
  return value
}
export function requestCommandSearch(focus?: EventTarget | null) {
  const element = htmlElement(focus) ?? (typeof document === 'undefined' ? null : htmlElement(document.activeElement))
  returnFocus = element
  generation += 1
  emit()
}

export function closeCommandSearch() {
  if (!generation) return
  generation = 0
  emit()
}
