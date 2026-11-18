import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clampContextMenu } from './canvas-menu-model'

export function ActionContextMenu({ point, label, className, returnFocus, onClose, children }: {
  point: { x: number; y: number }
  label: string
  className?: string
  returnFocus?: HTMLElement | null
  onClose: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const restore = useRef(false)
  const [position, setPosition] = useState(point)
  close.current = onClose

  useLayoutEffect(() => {
    const menu = root.current
    if (!menu) return
    setPosition(clampContextMenu(point, menu.getBoundingClientRect(), {
      width: window.innerWidth, height: window.innerHeight,
    }))
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? menu
    first.focus({ preventScroll: true })
  }, [point.x, point.y])

  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close.current()
    }
    const dismiss = () => close.current()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      if (restore.current && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [returnFocus])

  return createPortal(<div ref={root} role="menu" tabIndex={-1} aria-label={label}
    className={['canvas-context-menu', className].filter(Boolean).join(' ')}
    style={{ left: position.x, top: position.y }}
    onPointerDown={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        restore.current = true
        close.current()
        return
      }
      if (event.key === 'Tab') { close.current(); return }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
      if (!items.length) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length
      items[next].focus({ preventScroll: true })
    }}>
    {children}
  </div>, document.body)
}
