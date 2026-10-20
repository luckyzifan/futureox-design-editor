# Bounded render preparation cancellation

## Findings

The uploaded log measures long promise elapsed time, not CPU-only time. Request 205 reported compile 4608.5 ms and execution 5084.1 ms; request 208 waited 3368.3 ms then executed 1298.5 ms. The existing log lacks enough request purpose/channel/generation fields to classify these requests exactly. This patch addresses a verified source mechanism rather than claiming these measurements uniquely prove a CPU bottleneck.

RenderWorkQueue owns the complete async render request. Previously a cancellation incremented a generation, but could not retire a pending compile await, and stale queued camera-only requests initialized/switched lane and performed deferred synchronization before checking generation. The document envelope fence cannot simply be moved: subsequent requests may patch that revision.

Both physical preparation executors are serial: frontend/design-client/src/kernel/preparation-worker.ts lines 31–36 chains jobs; frontend/design-desktop/src/preparation-worker.mjs lines 8,15–18 retains one active job and lines 23–30 clear it only on reply. Native JSON serialization bypasses this CPU preparation queue and is unaffected.

## Change

- PreparationChannel retains at most one physical request in flight. Later jobs remain locally ordered. Only explicitly cancellable compile_gpu_packet jobs may be withdrawn.
- Cancelling a running packet immediately rejects its render consumer but preserves the physical transport fence until the real reply. Late results contain CPU bytes, never GPU handles; they are discarded without cache admission.
- A later obsolete queued packet is removed before reaching WASM/native, preventing cancellation from merely relocating backlog to the preparation worker.
- RenderKernel forwards an optional signal only for packet compilation. Delta sessions, load/patch, export, readback and other mutations are not cancellable through this mechanism.
- Render worker scopes signals to transient preview packet waits, and checks stale camera-only requests before lane initialization. Requests carrying document/patch envelopes still synchronize in order.
- No GPU promise, active encoder or submitted resource lifetime is abandoned. Existing tile PrepareAhead drains now settle promptly when their packet is cancelled.

## Verification

- Original source: all three new transport/real-render-worker cancellation regressions fail (held compile is not retired before reply).
- Fixed: 65/65 tests across preparation channel/worker, render kernel/queue, real render worker hydration, PrepareAhead and scene hydration pass.
- TypeScript typecheck passes.
- Synthetic serial compiler: each task costs 20 ms; burst contains 16 obsolete packets and one latest packet. Original dispatches 17 jobs and latest completes in 345.03 ms; fixed dispatches 2 and latest completes in 41.29 ms. This is a synthetic scheduling measurement, not a claim about the user's device/frame rate.
- Two existing adversarial RenderKernel cache-race tests intentionally deliver replies out of order. Their assertions remain unchanged; they now use an explicit unordered test transport so the kernel's defensive revision handling is still tested independently of the newly bounded production channel.

## Limits

An already executing synchronous compile is not preempted. Latest CPU preparation still waits for that one job, plus any mandatory ordered document mutations. Compile-delta sessions are intentionally not abandoned because their decoder/session state is mutable. Further real-device diagnostics are needed to distinguish those from packet compilation, image hydration and GPU work in the user's largest stalls.

