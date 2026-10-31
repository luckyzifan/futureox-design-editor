/**
 * Kernel binfmt persistence codec.
 *
 * The versioned binary document format (magic + truncated SHA-256 checksum,
 * deduplicated string table, varint tags) is the durable form for local
 * saves. Encoding is pure over the validated document JSON; decoding fails
 * explicitly on checksum or format errors instead of yielding partial files.
 */
import { forma_decode_json, forma_encode_json } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from './module'
import type { DesignDocument } from '../model'

export const BINARY_DOCUMENT_FORMAT = 2

/** Encode a validated document into kernel binfmt bytes. */
export function encodeDocumentBinary(document: DesignDocument): Uint8Array {
  if (!kernelModuleReady()) throw new Error('二进制文档内核尚未就绪')
  return forma_encode_json(JSON.stringify(document))
}

/** Preserve the authored value tree; callers admit it without model-normalizing
 * optional nulls, unknown extension fields, or floating-point values. */
export function decodeDocumentBinary(bytes: Uint8Array): unknown {
  if (!kernelModuleReady()) throw new Error('二进制文档内核尚未就绪')
  return JSON.parse(forma_decode_json(bytes))
}
