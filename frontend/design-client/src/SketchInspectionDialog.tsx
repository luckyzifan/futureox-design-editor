import { SketchReadOnlyPreview } from './SketchReadOnlyPreview'
import { useEffect, useRef, useState } from 'react'
import { modalKeyDown } from './modal-keyboard'
import type { SketchInspection } from './sketch-inspection'

export function SketchInspectionDialog({ result, onClose, onChoose, pending = false, error, onImportCompatibility }: { result: SketchInspection | null; onClose: () => void; onChoose?: () => void; pending?: boolean; error?: string; onImportCompatibility?: () => void }) {
  const close = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null)
  const [opened,setOpened]=useState<string|null>(null)
  const identity=result?`${result.owner.document_id}/${result.owner.session_epoch}`:null
  const confirmed=!!identity&&opened===identity
  const canOpen=!!result&&result.preview.status!=='unavailable'
  const unavailableReason=result&&result.preview.status==='unavailable'?result.preview.reason:null
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
        <h2 id="sketch-inspection-title">{confirmed?result!.displayName:'打开 Sketch 文件'}</h2>
        {result&&<p>{confirmed?'':`${result.displayName} · `}{result.pageCount} 页 · {result.layerCount} 个图层（含页面）</p>}
      </header>
      <div className="sketch-open-body">
        {confirmed&&result?<SketchReadOnlyPreview result={result}/>:unavailableReason!==null?<>
          <p role="alert">这个文件里有原生只读预览还不能绘制的内容，确认打开保持禁用。选择的文件保持原样。</p>
          <p>可以用兼容格式导入，把图层放进当前画布继续编辑。兼容导入会保留名称、位置、尺寸、颜色和填充透明度；它是可编辑导入，画面以兼容导入结果为准。</p>
          {onImportCompatibility
            ? <button type="button" onClick={onImportCompatibility}>用兼容格式导入…</button>
            : <p>请从文件菜单选择「导入 Sketch / FIG / SVG / PDF」。</p>}
          <p className="muted">{unavailableReason}</p>
        </>:result?<>
          <p>确认后打开原生画板预览，可切换画板、缩放和平移。</p>
          <p>缺失字体使用项目默认字体。</p>
        </>:<p role="status">{pending ? '正在等待原生文件检查结果…' : '选择 .sketch 文件进行原生只读预览；不会导入当前画布或修改原文件。'}</p>}
        {error && <p role="alert">{error}</p>}
        {!result && onChoose && <button type="button" disabled={pending} onClick={onChoose}>选择 Sketch 文件…</button>}
      </div>
      <footer className="sketch-open-footer" data-testid="sketch-open-actions">
        <span>{confirmed?'只读预览 · 原文件未修改':'本机只读预览 · 原文件保留'}</span>
        <button type="button" className={confirmed?'primary':undefined} ref={close} onClick={onClose}>{confirmed?'完成':'取消'}</button>
        {!confirmed&&<button type="button" className="primary" ref={confirm} disabled={!canOpen} onClick={()=>{if(canOpen)setOpened(identity)}}>确认打开</button>}
      </footer>
    </section>
  </div>
}
