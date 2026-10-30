# Native snapshot admission and completed-pool reclamation

This cohort adds two bounded performance changes. It does not complete all rendering architecture work or guarantee device latency, 120 FPS or visual correctness.

## Native canvas snapshot admission

Only native preparation's replaceable canvas preview mutations keep the existing ordered submission gate closed until a real successful document-synchronization acknowledgement. Cancelled snapshots still waiting before dispatch are skipped; the next live snapshot uses the existing exact document diff from the last dispatched state. Authoring, undo history and every already accepted mutation remain ordered and unchanged. Interaction, export/readback and nonnative dispatch semantics are not broadened.

Visual cancellation or pixel success is not a synchronization acknowledgement. Actual mutation failure invalidates the replica base even if the visual promise was cancelled. Pre-dispatch cancellation, admission refusal and transport failure invalidate only the matching optimistic base. Reset and the owner-scoped 30-second missing-ACK watchdog release obligations without replaying mutations or affecting a replacement worker.

A controlled 78-snapshot test cancels 76 snapshots before dispatch and sends two patches instead of 78. Real WASM final document projection, compiled packet, PNG and subsequent undo match the sequential baseline. This is a correctness/work-count result, not a measured end-to-end latency gain on the user's device. It prevents new obsolete native mutations; it does not delete an already accepted backlog.

The native submission promise chain remains unbounded for independently requested uncancelled previews. The 128 admitted-input limit does not bound queued closures or their snapshots. No queue-memory bound is claimed. A separately designed bounded admission API is still needed.

## Completed prior-frame pool resources

Resources returned to the free pool receive a release stamp on their actual texture identity only after alias ownership is exhausted. Reacquisition clears the stamp before reuse. The driver always submits commands first; it may omit only an admission completion wait when the entire exact selected batch is proven from an earlier completed frame.

Eligibility remains conservative: no required allocation, no retired upload/coordinate candidates, working bytes at or below 75% of the unchanged budget, and valid old completed stamps for every selected resource. Existing oldest-first limits, 64-resource cap and 48 MiB stopping threshold remain unchanged. Unknown/current/incomplete stamps, required allocation, pressure, other fence reasons, loss and failures retain their existing waits. Skipping never advances the completed epoch or permits forced image eviction.

A corrected four-frame replay using an archived 117 packet retained 32 admission boundaries but reduced completion waits from 32 to 7. The model retained identical 36 submissions and 9,287 encoded pass calls, with no independently tracked incomplete resource destroyed by the 25 skipped waits. Logical/modeled physical peaks were unchanged. This is a work-count and lifetime-contract result, not actual GPU wall time, pixel validation or total VRAM accounting. Geometry/presentation transients are outside that memory model.

## Remaining scope

No new GPU interleaving boundary, cache budget, quality reduction or kernel math change is introduced. Old solid/stroke experiments are excluded. Device/frame presets, multilevel page retention, native color transactions, modern layout schema, MCP/i18n work, collaboration/UI animation and full Nomi 2 remain separate. The cumulative operation-diagnostics coverage gaps remain documented.
