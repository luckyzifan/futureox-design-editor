import { useEffect, useState } from 'react'
import { admitSketchLeafFrame } from '../../design-desktop/src/sketch-session-contract.mjs'
import type { SketchLeafFrameStatus, SketchSessionBridge, SketchSessionStatus } from './desktop'
import type { SketchEditSession } from './sketch-edit-session'
import { parseSketchFrameDraft, type SketchFrameDraft } from './sketch-frame-draft'
import { useProfessionalDialogText } from './professional-dialog-messages'
export function SketchFrameEditor({ bridge, session, controller, selected, blocked }: { bridge: SketchSessionBridge; session: SketchSessionStatus; controller: SketchEditSession; selected: string; blocked: boolean }) {
  const { tr } = useProfessionalDialogText()
  const [response, setResponse] = useState<{ key: string; value?: SketchLeafFrameStatus; error?: string } | null>(null)
  const [draft, setDraft] = useState<SketchFrameDraft>({ x: '', y: '', width: '', height: '' })
  const key = JSON.stringify([session.owner, session.revision, selected])
  useEffect(() => {
    let current = true
    if (!selected) return
    void bridge.leafFrame({ owner: session.owner, expectedRevision: session.revision, layerId: selected }).then(result => {
      if (!current) return
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '已取消' : result.message)
      const value = admitSketchLeafFrame(result, session.owner, session.revision, selected)
      setResponse({ key, value })
      if (value.frame) setDraft({ x: String(value.frame.x), y: String(value.frame.y), width: String(value.frame.width), height: String(value.frame.height) })
    }).catch(error => { if (current) setResponse({ key, error: String(error) }) })
    return () => { current = false }
  }, [bridge, key])
  if (!selected) return null
  if (response?.key !== key) return <p role="status">{tr('正在查询所选原生层的位置/尺寸编辑能力…')}</p>
  if (response.error || !response.value?.frame) return <p role="status">{tr(`此层不可编辑位置/尺寸：${response.error || response.value?.reason || ''}`)}</p>
  const frame = parseSketchFrameDraft(draft)
  return <fieldset disabled={blocked}>
    <legend>{tr('原生叶层位置 / 尺寸')}</legend>
    <p>{tr('X / Y 是原生父图层坐标，不是屏幕或全局坐标；宽高最小 0.5。此操作不重排父容器、不改写归一化路径点。')}</p>
    {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{tr(({ x: 'X', y: 'Y', width: '宽', height: '高' })[field])}
      <input type="number" step="any" min={field === 'width' || field === 'height' ? 0.5 : -1e9} max={1e9} value={draft[field]}
        onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))} /></label>)}
    {!frame && <p>{tr('请输入有限数值，坐标范围 ±1e9，尺寸范围 0.5–1e9。')}</p>}
    <button type="button" disabled={blocked || !frame} onClick={() => { if (frame) void controller.setLeafFrame(selected, frame) }}>{tr('应用位置 / 尺寸')}</button>
    <p>{tr('失败保留输入；成功后可撤销/重做，当前会话预览随 revision 更新。')}</p>
  </fieldset>
}
