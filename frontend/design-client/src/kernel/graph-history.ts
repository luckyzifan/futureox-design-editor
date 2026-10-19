/** Production history uses the initialized Rust graph. Fine-grained node ops
 * and full metadata/import replacements share its bounded undo timeline. */
import { Graph } from './graph'
import { augmentedDocumentJson } from './op-sync'
import { createGraphHistoryState } from './graph-history-state'
import type { DesignDocument } from '../model'

/** Initialization failures propagate; no silent alternate history engine. */
export const createEditingHistory = createGraphHistory

export function createGraphHistory(document: DesignDocument) {
  return createGraphHistoryState(document, Graph.open(augmentedDocumentJson(document)))
}

export type GraphHistory = ReturnType<typeof createGraphHistory>
