import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Same clamp as the tool popover: flip above/below the trigger, then stay inside the viewport. */
export function clampAnchoredMenu(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  options?: { prefer?: 'above' | 'below'; margin?: number; viewport?: { width: number; height: number } },
): { left: number; top: number } {
  const margin = options?.margin ?? 8
  const prefer = options?.prefer ?? 'above'
  const viewW = options?.viewport?.width ?? window.innerWidth
  const viewH = options?.viewport?.height ?? window.innerHeight
  const left = Math.max(margin, Math.min(anchor.left, viewW - size.width - margin))
  const above = anchor.top - size.height - margin
  const below = anchor.bottom + margin
  const preferred = prefer === 'below'
    ? (below + size.height <= viewH - margin ? below : above)
    : (above >= margin ? above : below)
  const top = Math.max(margin, Math.min(preferred, viewH - size.height - margin))
  return { left, top }
}

export function AnchoredMenu({
  anchor, className, prefer = 'below', children, role, label,
}: {
  anchor: HTMLElement | null
  className?: string
  prefer?: 'above' | 'below'
  children: ReactNode
  role?: string
  label?: string
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor?.getBoundingClientRect()
      const size = menu.current?.getBoundingClientRect()
      if (!box || !size || size.width === 0) return
      const next = clampAnchoredMenu(box, size, { prefer })
      setPosition(old => old?.left === next.left && old?.top === next.top ? old : next)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, prefer, children])
  const box = anchor?.getBoundingClientRect()
  const left = position?.left ?? box?.left ?? 8
  const top = position?.top ?? (box ? box.bottom + 8 : 48)
  return <div ref={menu} className={className} role={role} aria-label={label}
    style={{ position: 'fixed', zIndex: 80, left, top, visibility: position || box ? 'visible' : 'hidden' }}>{children}</div>
}
