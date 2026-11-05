import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { Editor } from '../engine'
import { createEditorDesignAutomation } from '../automation'
import { modalKeyDown } from '../modal-keyboard'
import { loadPluginFromFileList, loadPluginFromGitHub, loadPluginFromZipBytes } from './loader'
import { PluginHost, type PluginBundle } from './host'

type PanelProps = { editor: Editor }
type DialogComponent = ComponentType<PanelProps & { onClose: () => void }>

/** 常驻按钮保持轻量；对话框按需异步加载（与 AI/MCP 面板同模式）。 */
export function PluginPanel(props: PanelProps) {
  const [open, setOpen] = useState(false)
  const [Dialog, setDialog] = useState<DialogComponent | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const loadingClose = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open || Dialog) return
    let current = true
    void import('./PluginDialog').then(module => {
      if (current) setDialog(() => module.PluginDialog)
    }).catch(failure => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { current = false }
  }, [open, Dialog, attempt])
  const close = () => { setOpen(false); trigger.current?.focus() }
  return <>
    <button ref={trigger} type="button" onClick={() => { if (!open) { setError(''); setOpen(true) } }}>插件</button>
    {open && (Dialog ? <Dialog {...props} onClose={close} /> :
      <div className="modal-backdrop">
        <section className="remote-modal" role="dialog" aria-modal="true" aria-label="插件容器"
          style={{ width: 'min(760px,95vw)', maxHeight: '90vh', overflow: 'auto' }}
          onKeyDown={event => modalKeyDown(event, close)}>
          <h2>插件 <button ref={loadingClose} autoFocus type="button" aria-label="关闭插件面板" onClick={close}>关闭</button></h2>
          {error ? <><p role="alert">面板载入失败：{error}</p><button type="button" onClick={() => { loadingClose.current?.focus(); setError(''); setAttempt(value => value + 1) }}>重试</button></> :
            <p role="status" aria-live="polite">正在载入插件容器…</p>}
        </section>
      </div>)}
  </>
}
