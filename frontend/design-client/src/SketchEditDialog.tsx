import { SketchLegacyResizeEditor } from './SketchLegacyResizeEditor'
import { SketchFrameEditor } from './SketchFrameEditor'
import { SketchTextOverrideEditor } from './SketchTextOverrideEditor'
import { SketchSessionPreview } from './SketchSessionPreview'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SketchSessionBridge } from './desktop'
import { SketchEditSession } from './sketch-edit-session'
import { modalKeyDown } from './modal-keyboard'
export function SketchEditDialog({ bridge, onClose }: { bridge: SketchSessionBridge; onClose: () => void }) {
  const [controller] = useState(() => new SketchEditSession(bridge))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [selected, setSelected] = useState(''), [name, setName] = useState(''), [pageId, setPageId] = useState('')
  useEffect(() => { controller.activate(); return () => controller.dispose() }, [controller])
  const close = async () => { if (await controller.close()) onClose() }
  const s = state.session, blocked = state.pending || state.uncertain
  return <div className="modal-backdrop" data-desktop-dialog="true"><section className="remote-modal sketch-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="sketch-edit-title"
    onKeyDown={event => modalKeyDown(event, () => { if (!state.pending) void close() })}>
    <h2 id="sketch-edit-title">独立 Sketch 编辑会话</h2>
    <p>原生页/图层名称、受支持叶层位置/尺寸及实例文本覆盖编辑；不转换为 Figma 文档。修改先保存在内存；可另存到全新 .sketch 文件，绝不覆盖已有文件。退出进程会丢失未保存修改。</p>
    {!s ? <button type="button" autoFocus disabled={state.pending} onClick={() => void controller.open()}>选择或恢复 Sketch 原生会话…</button> : <>
      <p>{state.displayName} · revision {s.revision} · {s.dirty ? '有未保存或待核实修改' : s.persistence === 'native-file-saved' ? '已另存为原生文件' : '源文件尚未修改'} · undo {s.undoCount} / redo {s.redoCount}</p>
      <p>内核 {s.owner.kernel_id} / {s.owner.document_schema} · epoch {s.owner.session_epoch}</p>
      <label>原生页 / 图层<select value={selected} disabled={blocked} onChange={e => { setSelected(e.target.value); setName('') }}>
        <option value="">请选择</option>
        {s.layers.map(layer => <option key={layer.id} value={layer.id}>{layer.depth === 0 ? '页：' : '层：'}{'·'.repeat(Math.min(layer.depth, 8))}{layer.name || '(未命名)'} [{layer.id}]</option>)}
      </select></label>
      {s.layersTruncated && <p>此入口仅列出前 512 个原生页/图层，未列出的内容仍保留在内核中。</p>}
      <label>新名称<input value={name} disabled={blocked || !selected} placeholder="输入新名称，不会自动截断原名" onChange={e => setName(e.target.value)} /></label>
      <div className="remote-actions">
        <button type="button" disabled={blocked || !selected || !name || new TextEncoder().encode(name).length > 4096} onClick={() => void controller.rename(selected, name)}>重命名</button>
        <button type="button" disabled={blocked || s.undoCount === 0} onClick={() => void controller.undo()}>撤销</button>
        <button type="button" disabled={blocked || s.redoCount === 0} onClick={() => void controller.redo()}>重做</button>
        <button type="button" disabled={blocked} onClick={() => void controller.saveAs()}>另存为新 Sketch 文件…</button>
        <button type="button" disabled={state.pending} onClick={() => void controller.refresh()}>核对会话状态</button>
      </div>
      <SketchFrameEditor bridge={bridge} session={s} controller={controller} selected={selected} blocked={blocked} />
      <SketchLegacyResizeEditor key={JSON.stringify([s.owner, s.revision, selected])} controller={controller} selected={selected} blocked={blocked} />
      <SketchTextOverrideEditor bridge={bridge} session={s} key={JSON.stringify([s.owner, s.revision, selected])} controller={controller} selected={selected} blocked={blocked} />
      <label>会话预览页面<select value={pageId} disabled={state.pending} onChange={e => setPageId(e.target.value)}>
        <option value="">选择页面</option>{s.layers.filter(layer => layer.depth === 0).map(page => <option key={page.id} value={page.id}>{page.name || '(未命名页)'} [{page.id}]</option>)}
      </select></label>
      <p>只读快照来自当前未保存会话，按 revision 更新；不支持的原生内容明确拒绝预览。</p>
      <SketchSessionPreview bridge={bridge} session={s} pageId={pageId} />
    </>}
    {state.pending && <p role="status">操作处理中，请勿重复提交。</p>}
    {state.error && <p role="alert">{state.error}</p>}
    <p>现有 futureox-desgin 画布及保存目标保持不变。</p>
    <button type="button" disabled={state.pending} onClick={() => void close()}>关闭 Sketch 会话（有修改时确认放弃）</button>
  </section></div>
}
