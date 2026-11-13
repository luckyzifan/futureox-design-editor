import type { PresentedFrame } from './Surface'
import type { CanvasCamera } from '../canvas-camera'
import { presentationContentMatches, presentationMatches } from './presentation'

export type ResidentAcknowledgement = {
  presentationId?: string
  presentationToken?: number
  gpuOverlay?: boolean
  gpuSelection?: boolean
  gpuPixelGrid?: boolean
  view: CanvasCamera
  width: number
  height: number
  dpr: number
  interaction: boolean
  preview?: boolean
  /** The previous picture was resampled under ready finer tiles. This is not
   * a native frame and it has no holes punched through that picture. */
  zoomUnderlay?: boolean
  previewGaps?: import("./navigation-backing").ScreenRect[]
  navigationBackingBytes?: number
  ids: number[]
}

function captureMatches(source: PresentedFrame, actual: ResidentAcknowledgement): boolean {
  const capture=source.gpuOverlayCapture
  if(!capture)return true
  const ids=new Set(actual.ids)
  return capture.slots.length>0&&capture.slots.every(id=>id>0&&ids.has(id))
}

function capturedFrame(source: PresentedFrame, actual: ResidentAcknowledgement): PresentedFrame {
  const frame = { ...source, gpuOverlay: actual.gpuOverlay,
    gpuSelectionIdentity: actual.gpuSelection ? source.gpuSelectionIdentity : undefined,
    gpuPixelGrid:actual.gpuPixelGrid, view: actual.view, width: actual.width, height: actual.height, pixelRatio: actual.dpr }
  return { ...frame, preview: !!source.preview || !!actual.preview || actual.interaction || !presentationMatches(source, frame) }
}

/** Associate GPU replies with the immutable document that supplied their
 * pixels. Camera-only previews share one context; document/contract changes
 * retain their own contexts until the display acknowledges them. */
export class ResidentPresentation {
  private prefix = crypto.randomUUID()
  private serial = 0
  private acknowledged = 0
  private current?: { id: string; frame: PresentedFrame }
  private pending = new Map<string, { serial: number; frame: PresentedFrame }>()
  stage(frame: PresentedFrame | null): string | undefined {
    if (!frame) return undefined
    const previous = this.current
    if (previous && !!previous.frame.preview === !!frame.preview && previous.frame.managed === frame.managed &&
      previous.frame.gpuOverlay === frame.gpuOverlay &&
      previous.frame.gpuSelectionIdentity === frame.gpuSelectionIdentity &&
      previous.frame.gpuOverlayIdentity === frame.gpuOverlayIdentity &&
      previous.frame.gpuOverlayCapture === frame.gpuOverlayCapture &&
      previous.frame.computeBackend === frame.computeBackend &&
      (frame.preview ? presentationContentMatches(previous.frame, frame) : presentationMatches(previous.frame, frame))) return previous.id
    if (this.pending.size >= 128) throw Error('GPU display acknowledgements stalled')
    const serial = ++this.serial, id = `${this.prefix}:${serial}`
    this.current = { id, frame }; this.pending.set(id, { serial, frame })
    return id
  }
  /** Only reject acknowledgements proven to belong to this tracker. Frames
   * without a staged source remain admissible for live/fallback presentation. */
  rejectsAcknowledgement(actual: ResidentAcknowledgement): boolean {
    const id=actual.presentationId
    if(!id)return false
    const record=this.pending.get(id)
    if(record)return record.serial<this.acknowledged||!captureMatches(record.frame,actual)
    if(!id.startsWith(this.prefix+':'))return false
    const suffix=id.slice(this.prefix.length+1),serial=Number(suffix)
    return /^[1-9]\d*$/.test(suffix)&&Number.isSafeInteger(serial)&&serial<this.acknowledged
  }
  resolve(actual: ResidentAcknowledgement): PresentedFrame | undefined {
    const record = actual.presentationId ? this.pending.get(actual.presentationId) : undefined
    if (!record || record.serial < this.acknowledged || !captureMatches(record.frame, actual)) return undefined
    this.acknowledged = record.serial
    for (const [id, value] of this.pending) if (value.serial < record.serial) this.pending.delete(id)
    return capturedFrame(record.frame, actual)
  }
  /** Call immediately before posting a capture command. Messages to the same
   * worker are ordered, and the worker tags the copy before its first await.
   * Keep only the bounded contexts already posted, for this readback's lifetime.
   * Resolving a snapshot never acknowledges or publishes an old display frame. */
  snapshotResolver(): (actual: ResidentAcknowledgement) => PresentedFrame | undefined {
    const records = new Map(this.pending)
    return actual => {
      const record = actual.presentationId ? records.get(actual.presentationId) : undefined
      return record && captureMatches(record.frame, actual) ? capturedFrame(record.frame, actual) : undefined
    }
  }
}
