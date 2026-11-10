import { useState } from 'react'
import { X } from 'lucide-react'
import type { SketchOpenBlock } from './sketch-library-locate'
import { sourceErrorSummary } from './source-error-text'

/** Locate a local .sketch library before open. Failure stays an error and does not adopt a document. */
export function SketchLibraryLocate({ block, error, busy, onClose, onAttach }: {
  block: SketchOpenBlock
  error: string
  busy: boolean
  onClose: () => void
  onAttach: (libraries: File[]) => Promise<void>
}) {
  const [files, setFiles] = useState<File[]>([])
  const [localError, setLocalError] = useState('')
  const title = block.kind === 'style' ? '缺少外部图层样式'
    : block.kind === 'symbol' ? '缺少外部符号'
    : block.kind === 'corrupt' ? '损坏的覆盖引用'
    : '无法映射的字段'
  const guidance = block.kind === 'corrupt'
    ? '这是损坏的图层引用。更换无关库不能生成这个图层，源文件保持未打开。'
    : block.kind === 'unmapped'
      ? '这个覆盖没有可编辑映射。不会跳过该字段，也不会关闭无损保护。源文件保持未打开。'
      : block.canAttach
        ? '只按 symbolID 或共享样式 ID 对接。名称相同不会被当成同一个组件。附上库之后如果仍然缺失，文件保持未打开。'
        : '这份库有成员超过现有条目上限，没有展开。不能据此判断定义是否缺失，也不会提高上限。请改用一份在条目上限内、且包含该 ID 的 .sketch 库，然后重新打开工程。'
  return <section className="sketch-library-locate" aria-label="定位 Sketch 库" data-desktop-dialog>
    <section className="source-status-card" data-error="true">
      <div className="source-status-title"><strong>{title}</strong>
        <button type="button" aria-label="关闭库定位" onClick={onClose}><X size={14} /></button></div>
      <p role="alert">{sourceErrorSummary(error)}</p>
      <p>{guidance}</p>
      {block.canAttach && <label className="sketch-library-file">定位本地 .sketch 库
        <input aria-label="选择本地 Sketch 库" type="file" accept=".sketch,application/zip" multiple disabled={busy}
          onChange={event => { setFiles([...(event.currentTarget.files ?? [])]); setLocalError('') }} />
      </label>}
      {localError && <p role="alert">{localError}</p>}
      {block.canAttach && <div className="sketch-library-actions">
        <button type="button" disabled={busy || files.length === 0} onClick={() => void onAttach(files).catch(failure => setLocalError(failure instanceof Error ? failure.message : String(failure)))}>按 ID 核对并重新打开</button>
      </div>}
      <details><summary>技术详情</summary><pre>{error}</pre></details>
    </section>
  </section>
}
