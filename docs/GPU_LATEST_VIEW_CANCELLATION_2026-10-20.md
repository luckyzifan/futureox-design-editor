# Latest-view graph cancellation

The worker's existing preview-generation and tile-fill validity predicates now
reach `GpuRenderer.render`. WebGPU renderers with an explicit frame-abort
contract recheck freshness before encoding, after asynchronous preparation,
at existing CPU graph-yield boundaries, during scratch-reclamation boundaries,
and immediately before finish/presentation. Ordered document updates still run
before the worker rejects obsolete preview requests.

The existing approximately 4 ms encoding yield policy remains unchanged for the
resident renderer. Cancellable nonresident renders also use these CPU task
yields. This is cooperative cancellation at graph boundaries, not a hard 4 ms
latency bound and not preemption of an individual GPU operation.

On cancellation the driver drops unsubmitted commands and waits for references
from already submitted work before frame cleanup. The last complete displayed
frame remains driver-owned. Incomplete graph caches are invalidated by the
existing failure cleanup; valid image uploads and presented textures are not
discarded. Successful renders gain no completion fence. WebGL/older drivers
without the abort contract retain completed-frame behavior. Cancellation remains
excluded from CPU fallback and device-failure handling in the worker.

No geometry, shader arithmetic, sample count, effect quality, or navigation
sampling/quiet-settlement policy is changed. No real-GPU timing or frame-rate
claim follows from these changes.

## Verification

- `vitest run src/kernel/gpu/render-cancellation.test.ts src/kernel/navigation-zoom.test.ts src/kernel/render-work-queue.test.ts`: 44 tests passed.
- `vitest run src/kernel/gpu/render-cancellation.test.ts src/kernel/gpu/renderer.test.ts`: 25 tests passed before the final two cancellation tests were added; the full five-test cancellation suite was then rerun above.
- `tsc --noEmit`: passed.
- New mocked-driver tests cover obsolete work before begin, cancellation after
  preparation, cancellation across CPU yielding, fence-before-destruction,
  retention of the previous displayed texture, no partial publication, repeated
  supersession, final exact-view settlement, and no-abort driver compatibility.
- No actual GPU, browser, GUI, or socket tests were performed for this change.

## Primary reference

[GPU for the Web Community Group: WebGPU Explainer](https://gpuweb.github.io/gpuweb/explainer/#command-encoding-and-submission)
explains separate encoding/submission. This implementation abandons commands
that have not been submitted; it does not claim to retract submitted GPU work.
