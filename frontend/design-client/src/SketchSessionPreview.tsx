import { useEffect, useState } from 'react'
import type { SketchSessionBridge, SketchSessionStatus } from './desktop'
import type { SessionPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
import { SketchReadOnlyPreview } from './SketchReadOnlyPreview'
import { SketchPreviewRequest, sketchPreviewKey } from './sketch-preview-request'
import { useProfessionalDialogText } from './professional-dialog-messages'
export function SketchSessionPreview({ bridge, session, pageId }: { bridge: SketchSessionBridge; session: SketchSessionStatus; pageId: string }) {
  const { tr } = useProfessionalDialogText()
  const [requests] = useState(() => new SketchPreviewRequest())
  const [result, setResult] = useState<{ key: string; value?: SessionPreview; error?: string } | null>(null)
  const { owner, revision } = session
  const key = sketchPreviewKey(session, pageId)
  useEffect(() => {
    setResult(null)
    if (!pageId) return
    void requests.read(bridge, owner, revision, pageId).then(value => { if (value) setResult({ key, value }) }, error => setResult({ key, error: String(error) }))
    return () => requests.invalidate()
    // Scalar snapshot key deliberately excludes savedRevision/dirty: saving is not an edit.
  }, [bridge, key, requests])
  if (!pageId) return <p>{tr('选择原生页面后请求当前编辑会话预览。')}</p>
  if (result?.key !== key) return <p role="status">{tr(`正在生成 revision ${revision} 的原生页面快照…`)}</p>
  if (result.error) return <p role="status">{tr(`不可预览：${result.error}`)}</p>
  return result.value ? <SketchReadOnlyPreview result={result.value} revision={revision} firstPage={false} /> : null
}
