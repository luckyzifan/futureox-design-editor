import type { CanvasCamera } from './canvas-camera'
import { localRequest, localTransaction, type LocalStoredRecord } from './local-store'

/** One bounded, revision-checked display hint. It is never editor data or an
 * exact frame, and can be decoded before loading the WASM document codec. */
export type StartupPreview = {
  documentId: string; revision: number; pageId: string; view: CanvasCamera
  width: number; height: number; background: string; image: Blob
}
export type PreviewPixels = Omit<StartupPreview, 'documentId' | 'revision'>
export function validStartupPreview(preview: StartupPreview, id: unknown, revision: unknown) {
  return preview.documentId === id && preview.revision === revision &&
    Number.isSafeInteger(preview.revision) && preview.revision > 0 &&
    typeof preview.pageId === 'string' && typeof preview.background === 'string' &&
    [preview.width, preview.height, preview.view?.zoom].every(n => Number.isFinite(n) && n > 0) &&
    [preview.view?.x, preview.view?.y].every(Number.isFinite) &&
    preview.image instanceof Blob && preview.image.type === 'image/webp' && preview.image.size <= 1_048_576
}
export async function readStartupPreview(): Promise<StartupPreview | undefined> {
  return localTransaction(['session', 'documents'], 'readonly', async tx => {
    const session = tx.objectStore('session')
    const id = await localRequest(session.get('current'))
    const preview = await localRequest(session.get('startup-preview')) as StartupPreview | undefined
    if (!preview || !id) return
    const record = await localRequest(tx.objectStore('documents').get(id)) as LocalStoredRecord | undefined
    return record && validStartupPreview(preview, id, record.revision) ? preview : undefined
  })
}
export async function writeStartupPreview(preview: StartupPreview) {
  if (!validStartupPreview(preview, preview.documentId, preview.revision)) return
  await localTransaction(['session', 'documents'], 'readwrite', async tx => {
    const record = await localRequest(tx.objectStore('documents').get(preview.documentId)) as LocalStoredRecord | undefined
    const id = await localRequest(tx.objectStore('session').get('current'))
    // A late encode or another tab's save must not publish obsolete pixels.
    if (id === preview.documentId && record?.revision === preview.revision)
      tx.objectStore('session').put(preview, 'startup-preview')
  })
}
