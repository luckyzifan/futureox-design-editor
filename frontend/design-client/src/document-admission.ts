import { validateDocument, type DesignDocument } from './model'
import { initializeKernelModule, validateKernelDocument } from './kernel/module'

function captureDocument(value: unknown) {
  validateDocument(value)
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > 32 * 1024 * 1024)
    throw new Error('设计文件超过 32 MB')
  // Use the exact serialized snapshot validated by Rust, never a caller-owned
  // object which can change while module initialization or storage is awaited.
  const document = validateDocument(JSON.parse(json))
  return { json, document }
}

export async function admitDocument(value: unknown): Promise<DesignDocument> {
  const snapshot = captureDocument(value)
  await initializeKernelModule()
  validateKernelDocument(snapshot.json)
  return snapshot.document
}

/** Editing adoption remains synchronous and fails explicitly before module readiness. */
export function admitDocumentSync(value: unknown): DesignDocument {
  const snapshot = captureDocument(value)
  validateKernelDocument(snapshot.json)
  return snapshot.document
}
