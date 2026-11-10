import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

export function editableOwnsKeyboard(target: EventTarget | null) {
  return !!(target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]')
}

/** Visible, enabled controls. Closed disclosure content and hidden inputs stay out of the cycle. */
export function modalTabStops(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex]')].filter(element => {
    if ('disabled' in element && (element as HTMLButtonElement).disabled) return false
    if (element.getAttribute('aria-hidden') === 'true' || element.closest('[hidden],[inert]')) return false
    if (element.tabIndex < 0) return false
    const details = element.closest('details')
    if (details && !details.open && element.tagName !== 'SUMMARY') return false
    return true
  })
}

function isolateModal(container: HTMLElement) {
  const saved: { element: Element; inert: string | null }[] = []
  let node: HTMLElement | null = container
  while (node?.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node) continue
      saved.push({ element: sibling, inert: sibling.getAttribute('inert') })
      sibling.setAttribute('inert', '')
    }
    if (node.parentElement === document.body) break
    node = node.parentElement
  }
  return saved
}

/** Move focus into a dialog, keep Tab inside it, and restore the opener on close.
 * Background siblings are inert so Esc and Tab are not delivered to the page chrome. */
export function useModalOwnership(container: RefObject<HTMLElement | null>, focus: RefObject<HTMLButtonElement | null>, returnFocus?: HTMLElement | null) {
  const restore = useRef<HTMLElement | null>(null)
  restore.current = returnFocus ?? null
  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const preferred = restore.current
    const opener = preferred?.isConnected ? preferred
      : document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const overflow = document.body.style.overflow
    const saved = isolateModal(root)
    document.body.style.overflow = 'hidden'
    const focusable = () => focus.current && !focus.current.disabled ? focus.current : root
    focusable().focus({ preventScroll: true })
    let retaining = false
    const retain = (event: FocusEvent) => {
      if (retaining || !(event.target instanceof Node) || root.contains(event.target)) return
      const next = focusable()
      retaining = true
      next.focus({ preventScroll: true })
      retaining = false
    }
    document.addEventListener('focusin', retain)
    return () => {
      document.removeEventListener('focusin', retain)
      for (const { element, inert } of saved) {
        if (inert === null) element.removeAttribute('inert')
        else element.setAttribute('inert', inert)
      }
      document.body.style.overflow = overflow
      if (opener?.isConnected && opener !== document.body && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [container, focus])
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
  const controls = modalTabStops(event.currentTarget)
  const first = controls[0], last = controls.at(-1)
  const active = document.activeElement
  if (!first) { event.preventDefault(); event.currentTarget.focus(); return }
  if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) { event.preventDefault(); first.focus() }
}
