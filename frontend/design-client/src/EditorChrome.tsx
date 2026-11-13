import { useInterfacePreferences } from './interface-preference'
import { canvasText } from './canvas-interface-messages'
import { figmaStatusClearance } from './figma-toolbar-layout'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, FolderOpen, Layers, Shapes, SlidersHorizontal, Variable } from 'lucide-react'
import { clampAnchoredMenu } from './anchored-menu'

/** Canvas and toolbelt form a two-region F6 cycle. Text fields, open menus,
 * modal dialogs and active gestures retain ownership of their own input. */
export function DesignToolbar({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const { locale } = useInterfacePreferences(), text = canvasText[locale]
  const host = useRef<HTMLDivElement>(null), tooltip = useRef<HTMLDivElement>(null), blocked = useRef(disabled)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), candidate = useRef<HTMLButtonElement | null>(null)
  const id = useId(), [hint, setHint] = useState<{ button: HTMLButtonElement; text: string } | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  blocked.current = disabled
  const hide = () => { clearTimeout(timer.current); candidate.current = null; setHint(null) }
  useLayoutEffect(() => {
    const toolbar = host.current, canvas = toolbar?.closest('.canvas-workspace')
    if (!toolbar || !canvas) return
    const shell = toolbar.closest<HTMLElement>('.editor-shell')
    const place = () => {
      // This `left` value is the visual center and only matches a bottom toolbar
      // shifted with translateX(-50%). Sketch keeps its own row under the
      // document action bar; writing that center inline slides the row sideways
      // until the action bar covers the buttons.
      if (shell && shell.getAttribute('data-ui-mode') === 'sketch') {
        toolbar.style.removeProperty('left')
        shell.style.removeProperty('--floating-toolbar-status-clearance')
        return
      }
      const box = canvas.getBoundingClientRect(), half = toolbar.getBoundingClientRect().width / 2
      toolbar.style.left = `${Math.max(half + 8, Math.min(window.innerWidth / 2 - box.left, box.width - half - 8))}px`
      if (shell?.getAttribute('data-ui-mode') === 'figma') {
        const bottom = Number.parseFloat(getComputedStyle(toolbar).bottom)
        const clearance = figmaStatusClearance(bottom, toolbar.getBoundingClientRect().height)
        if (clearance > 0) shell.style.setProperty('--floating-toolbar-status-clearance', `${clearance}px`)
        else shell.style.removeProperty('--floating-toolbar-status-clearance')
      }
    }
    const observer = new ResizeObserver(place)
    observer.observe(toolbar); observer.observe(canvas); window.addEventListener('resize', place)
    const mode = shell && typeof MutationObserver === 'function' ? new MutationObserver(place) : undefined
    if (shell) mode?.observe(shell, { attributes: true, attributeFilter: ['data-ui-mode'] })
    place()
    return () => { observer.disconnect(); mode?.disconnect(); window.removeEventListener('resize', place) }
  }, [])
  const buttons = () => [...(host.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
    .filter(button => !button.closest('.figma-view-tools'))
  const show = (button: HTMLButtonElement, immediate: boolean) => {
    if (!host.current?.contains(button) || !button.dataset.tooltip || button.getAttribute('aria-expanded') === 'true') return
    if (candidate.current === button && !immediate) return
    clearTimeout(timer.current); candidate.current = button
    const present = () => { if (button.isConnected && candidate.current === button) setHint({ button, text: button.dataset.tooltip! }) }
    if (immediate) present(); else { setHint(null); timer.current = setTimeout(present, 450) }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.repeat || event.keyCode === 229 || event.isComposing || event.altKey || event.metaKey || event.ctrlKey || blocked.current) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input,textarea,select,[contenteditable],[role="textbox"]') ||
          document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"]')) return
      event.preventDefault(); event.stopPropagation(); hide()
      if (host.current?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      else {
        const enabled = buttons()
        ;(enabled.find(button => button.getAttribute('aria-pressed') === 'true') || enabled[0])?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', keydown, true)
    const dismiss = () => hide()
    window.addEventListener('blur', dismiss)
    return () => { clearTimeout(timer.current); window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', dismiss) }
  }, [])
  useLayoutEffect(() => {
    if (!hint) return
    const button = hint.button
    const described = new Set((button.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)); described.add(id)
    button.setAttribute('aria-describedby', [...described].join(' '))
    const place = () => {
      if (!tooltip.current || !button.isConnected) return
      const anchor = button.getBoundingClientRect(), box = tooltip.current.getBoundingClientRect()
      const left = Math.max(8, Math.min(anchor.left + (anchor.width - box.width) / 2, window.innerWidth - box.width - 8))
      const top = Math.max(8, Math.min(anchor.top - box.height - 8 >= 8 ? anchor.top - box.height - 8 : anchor.bottom + 8, window.innerHeight - box.height - 8))
      setPosition(old => old.left === left && old.top === top ? old : { left, top })
    }
    place(); window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      const remaining = (button.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id)
      if (remaining.length) button.setAttribute('aria-describedby', remaining.join(' ')); else button.removeAttribute('aria-describedby')
    }
  }, [hint, id])
  useLayoutEffect(() => {
    if (hint?.button.isConnected && hint.button.dataset.tooltip && hint.text !== hint.button.dataset.tooltip)
      setHint({ button: hint.button, text: hint.button.dataset.tooltip })
  }, [locale, hint])
  return <div ref={host} className="toolbar floating-toolbar" role="toolbar" aria-label={text.designTools}
    onPointerOver={event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-tooltip]')
      if (button) show(button, false)
    }}
    onPointerOut={event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-tooltip]')
      if (button && event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
      if (button === document.activeElement && button?.matches(':focus-visible')) return
      hide()
    }}
    onPointerDownCapture={hide}
    onFocusCapture={event => {
      const button = event.target
      if (button instanceof HTMLButtonElement && button.matches('button[data-tooltip]:focus-visible')) show(button, true)
    }}
    onBlurCapture={hide}
    onKeyDown={event => {
      event.stopPropagation()
      if ((event.target as Element | null)?.closest?.('.figma-view-tools')) {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (hint) hide(); else document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
        }
        return
      }
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.repeat && ['Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); return }
      const enabled = buttons()
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const at = enabled.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
          (Math.max(at, 0) + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
        enabled[next]?.focus({ preventScroll: true })
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); hide(); (document.activeElement as HTMLButtonElement)?.click?.()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (hint) hide(); else document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      } else if (['ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(event.key)) event.preventDefault()
    }}>
    {children}
    {hint && createPortal(<div ref={tooltip} id={id} role="tooltip" className="toolbar-tooltip" style={position}>{hint.text}</div>, document.body)}
  </div>
}

