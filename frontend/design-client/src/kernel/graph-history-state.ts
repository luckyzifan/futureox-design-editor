import { augmentedDocumentJson, compileEditOps } from './op-sync'
import { documentPatch, shareDocument, type DocumentPatch, type EditResult } from '../document-patch'
import type { EditScope, Op } from './graph'
import type { DesignDocument } from '../model'

/** CPU-only history contract; production supplies the real initialized Graph. */
export interface EditingGraph {
  free(): void
  replaceDocument(json: string, scope?: EditScope): number
  undo(): boolean
  redo(): boolean
  undoDepth(): number
  redoDepth(): number
  opsFrame(ops: Op[], revision: number, lz4: boolean): Uint8Array
  decodeOpsFrame(frame: Uint8Array, lz4: boolean): { revision: number; ops: Op[] }
  applyOps(ops: Op[], scope?: EditScope): void
}

export function createGraphHistoryState(document: DesignDocument, graph: EditingGraph) {
  let current: DesignDocument = document
  // The Editor and this timeline share immutable authored records. These are
  // bounded references, not cloned or JSON-normalized second documents. Rust
  // owns a disposable projection and the atomic, bounded op timeline.
  const undoSnaps: DesignDocument[] = []
  const redoSnaps: DesignDocument[] = []
  let revision = 0
  let mode: 'op-batch' | 'document' = 'document'
  let frameBytes = 0
  let disposed = false

  const assertLive = () => {
    if (disposed) throw Error('编辑历史已释放')
  }
  const result = (patch: DocumentPatch = { nodes: {}, fields: {} }): EditResult => ({
    document: current,
    revision,
    patch,
    changedIds: Object.keys(patch.nodes),
    undoDepth: graph.undoDepth(),
    redoDepth: graph.redoDepth(),
  })
  const free = () => {
    if (disposed) return
    graph.free()
    disposed = true
    undoSnaps.length = 0
    redoSnaps.length = 0
  }

  /** Exactly one successful kernel commit per edit. GraphApi stages op
   * failures atomically and replaceDocument shares the same undo timeline.
   * The edit scope declares the batch's provenance (default: user). */
  const commitOps = (after: DesignDocument, scope: EditScope): void => {
    const batch = compileEditOps(current, after)
    if (batch.mode === 'replace') {
      graph.replaceDocument(augmentedDocumentJson(after), scope)
      mode = 'document'; frameBytes = 0
      return
    }
    // A changed after-state without represented ops must never advance only TS.
    if (!batch.ops.length) {
      graph.replaceDocument(augmentedDocumentJson(after), scope)
      mode = 'document'; frameBytes = 0
      return
    }
    const frame = graph.opsFrame(batch.ops, revision + 1, true)
    const decoded = graph.decodeOpsFrame(frame, true)
    // Insert ops pass through Rust's typed Node serializer, which expands
    // defaults. Compare the protocol revision; authored field shapes remain
    // owned by the snapshots below, not by that normalized projection.
    if (decoded.revision !== revision + 1) throw Error('同步协议帧版本不一致')
    // Rejection is an editing error, not a reason to silently commit a
    // different operation. GraphApi stages failed batches atomically.
    graph.applyOps(decoded.ops, scope)
    mode = 'op-batch'; frameBytes = frame.byteLength
  }

  return {
    get document() { return current },
    get revision() { return revision },
    get mode() { return mode },
    get frameBytes() { return frameBytes },
    free,
    [Symbol.dispose]: free,
    /** Typed local commit. JSON belongs only at the WASM/transport boundary.
     * The caller must publish result.document only after this returns.
     * The optional edit scope declares provenance (default: user);
     * ignoreUndoRedo commits skip the undo timeline on both sides. */
    apply(expectedRevision: number, candidate: DesignDocument, scope: EditScope = { source: 'user' }): EditResult {
      assertLive()
      if (expectedRevision !== revision) throw Error('编辑历史版本冲突')
      if (candidate.id !== current.id) throw Error('编辑操作不能改变文件标识')
      const after = shareDocument(current, candidate)
      if (after === current) return result()
      const changed = documentPatch(current, after)
      commitOps(after, scope)
      if (!scope.ignoreUndoRedo) {
        undoSnaps.push(current)
        if (undoSnaps.length > graph.undoDepth()) undoSnaps.splice(0, undoSnaps.length - graph.undoDepth())
      }
      redoSnaps.length = 0
      current = after
      revision++
      return result(changed)
    },
    undo(): EditResult {
      assertLive()
      if (graph.undoDepth() !== undoSnaps.length) throw Error('编辑历史与内核撤销记录不一致')
      const previous = undoSnaps.at(-1)
      if (!previous) return result()
      const patch = documentPatch(current, previous)
      if (!graph.undo()) throw Error('内核未完成撤销')
      undoSnaps.pop()
      redoSnaps.push(current)
      current = previous
      revision++
      return result(patch)
    },
    redo(): EditResult {
      assertLive()
      if (graph.redoDepth() !== redoSnaps.length) throw Error('编辑历史与内核重做记录不一致')
      const next = redoSnaps.at(-1)
      if (!next) return result()
      const patch = documentPatch(current, next)
      if (!graph.redo()) throw Error('内核未完成重做')
      redoSnaps.pop()
      undoSnaps.push(current)
      current = next
      revision++
      return result(patch)
    },
  }
}
