import type { LocalSaveReply, LocalSaveRequest } from './background-local-save'
import { pinDocumentCapacity } from './document-capacity'
import { LocalConflictError, localSave } from './local-store'

self.onmessage = async ({ data }: MessageEvent<LocalSaveRequest>) => {
  try {
    pinDocumentCapacity(data.memoryBytes, 'browser-local-save')
    const result = await localSave(data.document, data.revision)
    self.postMessage({ documentId: result.document.id, revision: result.revision, updatedAt: result.updatedAt } satisfies LocalSaveReply)
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error),
      conflict: error instanceof LocalConflictError } satisfies LocalSaveReply)
  }
}
