import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown } from './modal-keyboard'

type DialogProps = { editor: Editor; desktop?: DesktopBridge | null; onClose: () => void }
type DialogComponent = ComponentType<DialogProps>

/** The plugin runtime loads only after the panel opens, so canvas startup does not fetch the sandbox. */
export function PluginHostLauncher({ editor, desktop, disabled }: { editor: Editor; desktop?: DesktopBridge | null; disabled?: boolean }) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const label = en ? 'Plugins' : '插件'
  const [open, setOpen] = useState(false)
  const [Dialog, setDialog] = useState<DialogComponent | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open || Dialog) return
    let current = true
    void import('./PluginHostDialog').then(module => { if (current) setDialog(() => module.PluginHostDialog) })
      .catch(failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { current = false }
  }, [open, Dialog, attempt])
  const close = () => { setOpen(false); trigger.current?.focus() }
  return <>
    <button ref={trigger} type="button" className="plugin-host-button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => { if (!open) { setError(''); setOpen(true) } }}>{label}</button>
    {open && (Dialog ? <Dialog editor={editor} desktop={desktop} onClose={close} /> :
      <div className="modal-backdrop">
        <section className="remote-modal" role="dialog" aria-modal="true" aria-label={label} onKeyDown={event => modalKeyDown(event, close)}>
          <h2>{label} <button type="button" autoFocus aria-label={en ? 'Close plugins' : '关闭插件'} onClick={close}>{en ? 'Close' : '关闭'}</button></h2>
          {error ? <p role="alert">{error}</p> : <p role="status">{en ? 'Loading plugins…' : '正在载入插件…'}</p>}
          {error && <button type="button" onClick={() => { setError(''); setAttempt(value => value + 1) }}>{en ? 'Retry' : '重试'}</button>}
        </section>
      </div>)}
  </>
}