export type WorkspaceSection = 'layers' | 'assets'
export function WorkspaceRail({ section, onSection, onFiles, onTools, onVariables, toolsOpen }: {
  section: WorkspaceSection
  onSection: (section: WorkspaceSection) => void
  /** Omitted when this control would repeat the header library entry. */
  onFiles?: () => void
  onTools: () => void
  onVariables: () => void
  toolsOpen: boolean
}) {
  const { locale } = useInterfacePreferences(), text = canvasText[locale]
  return <nav className="workspace-rail" aria-label={text.workspaceNavigation}>
    {onFiles && <>
      <button type="button" onClick={onFiles} title={text.localDesignFiles}><FolderOpen size={19} aria-hidden="true" /><span>{text.files}</span></button>
      <div className="workspace-rail-divider" role="separator" />
    </>}
    <button type="button" title={text.pagesAndLayers} aria-pressed={section === 'layers'} onClick={() => onSection('layers')}><Layers size={19} aria-hidden="true" /><span>{text.layers}</span></button>
    <button type="button" title={text.componentsAndAssets} aria-pressed={section === 'assets'} onClick={() => onSection('assets')}><Shapes size={19} aria-hidden="true" /><span>{text.assets}</span></button>
    <button type="button" title={text.designTools} aria-pressed={toolsOpen} onClick={onTools}><SlidersHorizontal size={19} aria-hidden="true" /><span>{text.tools}</span></button>
    <button type="button" title={text.localDesignVariables} onClick={onVariables}><Variable size={19} aria-hidden="true" /><span>{text.variables}</span></button>
  </nav>
}

/** First paint uses the trigger box so the menu is not parked at 0,0 while it measures.
 * useLayoutEffect then clamps to the real menu size before the browser paints. */
function menuStyle(position: { left: number; top: number } | null, host: HTMLElement | null): { left: number; top: number; visibility: 'visible' | 'hidden' } {
  if (position) return { ...position, visibility: 'visible' }
  const anchor = host?.getBoundingClientRect()
  if (!anchor || typeof window === 'undefined') return { left: 0, top: 0, visibility: 'hidden' }
  const width = 238, height = 280, margin = 8
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
  const above = anchor.top - height - margin
  const top = Math.max(margin, Math.min(above >= margin ? above : anchor.bottom + margin, window.innerHeight - 48))
  return { left, top, visibility: 'visible' }
}

