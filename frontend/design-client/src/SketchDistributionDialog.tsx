import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { bindSketchDistributionDialog, type SketchDistributionChoice, type SketchDistributionRequest } from './sketch-distribution'

export function SketchDistributionDialog({ editor }: { editor: Editor }) {
  const active = useRef<SketchDistributionRequest | null>(null)
  const [request, setRequest] = useState<SketchDistributionRequest | null>(null)
  useEffect(() => {
    const unbind = bindSketchDistributionDialog(editor, next => {
      active.current?.cancel()
      active.current = next
      setRequest(next)
    })
    return () => {
      unbind()
      active.current?.cancel()
      active.current = null
    }
  }, [editor])
  if (!request) return null
  const close = () => {
    request.cancel()
    if (active.current === request) active.current = null
    setRequest(current => current === request ? null : current)
  }
  return <DistributionChoices editor={editor} request={request} close={close} />
}

function DistributionChoices({ editor, request, close }: {
  editor: Editor
  request: SketchDistributionRequest
  close: () => void
}) {
  const { locale } = useInterfacePreferences()
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const dialog = useRef<HTMLElement>(null), first = useRef<HTMLButtonElement>(null)
  const description = useId()
  useSyncExternalStore(editor.subscribe, editor.snapshot)
  useModalOwnership(dialog, first)
  const current = request.isCurrent()
  const choose = (choice: SketchDistributionChoice) => {
    if (request.isCurrent()) request.apply(choice)
    close()
  }

  return createPortal(<div className="modal-backdrop" onPointerDown={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget) close()
  }}>
    <section ref={dialog} tabIndex={-1} className="remote-modal" role="dialog" aria-modal="true"
      aria-label={label('分布位置', 'Distribution placement')} aria-describedby={description}
      onKeyDown={event => modalKeyDown(event, close)}>
      <h2>{label('分布位置', 'Distribution placement')}</h2>
      <p id={description}>{current
        ? label('贴合整像素会使间距略有不同。选择子像素可保持精确等距。', 'Use whole pixels with slightly different gaps, or use subpixels to keep equal spacing.')
        : label('选区或设置已变化，请重新分布。', 'The selection or settings changed. Distribute again.')}</p>
      <div className="remote-actions">
        <button ref={first} type="button" onClick={close}>{label('取消', 'Cancel')}</button>
        <button type="button" disabled={!current} onClick={() => choose('pixels')}>{label('按整像素分布', 'Distribute Unevenly')}</button>
        <button type="button" className="primary" disabled={!current} onClick={() => choose('subpixels')}>{label('放到子像素', 'Place on Sub-pixels')}</button>
      </div>
    </section>
  </div>, document.body)
}
