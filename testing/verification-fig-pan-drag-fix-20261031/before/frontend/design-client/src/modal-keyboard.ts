import type { KeyboardEvent as ReactKeyboardEvent } from 'react'


export function editableOwnsKeyboard(target: EventTarget | null) {
  return !!(target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]')
}

export function modalOwnsKeyboard(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return !!element?.closest?.('[role="dialog"],[role="alertdialog"],[role="menu"]') ||
    (typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]'))
}

/** Preserve native button activation; only Escape and focus wrapping are intercepted. */
export function modalKeyDown(event: ReactKeyboardEvent<HTMLElement>, close: () => void) {
  event.stopPropagation()
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!event.repeat) close()
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
  )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
  const first = controls[0], last = controls.at(-1)
  if (!first) { event.preventDefault(); event.currentTarget.focus(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
