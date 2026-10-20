# Canvas operation lifecycle diagnostics, first stage

This adds lifecycle evidence, **not complete expected-versus-actual geometry or pixel validation**.

## Running and saving

From `frontend/design-desktop`, `bun run dev` already defaults `CORE_RENDER_DIAGNOSTICS=1`.
Save that terminal output as usual. For complete bounded lifecycle detail:

```sh
CORE_RENDER_DIAGNOSTICS=detail bun run dev 2>&1 | tee render-operations.log
```

The existing `[render-diag]` bridge sanitizes renderer messages again in the desktop host. The collector never sends document data to the render worker. Default mode emits up to eight immediate records per collector per second plus bounded latest/count summaries; it is not a complete operation history. Detail mode batches every 250 ms, keeps at most 512 pending terminal records, batches at most 64 rows, and reports drops. Local operation detail and pending correlation each retain at most 128 entries. Pointer previews update numeric counters only, without terminal output.

## Fields and interpretation

- `operationOwner`: anonymous numeric editor collector identity. Unique within the renderer runtime, randomized initial sequence across renderer runtimes.
- `operationSession`: editor document-generation number; `operationId`: monotonic local operation number.
- `operationPhase`: 1 intent/start, 2 finish, 3 software exact-snapshot acknowledgement, 4 pending operation retired with its session.
- `operationCategory`: 0 other/unsupported classification, 1 move, 2 resize, 3 text, 4 property, 5 undo, 6 redo.
- `operationOutcome`: 0 pending, 1 committed, 2 cancelled, 3 unchanged, 4 rejected, 5 session-ended.
- `operationPresentation`: 0 unobserved, 1 exact-snapshot software acknowledgement. Neither means independently verified pixels.
- `startRevision` / `authoredRevision`: numerical editor revision before/after commit. Cancelled, rejected and unchanged operations do not claim a new authored revision.
- `targetCount`, `previewAttempts`, `previewAccepted`: counts, not node IDs, user input, text, property values, or geometry.

Committed immutable snapshots are weakly mapped to `{operationOwner, operationSession, operationId, authoredRevision}`. KernelClient captures these at render intent time before asynchronous preparation, and logs them on its `request` event. Join its renderer `session` and `requestId` to its result/error events. This records provenance, not successful presentation. An unrelated/unobserved snapshot emits no operation correlation. No strong references to documents are retained by diagnostics.

Canvas acknowledges only a non-preview frame whose exact document object, document generation and page match current state, with no active transaction. Superseded/stale snapshots, coarse previews, old sessions, and cancelled drafts do not complete the operation. Operations not subsequently observed remain unobserved. The renderer callback is software evidence only, not GPU fence, compositor scanout, screenshot comparison, or pixel correctness.

## Coverage and gaps

Shared Editor `begin/preview/commit/cancel` covers standard node moves/resizes. `update/updateProperties` covers object patches and property callbacks. The two current text-commit labels (`编辑文字`, `编辑富文本`) classify callback-style plain/rich-text commits without recording those labels. Shared `change` defaults to `other` when intent is unsupported. Undo/redo are independent operations with their own authored revisions.

Not covered: numeric expected/committed position or size comparison, pointer-down versus local text draft start/cancel/IME lifecycle, target content validation, property callback semantics beyond category, every specialized editor/import path, visual correctness or actual display latency. Render-only derived preview snapshots may not carry committed operation provenance. This stage diagnoses lifecycle loss/stale completion and supplies correlation for further geometry-specific probes; it does not fix or prove every editing defect.

## Validation

Candidate adds tests for cancelled drag, committed resize, stale epoch/snapshot and coarse-preview rejection, exact snapshot acknowledgement, undo/redo, plain/rich text and property redaction, unchanged/rejected edits, session replacement, bounded rings, default aggregation, detail batch host re-sanitization, two-editor/reload correlation, and real KernelClient request/result correlation using a stub worker. Broader Editor history, mounted Canvas batching and mounted TextEditor suites run against candidate hooks. No live Electron/GPU performance or pixel correctness claim is made.
