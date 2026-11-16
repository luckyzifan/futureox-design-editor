/** Left-rail Find. Shell state only: it never enters the document or its history. */
type Listener = () => void
const listeners = new Set<Listener>()
let generation = 0
let refocus = 0
let returnFocus: HTMLElement | null = null

function emit() {
  for (const listener of [...listeners]) listener()
}

export function subscribeLayerFind(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Zero while closed. A new positive generation starts a fresh query. */
export function layerFindSnapshot() {
  return generation
}

/** Increments when Find is already open and the shortcut asks for the field again. */
export function layerFindRefocus() {
  return refocus
}

export function layerFindReturnTarget() {
  return returnFocus
}

function htmlElement(value: EventTarget | null | undefined): HTMLElement | null {
  if (typeof HTMLElement === 'undefined' || !(value instanceof HTMLElement) || value === document.body) return null
  return value
}

export function requestLayerFind(focus?: EventTarget | null) {
  const element = htmlElement(focus) ?? (typeof document === 'undefined' ? null : htmlElement(document.activeElement))
  if (generation === 0) {
    returnFocus = element
    generation += 1
  } else {
    refocus += 1
  }
  emit()
}

export function closeLayerFind() {
  if (!generation) return
  generation = 0
  emit()
}
