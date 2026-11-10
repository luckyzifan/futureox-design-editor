import { useState } from 'react'
import type { SketchLibraryGap } from './sketch-library-locate'

/** Locate a local .sketch library and retry admission. Failure stays an error. */
export function SketchLibraryLocate({ gap, error, busy, onClose, onAttach }: {
  gap: SketchLibraryGap
  error: string
  busy: boolean
  onClose: () => void
  onAttach: (libraries: File[]) => Promise<void>
}) {
  const [files, setFiles] = useState<File[]>([])
  const [localError, setLocalError] = useState('')
  return <section className="source-canvas-status" aria-label="定位 Sketch 库" style={{ position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 40 }}>
    <section className="source-status-card" data-error="true">
      <div className="source-status-title"><strong>{gap.kind === 'style' ? '缺少外部图层样式' : '缺少外部符号'}</strong>
        <button type="button" aria-label="关闭库定位" onClick={onClose}>×</button></div>
      <p role="alert">{error}</p>
      <p>只按 symbolID 或共享样式 ID 对接。名称相同不会被当成同一个组件。附上库之后如果仍然缺失，文件保持未打开。</p>
      <label>定位本地 .sketch 库
        <input aria-label="选择本地 Sketch 库" type="file" accept=".sketch" multiple disabled={busy || !gap.canAttach}
          onChange={event => { setFiles([...(event.currentTarget.files ?? [])]); setLocalError('') }} />
      </label>
      {localError && <p role="alert">{localError}</p>}
      <button type="button" disabled={busy || !gap.canAttach || files.length === 0} onClick={() => void onAttach(files).catch(failure => setLocalError(failure instanceof Error ? failure.message : String(failure)))}>按 ID 补齐并重新打开</button>
    </section>
  </section>
}
