import { CpuStage, measureCpuStage } from '../cpu-stage-diagnostics'
import { currentPreparedDocumentJson } from '../prepared-document'
import { augmentedDocumentJson, compileEditOps } from './op-sync'
import { documentPatch, shareDocument, type DocumentPatch, type EditResult } from '../document-patch'
import type { EditScope, Op } from './graph'
import type { DesignDocument } from '../model'

/** A real transport subscriber. Local commits do not build a sync frame unless
 * one is attached; the frame is checked before the kernel commit and is not
 * applied as a second document model. */
export interface SyncFrameConsumer {
  onFrame(frame: Uint8Array, revision: number): void
}

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

export function createGraphHistoryState(
  document: DesignDocument,
  graph: EditingGraph,
  options?: { syncFrames?: SyncFrameConsumer | null },
) {
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
  let syncFrames = options?.syncFrames ?? null

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
    const batch = measureCpuStage(CpuStage.historyCompile, () => compileEditOps(current, after))
    if (batch.mode === 'replace') {
      const json = measureCpuStage(CpuStage.serialize, () => augmentedDocumentJson(after, currentPreparedDocumentJson(after)))
      measureCpuStage(CpuStage.historyApply, () => graph.replaceDocument(json, scope))
      mode = 'document'; frameBytes = 0
      return
    }
    // A changed after-state without represented ops must never advance only TS.
    if (!batch.ops.length) {
      const json = measureCpuStage(CpuStage.serialize, () => augmentedDocumentJson(after, currentPreparedDocumentJson(after)))
      measureCpuStage(CpuStage.historyApply, () => graph.replaceDocument(json, scope))
      mode = 'document'; frameBytes = 0
      return
    }
    // Local authority is one typed admission. The LZ4 frame is a transport
    // artifact: encode and decode it only for an attached sync consumer, and
    // reject a bad protocol revision before the kernel commit. applyOps still
    // parses native ops, so defaults, atomic rejection and edit scope remain.
    let ops = batch.ops
    let nextFrameBytes = 0
    if (syncFrames) {
      const frame = measureCpuStage(CpuStage.historyEncode, () => graph.opsFrame(batch.ops, revision + 1, true))
      const decoded = measureCpuStage(CpuStage.historyDecode, () => graph.decodeOpsFrame(frame, true))
      if (decoded.revision !== revision + 1) throw Error('同步协议帧版本不一致')
      syncFrames.onFrame(frame, decoded.revision)
      ops = decoded.ops
      nextFrameBytes = frame.byteLength
    }
    // Rejection is an editing error, not a reason to silently commit a
    // different operation. GraphApi stages failed batches atomically.
    measureCpuStage(CpuStage.historyApply, () => graph.applyOps(ops, scope))
    mode = 'op-batch'
    frameBytes = nextFrameBytes
  }

  return {
    get document() { return current },
    get revision() { return revision },
    get mode() { return mode },
    get frameBytes() { return frameBytes },
    /** Attach or clear the only sync-frame subscriber. Passing null restores
     * the local commit path, which does not allocate a transport frame. */
    setSyncFrameConsumer(consumer: SyncFrameConsumer | null) { syncFrames = consumer },
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
