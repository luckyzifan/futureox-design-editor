import { SketchReadOnlyPreview } from './SketchReadOnlyPreview'
import { useEffect, useRef, useState } from 'react'
import { modalKeyDown } from './modal-keyboard'
import { sketchPageSummary, useProfessionalDialogText } from './professional-dialog-messages'
import type { SketchInspection } from './sketch-inspection'

export function SketchInspectionDialog({ result, onClose, onChoose, pending = false, error }: { result: SketchInspection | null; onClose: () => void; onChoose?: () => void; pending?: boolean; error?: string }) {
  const { locale, tr } = useProfessionalDialogText()
  const close = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null)
  const [opened,setOpened]=useState<string|null>(null)
  const identity=result?`${result.owner.document_id}/${result.owner.session_epoch}`:null
  const confirmed=!!identity&&opened===identity
  const canOpen=!!result&&result.preview.status!=='unavailable'
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(()=>{if(identity&&!confirmed)confirm.current?.focus()},[identity,confirmed])
  return <div className="modal-backdrop" data-desktop-dialog="true">
    <section className={`remote-modal sketch-open-dialog ${confirmed?'is-open':'is-confirmation'}`} role="dialog" aria-modal="true" aria-labelledby="sketch-inspection-title"
      onKeyDown={event => modalKeyDown(event, onClose)}>
      <header className="sketch-open-header">
        <h2 id="sketch-inspection-title">{confirmed?result!.displayName:tr('打开 Sketch 文件')}</h2>
        {result&&<p>{confirmed?'':`${result.displayName} · `}{sketchPageSummary(result.pageCount, result.layerCount, locale)}</p>}
      </header>
      <div className="sketch-open-body">
        {confirmed&&result?<SketchReadOnlyPreview result={result}/>:result?<>
          <p>{tr('确认后打开原生画板预览，可切换画板、缩放和平移。')}</p>
          <p>{tr('缺失字体使用项目默认字体。')}</p>
          {!canOpen&&<p role="alert">{tr(`当前文件暂时无法预览：${result.preview.status==='unavailable'?result.preview.reason:''}`)}</p>}
        </>:<p role="status">{pending ? tr('正在等待原生文件检查结果…') : tr('选择 .sketch 文件进行原生只读预览；不会导入当前画布或修改原文件。')}</p>}
        {error && <p role="alert">{tr(error)}</p>}
        {!result && onChoose && <button type="button" disabled={pending} onClick={onChoose}>{tr('选择 Sketch 文件…')}</button>}
      </div>
      <footer className="sketch-open-footer" data-testid="sketch-open-actions">
        <span>{confirmed?tr('只读预览 · 原文件未修改'):tr('本机只读预览 · 原文件保留')}</span>
        <button type="button" className={confirmed?'primary':undefined} ref={close} onClick={onClose}>{confirmed?tr('完成'):tr('取消')}</button>
        {!confirmed&&<button type="button" className="primary" ref={confirm} disabled={!canOpen} onClick={()=>{if(canOpen)setOpened(identity)}}>{tr('确认打开')}</button>}
      </footer>
    </section>
  </div>
}
