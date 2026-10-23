import { assertDocumentJson, pinDocumentCapacity } from './document-capacity'
import { consumeDocumentJsonSyntaxFailure } from './document-admission'
import { initializePicking, prepareDocumentJsonForEditing } from './kernel/picking'
import { documentPreparationBuild, documentPreparationRuntime, sameDocumentPreparationBuild, sameDocumentPreparationRuntime, type DocumentPreparationRuntime } from './document-preparation-identity'
import type { DocumentPreparationRequest, DocumentPreparationReply } from './document-preparation-worker-client'

// This worker has exactly one request and no editor, history or rendering lane.
// Its parent terminates it on completion, cancellation, error or disposal.
let accepted = false
self.onmessage = async event => {
  if (accepted) return
  accepted = true
  const request = event.data as DocumentPreparationRequest
  const identity = request?.identity
  const envelope = { protocol: 1 as const, id: request?.id, identity }
  const attempt = {}
  let rawSizeFailure = false
  let runtime: DocumentPreparationRuntime | undefined
  try {
    if (request?.protocol !== 1 || typeof request.id !== 'string' || typeof request.source !== 'string' ||
        !identity || typeof identity.documentId !== 'string' ||
        !Number.isSafeInteger(identity.version) || !Number.isSafeInteger(identity.generation) ||
        (identity.session !== null && !Number.isSafeInteger(identity.session)))
      throw new Error('文档准备请求无效')
    if (!sameDocumentPreparationBuild(documentPreparationBuild(), request.runtime?.build))
      throw new Error('文档准备构建身份不匹配')
    // Policy is pinned before either module or layout initialization. No source
    // document field, custom codec or render request can choose this capacity.
    pinDocumentCapacity(request.memoryBytes, 'trusted-document-preparation-bootstrap')
    try { assertDocumentJson(request.source) } catch (error) { rawSizeFailure = true; throw error }
    await initializePicking()
    runtime = documentPreparationRuntime()
    if (!sameDocumentPreparationRuntime(runtime, request.runtime))
      throw new Error('文档准备内核资源身份不匹配')
    let validatedJson: string | undefined
    const document = prepareDocumentJsonForEditing(request.source, json => { validatedJson = json }, attempt)
    if (validatedJson === undefined) throw new Error('文档准备缺少校验证书')
    self.postMessage({ ...envelope, runtime, document, validatedJson } satisfies DocumentPreparationReply)
  } catch (error) {
    self.postMessage({ ...envelope, runtime, error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      errorName: error instanceof Error ? error.name : 'Error',
      sourceFailure: rawSizeFailure || consumeDocumentJsonSyntaxFailure(error, attempt) } satisfies DocumentPreparationReply)
  }
}
