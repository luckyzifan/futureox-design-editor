import type { AuthoredSnapshot } from './authored-snapshot'
import type { DesignDocument } from '../model'
import type { GpuScene } from './gpu/types'
import type { RenderKernel } from './render-kernel'
import { createDecodedImageOwner } from './decoded-image-cache'

export type RenderLaneName = 'canvas' | 'interaction'
/** CPU/authored state has one stable object per lane. No save/restore copies:
 * an asynchronous continuation can retain its lane even when another is active.
 * GPU caches, encoders and device policy deliberately do not belong here. */
export class RenderLaneState {
  decodedImageOwner = createDecodedImageOwner()
  enginePromise?: Promise<RenderKernel>
  loadedDocument = ''
  sourceSnapshotToken?: string
  authoredSnapshot?: AuthoredSnapshot
  loadedRevision = -1
  interactionDocument?: DesignDocument
  synchronizedInteractionDocument?: DesignDocument
  // Only accepted pure translations may leave the CPU kernel behind the GPU graph.
  deferredInteractionDocument?: DesignDocument
  // One scene per lane, certified by document revision and complete compile options.
  compiledScene?: { revision: number; options: string; scene: GpuScene }
  loadedDocumentId = ''
  loadedNodeCount = 0
  documentGeneration = 0
  resourceGeneration = 0
  constructor(readonly name: RenderLaneName) {}
}
export class RenderLaneStates {
  private lanes = new Map<RenderLaneName, RenderLaneState>()
  get(name: RenderLaneName): RenderLaneState {
    let lane = this.lanes.get(name)
    if (!lane) { lane = new RenderLaneState(name); this.lanes.set(name, lane) }
    return lane
  }
}
