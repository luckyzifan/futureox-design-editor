import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { applyBatchRename, planBatchRename, type BatchRenameOptions } from './batch-rename'
import { batchRenameIsCurrent, batchRenameSnapshot, closeBatchRename, subscribeBatchRename, type BatchRenameSession } from './batch-rename-session'
import { modalKeyDown } from './modal-keyboard'
import { batchRenameHelp, batchRenameOverflow, batchRenameStatus, useProfessionalDialogText } from './professional-dialog-messages'
import './batch-rename-dialog.css'

/** Mount once in the Forma editor. The shared rename command opens this host. */
export function BatchRenameDialog({ editor }: { editor: Editor }) {
  const subscribe = useMemo(() => (listener: () => void) => subscribeBatchRename(editor, listener), [editor])
  const snapshot = useMemo(() => () => batchRenameSnapshot(editor), [editor])
  const session = useSyncExternalStore(subscribe, snapshot)
  const mounted = useRef(0)
  useEffect(() => {
    const token = ++mounted.current
    return () => { queueMicrotask(() => { if (mounted.current === token) closeBatchRename(editor) }) }
  }, [editor])
  return session ? <RenamePreview key={session.id} editor={editor} session={session} /> : null
}
function RenamePreview({ editor, session }: { editor: Editor; session: BatchRenameSession }) {
  const { locale, tr } = useProfessionalDialogText()
  const id = useId(), dialog = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null), first = useRef<HTMLInputElement>(null)
  const [prefix, setPrefix] = useState(''), [suffix, setSuffix] = useState(''), [find, setFind] = useState(''), [replace, setReplace] = useState('')
  const [numbered, setNumbered] = useState(false), [start, setStart] = useState('1'), [step, setStep] = useState('1'), [padding, setPadding] = useState('2')
  const [position, setPosition] = useState<'prefix' | 'suffix'>('suffix'), [separator, setSeparator] = useState(' '), [failure, setFailure] = useState('')
  const closing = useRef(false)
  const close = () => { if (!closing.current) { closing.current = true; closeBatchRename(editor) } }
  const preview = useMemo(() => {
    try {
      const options: BatchRenameOptions = { prefix, suffix, find, replace }
      if (numbered) options.numbering = { start: start.trim() ? Number(start) : NaN, step: step.trim() ? Number(step) : NaN, padding: padding.trim() ? Number(padding) : NaN, position, separator }
      const plan = planBatchRename(session.document, session.pageId, session.selection, options)
      return { plan, error: '', changed: plan.entries.filter(entry => entry.from !== entry.to).length }
    } catch (error) { return { plan: null, error: error instanceof Error ? error.message : String(error), changed: 0 } }
  }, [session.document, session.pageId, session.selection, prefix, suffix, find, replace, numbered, start, step, padding, position, separator])
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    const background = [...document.body.children].filter(element => element !== backdrop.current).map(element => ({ element, inert: element.getAttribute('inert') }))
    background.forEach(({ element }) => element.setAttribute('inert', ''))
    document.body.style.overflow = 'hidden'; first.current?.focus()
    const retainFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.current?.contains(event.target)) (first.current?.matches(':disabled') ? dialog.current : first.current)?.focus() }
    document.addEventListener('focusin', retainFocus)
    return () => {
      document.removeEventListener('focusin', retainFocus)
      background.forEach(({ element, inert }) => { if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert) })
      document.body.style.overflow = overflow
      const target = previous?.isConnected && !previous.closest('[inert],[role="menu"],[role="dialog"]') && previous !== document.body ? previous : document.querySelector<HTMLElement>('[data-testid="canvas"]')
      target?.focus({ preventScroll: true })
    }
  }, [])
  const stale = session.stale || !batchRenameIsCurrent(editor, session)
  const error = stale ? '设计、页面或选区已变化。请关闭后重新打开批量重命名。' : preview.error || failure
  const shownError = error ? tr(error) : ''
  return createPortal(<div ref={backdrop} className="batch-rename-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) close() }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <section ref={dialog} className="batch-rename-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} tabIndex={-1}
      onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return }; modalKeyDown(event, close) }}>
      <form onSubmit={event => {
        event.preventDefault()
        if (closing.current || !preview.plan || !preview.changed) return
        if (!batchRenameIsCurrent(editor, session)) { setFailure('重命名预览已过期，请重新打开'); return }
        const result = editor.change('批量重命名', draft => applyBatchRename(draft, preview.plan!), undefined, preview.plan.entries.map(entry => entry.id))
        if (result.status === 'committed' || result.status === 'unchanged') close()
        else setFailure(result.status === 'rejected' ? result.message : '请先结束当前编辑再重命名')
      }}>
        <header><div><h2 id={`${id}-title`}>{tr('批量重命名')}</h2><p id={`${id}-help`}>{batchRenameHelp(session.selection.length, locale)}</p></div>
          <button type="button" aria-label={tr('关闭批量重命名')} onClick={close}>×</button></header>
        <div className="batch-rename-content">
          <fieldset disabled={stale}><legend>{tr('名称规则')}</legend><div className="batch-rename-fields">
            <label>{tr('前缀')}<input ref={first} value={prefix} maxLength={200} onChange={event => { setPrefix(event.target.value); setFailure('') }} /></label>
            <label>{tr('后缀')}<input value={suffix} maxLength={200} onChange={event => { setSuffix(event.target.value); setFailure('') }} /></label>
            <label>{tr('查找文字')}<input value={find} maxLength={200} onChange={event => { setFind(event.target.value); setFailure('') }} /></label>
            <label>{tr('替换为')}<input value={replace} maxLength={200} onChange={event => { setReplace(event.target.value); setFailure('') }} /></label>
          </div><p>{tr('替换所有完全匹配的文字，区分大小写，不使用正则表达式。')}</p>
          <label className="batch-rename-toggle"><input type="checkbox" checked={numbered} onChange={event => { setNumbered(event.target.checked); setFailure('') }} />{tr('添加连续编号')}</label>
          {numbered && <div className="batch-rename-fields">
            <label>{tr('起始编号')}<input type="number" min={0} step={1} value={start} onChange={event => setStart(event.target.value)} /></label>
            <label>{tr('编号步长')}<input type="number" step={1} value={step} onChange={event => setStep(event.target.value)} /></label>
            <label>{tr('最少位数')}<input type="number" min={0} max={12} step={1} value={padding} onChange={event => setPadding(event.target.value)} /></label>
            <label>{tr('编号位置')}<select value={position} onChange={event => setPosition(event.target.value as 'prefix' | 'suffix')}><option value="suffix">{tr('名称之后')}</option><option value="prefix">{tr('名称之前')}</option></select></label>
            <label>{tr('编号分隔符')}<input value={separator} maxLength={200} onChange={event => setSeparator(event.target.value)} /></label>
          </div>}</fieldset>
          <h3>{tr('预览')}</h3>
          {preview.plan && <div className="batch-rename-preview"><table><thead><tr><th scope="col">{tr('原名称')}</th><th scope="col">{tr('新名称')}</th></tr></thead>
            <tbody>{preview.plan.entries.slice(0, 200).map(entry => <tr key={entry.id} data-node-id={entry.id}><td>{entry.from}</td><td>{entry.to}</td></tr>)}</tbody></table>
            {preview.plan.entries.length > 200 && <p>{batchRenameOverflow(preview.plan.entries.length, locale)}</p>}</div>}
        </div>
        <footer><p role={error ? 'alert' : 'status'} aria-live="polite">{shownError || batchRenameStatus(preview.changed, locale)}</p>
          <div><button type="button" onClick={close}>{tr('取消')}</button><button type="submit" disabled={stale || !!preview.error || !preview.changed}>{tr('应用重命名')}</button></div></footer>
      </form>
    </section>
  </div>, document.body)
}
