# Image-table submission and retirement trace

The 2026-10-22 candidate adds bounded numeric events, with no document IDs, image URI, pixel data or shader payload.

- `gpu-submit` records a driver queue submission: `deviceSubmitSequence`, request/device owner, frame `resourceEpoch`, cumulative frame `drawCalls` and `opaqueTentPasses`, table count and maximum width/height. The sequence is driver-local, not a sequence for independent presenter queue submissions.
- `fence` keeps its old reason codes. `deviceFencePhase=1` starts an observation; `2` ends it. Match with `deviceFenceId` and owner. `deviceFenceSubmitFirst/Last` freeze the driver submission range at start; queue completion covers all device queue work submitted when the API was called, including work outside that driver range.
- `deviceFenceOutcome=1` means the completion promise fulfilled on the nonlost device, `2` means rejection, `3` means loss. A rejected or lost completion never certifies resource retirement.
- `deviceFenceAsync=1` identifies a background completion observation, not CPU blocked time and not a blocking `finish` wait. Its `queueWaitMs` is elapsed completion observation; it is excluded from CPU-blocking `QueueWaitStats`. Consumers comparing old fence counts must filter phase 2 and distinguish async. Phase 1 has no elapsed duration.
- `deviceGpuTimingEnabled` only says timestamp-query profiling is enabled. An ordinary fence is never GPU shader duration. Actual profiling pass timestamps, when explicitly enabled and supported, remain in the existing GPU profile output.
- `deviceRetirementBatchCount` is bounded to three. `deviceRetiringScratchBytes` and `deviceRetiringSourceBytes` retain full pending table storage and unique source pins; sources are already charged by the renderer and must not be added again to the working ledger.
- `deviceFenceGeometryReason` is a bit mask: vertex growth 1, curve growth 2, conservative resident-program-arena preparation 4. It annotates an admission fence before geometry replacement; no assertion of exact arena growth is made.
- `gpu-retirement` records actual synchronous release: `deviceRetirementPhase=1` collects an asynchronously certified snapshot, `2` follows a synchronous completion, `3` is full release after abort/park/loss/explicit teardown. Table count and released bytes refer only to that release. Device-lifecycle events distinguish loss/teardown from ordinary cleanup.

Limits remain numeric and finite: sequence IDs <= 2^32-1, byte fields <= 16 GiB, batch count <= 3, table count <= 1,000,000. The existing diagnostics transport bounds/rate limits still apply. Dropped diagnostics cannot establish absence of a submission. Submission, GPU completion and physical display remain different boundaries.

See [candidate evidence](../testing/verification-resident-image-retirement-20261022/README.md).

Routine submissions, short successful fences and small retirement batches are sampled 1/32. All rejected/lost fences and completed observations >=32 ms are retained, as are >=48 MiB retirement releases. A retained slow completion may have no start event, but carries its frozen start fields. Cumulative deviceSubmitTraceSkipped, deviceFenceTraceSkipped and deviceRetirementTraceSkipped distinguish intentional producer sampling from transport suppression/drop counters. The transport can still drop events; this is bounded diagnostic evidence, not exhaustive tracing.
