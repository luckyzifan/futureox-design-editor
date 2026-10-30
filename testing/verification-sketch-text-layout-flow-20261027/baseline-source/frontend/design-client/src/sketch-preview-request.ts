import { admitSessionPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
import type { SessionPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
import type { SketchSessionBridge, SketchSessionOwner, SketchSessionStatus } from './desktop'
/** Every request invalidates older pages/revisions, including unsupported results. */
export class SketchPreviewRequest {
  private generation = 0
  invalidate() { this.generation++ }
  async read(bridge: SketchSessionBridge, owner: SketchSessionOwner, revision: number, pageId: string): Promise<SessionPreview | undefined> {
    const generation = ++this.generation
    try {
      const result = await bridge.preview({ owner, expectedRevision: revision, pageId })
      if (generation !== this.generation) return undefined
      if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '预览已取消' : result.message)
      return admitSessionPreview(result, owner, revision, pageId)
    } catch (error) { if (generation !== this.generation) return undefined; throw error }
  }
}

export function sketchPreviewKey(session: Pick<SketchSessionStatus, 'owner' | 'revision'>, pageId: string): string {
  const { owner, revision } = session
  return JSON.stringify([owner.kernel_id, owner.document_schema, owner.document_id, owner.session_epoch, revision, pageId])
}
