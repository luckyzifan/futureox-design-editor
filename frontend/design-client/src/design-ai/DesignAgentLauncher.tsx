import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles } from 'lucide-react'
import type { Editor } from '../engine'
import type { DesktopBridge } from '../desktop'
import { commitPendingEdits } from '../pending-edits'
const Panel = lazy(() => import('./DesignAgentPanel'))

export function DesignAgentLauncher({ editor, desktop, disabled }: { editor: Editor; desktop?: DesktopBridge | null; disabled: boolean }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const close = () => { setOpen(false); trigger.current?.focus() }
  return <>
    <button type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => {
      if (!editor.state.busy && !editor.interactionActive && commitPendingEdits(editor)) setOpen(true)
    }}><Sparkles size={16}/><span>设计助手</span></button>
    {open && createPortal(<Suspense fallback={<div className="modal-backdrop"><section className="remote-modal" role="dialog" aria-modal="true" aria-label="设计助手">
      <p role="status">正在载入设计助手…</p><button autoFocus type="button" onClick={close}>关闭</button>
    </section></div>}><Panel editor={editor} desktop={desktop} onClose={close}/></Suspense>, document.body)}
  </>
}
