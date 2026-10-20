import { uid, type DesignDocument } from './model'

/** File-picker adoption is a new local design, even for the same name/bytes.
 * Parsing owns the supplied graph; preserve its content and assign only a new
 * document identity. Native node IDs are document-scoped. This is NOT the MCP
 * append contract and never deduplicates by filename, source ID, or hash. */
export function createImportedCopy(document: DesignDocument): DesignDocument {
  return { ...document, id: uid() }
}
