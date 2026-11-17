import type { ImportRequest } from '../import-ownership'
import { canWarmDesktopCanvas, KernelClient } from './client'

type WarmCanvas = {
  client: KernelClient
  request: ImportRequest
  documentId?: string
  retire: () => void
  unbind: () => void
}
const pending = new WeakMap<object, WarmCanvas>()

/** One idle preparation owner for a cold Home import. The import still owns
 * admission, and only its adopted document can take the warmed worker. */
export function warmFigCanvas(owner: object, request: ImportRequest) {
  if (!canWarmDesktopCanvas() || request.signal.aborted || !request.isCurrent()) return
  pending.get(owner)?.retire()
  let client: KernelClient
  try { client = new KernelClient() } catch { return }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const retire = () => {
    if (pending.get(owner) !== warm) return
    pending.delete(owner)
    unbind()
    client.dispose()
  }
  const unbind = () => {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', retire)
  }
  const warm: WarmCanvas = { client, request, retire, unbind }
  pending.set(owner, warm)
  request.signal.addEventListener('abort', retire, { once: true })
  void client.warmCanvasPreparation().catch(retire)
  return {
    bind(documentId: string) {
      if (pending.get(owner) !== warm || !request.isCurrent()) return
      warm.documentId = documentId
      // Successful adoption retires the import's old editor session as well.
      // The next owner is the exact imported document on that same editor.
      request.signal.removeEventListener('abort', retire)
    },
    finish(adopted: boolean) {
      if (pending.get(owner) !== warm) return
      if (!adopted || !request.isLatest()) retire()
      else timeout = setTimeout(retire, 1000)
    },
  }
}

export function takeWarmFigCanvas(owner: object | undefined, documentId: string) {
  if (!owner) return
  const warm = pending.get(owner)
  if (!warm || warm.documentId !== documentId || !warm.request.isLatest()) return
  pending.delete(owner)
  warm.unbind()
  return warm.client
}
