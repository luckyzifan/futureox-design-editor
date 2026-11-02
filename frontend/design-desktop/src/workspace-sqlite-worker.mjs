// SQLite document codec for the Electron main process. Parsing and framing a
// saved document stays off the UI thread. This worker has no filesystem,
// network, or backend process.
import { parentPort } from 'node:worker_threads'
import { DOCUMENT_BYTE_LIMIT, DOCUMENT_TRANSFER_BYTES, assertDocumentSerialization } from './document-capacity.mjs'

parentPort.on('message', (message) => {
  try {
    if (message.op === 'encode-request') {
      const params = { ...message.params }
      if (Object.hasOwn(params, 'documentJson')) {
        const text = params.documentJson
        if (typeof text !== 'string' || Buffer.byteLength(text) > DOCUMENT_BYTE_LIMIT)
          throw Error('Document exceeds the available working-memory allowance')
        const document = JSON.parse(text)
        if (!document || typeof document !== 'object' || Array.isArray(document)) throw Error('Invalid document')
        delete params.documentJson
        params.document = document
      }
      const envelope = { id: message.requestId, method: message.method, params, scheduling: true }
      const wireBytes = assertDocumentSerialization(envelope, DOCUMENT_TRANSFER_BYTES)
      const frame = Buffer.from(JSON.stringify(envelope))
      if (frame.length > DOCUMENT_TRANSFER_BYTES) throw Error('Document exceeds the available working-memory allowance')
      parentPort.postMessage({ id: message.id, wireBytes, frame }, [frame.buffer])
      return
    }
    if (message.op === 'decode-response') {
      const bytes = Buffer.isBuffer(message.frame) ? message.frame : Buffer.from(message.frame)
      if (bytes.length > DOCUMENT_TRANSFER_BYTES) throw Error('Document exceeds the available working-memory allowance')
      const text = bytes.toString('utf8')
      const response = JSON.parse(text)
      const document = response?.result?.document
      if (document && typeof document === 'object' && !Array.isArray(document)) {
        response.result.documentJson = JSON.stringify(document)
        delete response.result.document
      }
      parentPort.postMessage({ id: message.id, response })
      return
    }
    throw Error('Unsupported SQLite worker operation')
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: String(error?.message || error).slice(0, 4096) })
  }
})
