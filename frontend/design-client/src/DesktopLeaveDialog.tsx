import { useEffect, useRef } from 'react'
import type { LeaveDecision, LeaveReason } from './desktop-session'
import { leaveBody, useProfessionalDialogText } from './professional-dialog-messages'

export function DesktopLeaveDialog({ name, reason, onDecision }: {
  name: string
  reason: LeaveReason
  onDecision: (decision: LeaveDecision) => void
}) {
  const { tr, locale } = useProfessionalDialogText()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    cancel.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <div className="modal-backdrop" data-desktop-dialog="true" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
    <section className="remote-modal" role="alertdialog" aria-modal="true" aria-labelledby="desktop-unsaved-title" onKeyDown={(event) => {
      // Canvas shortcuts must not edit the document behind this confirmation.
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); onDecision('cancel') }
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <h2 id="desktop-unsaved-title">{tr('保存当前设计的修改？')}</h2>
      <p>{leaveBody(name, reason, locale)}</p>
      <div className="remote-actions">
        <button type="button" ref={cancel} onClick={() => onDecision('cancel')}>{tr('取消')}</button>
        <button type="button" onClick={() => onDecision('discard')}>{tr('不保存')}</button>
        <button type="button" className="primary" onClick={() => onDecision('save')}>{tr('保存')}</button>
      </div>
    </section>
  </div>
}