/** A menu owns keyboard input while open. Portaling avoids the canvas clip;
 * only Escape/Tab restore the trigger, so outside inputs retain normal focus. */
export function ToolPopover({ label, children, open, onOpenChange, icon, primary }: {
  label: string
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  icon: ReactNode
  primary?: { label: string; title?: string; active: boolean; onClick: () => void }
}) {
  const host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const id = useId(), change = useRef(onOpenChange), firstFocus = useRef<'first' | 'last'>('first')
  const focusPending = useRef(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  change.current = onOpenChange
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)') || [])]
  const dismiss = (restore = false) => {
    change.current(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    focusPending.current = true
    const place = () => {
      if (!host.current || !menu.current) return
      const anchor = host.current.getBoundingClientRect(), bounds = menu.current.getBoundingClientRect()
      const next = clampAnchoredMenu(anchor, bounds)
      setPosition(old => old?.left === next.left && old.top === next.top ? old : next)
    }
    place()
    const observer = new ResizeObserver(place)
    if (host.current) observer.observe(host.current)
    if (menu.current) observer.observe(menu.current)
    const workspace = host.current?.closest('.canvas-workspace')
    if (workspace) observer.observe(workspace)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !position || !focusPending.current) return
    focusPending.current = false
    const enabled = items(), checked = enabled.find(item => item.getAttribute('aria-checked') === 'true')
    const currentTool = enabled.find(item => item.getAttribute('aria-label') === primary?.label)
    ;(firstFocus.current === 'last' ? enabled.at(-1) : checked || currentTool || enabled[0])?.focus({ preventScroll: true })
    firstFocus.current = 'first'
  }, [open, position])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target) && !menu.current?.contains(event.target)) change.current(false)
    }
    const blur = () => change.current(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur) }
  }, [open])
  return <div ref={host} className="tool-popover" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.repeat && ['Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); return }
    if (event.target === trigger.current && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      firstFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'
      change.current(['Enter', ' '].includes(event.key) ? !open : true)
    } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(true) }
  }}>
    {primary && <button type="button" aria-label={primary.label} data-tooltip={primary.title || primary.label} aria-pressed={primary.active} className={primary.active ? 'active' : ''} onClick={() => { dismiss(); primary.onClick() }}>{icon}</button>}
    <button ref={trigger} type="button" className={primary ? 'tool-picker-arrow' : undefined} data-tooltip={label} aria-label={label} aria-haspopup="menu" aria-controls={open ? id : undefined} aria-expanded={open} onClick={() => change.current(!open)}>{primary ? <ChevronDown size={10} /> : icon}</button>
    {open && createPortal(<div ref={menu} id={id} className="tool-popover-content" role="menu" aria-label={label} tabIndex={-1}
      style={menuStyle(position, host.current)}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => {
        event.stopPropagation()
        const button = (event.target as Element).closest<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]')
        if (button && !button.disabled) button.focus({ preventScroll: true })
      }}
      onPointerUp={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.repeat && ['Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); return }
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismiss(true); return }
        const enabled = items()
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const at = enabled.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
            (Math.max(at, 0) + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
          enabled[next]?.focus({ preventScroll: true }); enabled[next]?.scrollIntoView({ block: 'nearest' })
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const selected = document.activeElement as HTMLButtonElement
          if (enabled.includes(selected)) selected.click()
        } else if (['ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(event.key)) event.preventDefault()
      }}
      onClickCapture={event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]')
        // Explicit menu actions enter the shared command dispatcher with canvas
        // ownership. Unhandled native commands while a menu is open stay blocked.
        if (button && !button.disabled) document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      }}
      onClick={event => {
        event.stopPropagation()
        const button = (event.target as Element).closest<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]')
        if (!button || button.disabled || event.defaultPrevented) return
        dismiss()
        queueMicrotask(() => {
          if (!document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) {
            const target = document.querySelector<HTMLElement>('[data-tool-autofocus]:not(:disabled)') || document.querySelector<HTMLElement>('[data-testid="canvas"]')
            target?.focus({ preventScroll: true })
            if (target instanceof HTMLInputElement) target.select()
          }
        })
      }}>{children}</div>, document.body)}
  </div>
}
