import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopBridge } from './desktop'
import { modalKeyDown } from './modal-keyboard'

export type NativeSketchContentProps = { bridge: DesktopBridge; mode: 'inspect' | 'edit'; onClose: () => void }
type NativeSketchContent = ComponentType<NativeSketchContentProps>
const loadContent = () => import('./NativeSketchDialogContent').then(module => module.NativeSketchDialogContent)

/** The optional native UI stays out of the startup chunk. This small portal owns
 * focus continuously across loading/error/content and yields to .fd close prompts. */
export function NativeSketchDialog({ bridge, mode, onClose, returnFocus, suspended = false, load = loadContent }: NativeSketchContentProps & {
  returnFocus?: HTMLElement | null; suspended?: boolean; load?: () => Promise<NativeSketchContent>
}) {
  const [Dialog, setDialog] = useState<NativeSketchContent | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const container = useRef<HTMLDivElement>(null), loadingClose = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (Dialog) return
    let current = true
    void load().then(value => { if (current) setDialog(() => value) }).catch(failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { current = false }
  }, [Dialog, load, attempt])
  useLayoutEffect(() => {
    if (suspended) return
    const previous = returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const background = [...document.body.children].filter(element => element !== container.current).map(element => ({ element, inert: element.getAttribute('inert') }))
    const overflow = document.body.style.overflow
    for (const { element } of background) element.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    const focus = () => container.current?.querySelector<HTMLElement>('button:not(:disabled),[tabindex="-1"]')?.focus({ preventScroll: true })
    const retainFocus = (event: FocusEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) focus() }
    document.addEventListener('focusin', retainFocus); focus()
    return () => {
      document.removeEventListener('focusin', retainFocus)
      for (const { element, inert } of background) { if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert) }
      document.body.style.overflow = overflow
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [returnFocus, suspended])
  return createPortal(<div ref={container} hidden={suspended}>
    {Dialog ? <Dialog bridge={bridge} mode={mode} onClose={onClose} /> :
      <div className="modal-backdrop" data-desktop-dialog="true"><section className="remote-modal" role="dialog" aria-modal="true" aria-label="原生 Sketch" tabIndex={-1}
        onKeyDown={event => modalKeyDown(event, onClose)}>
        <h2>{mode === 'inspect' ? '预览原生 Sketch（只读）' : '编辑原生 Sketch（有限支持）'}</h2>
        {error ? <><p role="alert">面板载入失败：{error}</p><button type="button" onClick={() => { loadingClose.current?.focus(); setError(''); setAttempt(value => value + 1) }}>重试</button></> :
          <p role="status" aria-live="polite">正在载入原生 Sketch 面板…</p>}
        <button ref={loadingClose} autoFocus type="button" onClick={onClose}>取消</button>
      </section></div>}
  </div>, document.body)
}
