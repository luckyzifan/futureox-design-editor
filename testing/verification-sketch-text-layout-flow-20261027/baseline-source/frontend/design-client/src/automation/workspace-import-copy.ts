import { decodeNativeImportDocument } from './export'
import { decodeSketchImportCopy } from './sketch'
import { importFileInWorker } from '../import-file-worker'
import { FIG_WARNINGS_TRUNCATED } from '../import-warnings'
import { admitDocumentSync } from '../document-admission'

// Reserve enough framing space for both the external request and the trusted
// renderer response. The input is data only: no paths, resource URLs or fetches.
export const IMPORT_COPY_BYTES = 32 * 1024 * 1024 - 128 * 1024
const failure = (code: string, message: string) => Object.assign(new Error(message), { code })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function prepareWorkspaceImportCopy(params: Record<string, unknown>) {
  if (typeof params.newDocumentId !== 'string' || !uuid.test(params.newDocumentId) ||
      !['native-json', 'fd', 'sketch'].includes(String(params.format)) ||
      Object.keys(params).some(key => !['newDocumentId', 'format', 'content', 'base64'].includes(key))) throw failure('INVALID_PARAMS', 'Invalid trusted import-copy arguments')
  const text = params.format !== 'native-json' ? params.base64 : params.content
  if (typeof text !== 'string' || !text.length || new TextEncoder().encode(text).byteLength > IMPORT_COPY_BYTES ||
      (params.format !== 'native-json' ? params.content !== undefined : params.base64 !== undefined)) throw failure('INVALID_PARAMS', 'Supply bounded native-json content or FD/Sketch base64, never both')
  try {
    // Reuse append's decoder/admission, not its append/remapping operation.
    // Native IDs remain document-scoped; only the host-owned document ID changes.
    if (params.format !== 'native-json') {
      const paddingAt = text.indexOf('=')
      if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text) || (paddingAt !== -1 && !['=', '=='].includes(text.slice(paddingAt))) || btoa(atob(text)) !== text) throw Error('Invalid archive base64')
    }
    const sketch = params.format === 'sketch' ? decodeSketchImportCopy(text) : undefined
    const decoded = sketch?.document ?? decodeNativeImportDocument({ format: params.format, ...(params.format === 'fd' ? { base64: text } : { content: text }) })
    // The Sketch codec identity is format-local and is not a valid native UUID.
    // Replace it before shared admission, without remapping any node/container.
    const source = sketch ? admitDocumentSync({ ...sketch.document, id: params.newDocumentId }) : admitDocumentSync(decoded)
    const document = { ...source, id: params.newDocumentId }
    const documentJson = JSON.stringify(document)
    const prepared = { format: 'native-json', id: document.id, documentJson,
      ...(sketch ? { sourceFormat: sketch.sourceFormat, fidelity: sketch.fidelity, lossless: sketch.lossless, warnings: sketch.warnings } : {}) }
    if (new TextEncoder().encode(JSON.stringify(prepared)).byteLength > IMPORT_COPY_BYTES) throw Error('Expanded import exceeds transfer budget')
    return prepared
  } catch (error) {
    throw failure('INVALID_DOCUMENT', `Import copy could not be prepared: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** FIG decode is isolated in the existing file worker. Admission is not editing
 * preparation: no font registration, layout, epochs or active-document changes. */
export async function prepareWorkspaceFigImportCopy(params: Record<string, unknown>, signal: AbortSignal) {
  if (typeof params.newDocumentId !== 'string' || !uuid.test(params.newDocumentId) || params.format !== 'fig' ||
      Object.keys(params).some(key => !['newDocumentId', 'format', 'base64'].includes(key)) ||
      typeof params.base64 !== 'string' || !params.base64.length || new TextEncoder().encode(params.base64).byteLength > IMPORT_COPY_BYTES)
    throw failure('INVALID_PARAMS', 'Supply bounded FIG base64 only')
  const newDocumentId = params.newDocumentId, text = params.base64
  try {
    signal.throwIfAborted()
    const paddingAt = text.indexOf('=')
    if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text) || (paddingAt !== -1 && !['=', '=='].includes(text.slice(paddingAt))) || btoa(atob(text)) !== text)
      throw Error('Invalid archive base64')
    const bytes = Uint8Array.from(atob(text), character => character.charCodeAt(0))
    const report = await importFileInWorker(bytes.buffer, 'Imported FIG.fig', 'fig', signal)
    signal.throwIfAborted()
    const encoder = new TextEncoder()
    if (!Array.isArray(report.warnings) || report.warnings.length > 128 ||
        report.warnings.some(message => typeof message !== 'string' || !message.length || encoder.encode(message).byteLength > 1024) ||
        report.warnings.reduce((total, message) => total + encoder.encode(message).byteLength, 0) > 32768 ||
        (report.droppedOccurrences !== undefined && (!Number.isSafeInteger(report.droppedOccurrences) || report.droppedOccurrences <= 0)) ||
        (report.warnings.filter(message => message === FIG_WARNINGS_TRUNCATED).length !== (report.droppedOccurrences === undefined ? 0 : 1)))
      throw Error('Invalid or oversized FIG compatibility warnings')
    // FIG carries format-local identity. Only the host UUID crosses admission.
    const document = admitDocumentSync({ ...report.document, id: newDocumentId })
    const warnings = [
      { code: 'FIG_COMPATIBILITY', message: 'FIG compatibility import is not lossless or pixel-fidelity import; inspect all compatibility notices before relying on the saved copy.' },
      ...report.warnings.map(message => ({ code: 'FIG_CODEC_NOTICE', message })),
    ]
    const prepared = { format: 'native-json', id: document.id, documentJson: JSON.stringify(document),
      sourceFormat: 'fig', fidelity: 'compatibility', lossless: false, warnings,
      ...(report.droppedOccurrences === undefined ? {} : { droppedOccurrences: report.droppedOccurrences }) }
    if (encoder.encode(JSON.stringify(warnings)).byteLength > 40960 || encoder.encode(JSON.stringify(prepared)).byteLength > IMPORT_COPY_BYTES)
      throw Error('Expanded import exceeds transfer budget')
    return prepared
  } catch (error) {
    signal.throwIfAborted()
    throw failure('INVALID_DOCUMENT', `Import copy could not be prepared: ${error instanceof Error ? error.message : String(error)}`)
  }
}
