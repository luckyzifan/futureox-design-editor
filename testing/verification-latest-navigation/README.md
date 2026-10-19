# Latest navigation refinement latency

Base: `71d32153e6f55b3723c99708b4c4c49ac7342e67`.
Scope: host scheduling, production state-machine/mailbox tests, and actual WASM CPU rendering. No browser, GPU, Electron, display frame-rate or input-to-photon measurement was performed.

## Shipping default: conservative quiet window

The normal React hook still constructs `NavigationZoom(view)` and therefore keeps the existing 160 ms quiet window and 160 ms preview cadence. Two stable animation frames are now observed during the quiet window instead of adding an extra frame after it. There is no UI setting, environment variable or hidden automatic activation of adaptive settling.

No tile density, pixel phase, sampling, shader, filter, font, color, arithmetic, compiler or CPU raster path was changed. Existing navigation cancellation and exact final target ownership remain in force.

The first adaptive proposal was rejected after independent review found work amplification: five zoom changes 8 ms apart, repeated every 96 ms for approximately 1.2 seconds, generated 13 previews plus 13 exact refinements instead of the original 9 previews plus 1 exact refinement. A stalled-renderer test alone did not reveal this because queued jobs could be pruned. The shipping default is conservative, and new tests complete every admitted render before the next input.

## Default evidence

- 4,096 deterministic replays of the actual production state machine, using the immutable base source as the control.
- Dense-input exact admission P95: 183.33 → 166.67 ms; mean 10.76 ms earlier. This is an approximately one-frame admission improvement, not a GPU rendering-speed claim.
- Preview job counts are unchanged in all four replay categories: dense 4,681; sparse 25,800; jittered 5,087; isolated 1,024.
- The review's five-event repeated-burst trace stays at 9 previews + 1 exact at 60, 90, 120 and 144 Hz. A 101-burst trace stays at 60 previews + 1 exact; repeated 20-event bursts stay at 29 previews + 1 exact. All these default traces preserve the complete accepted camera/work sequence of the original source.
- Actual 3,200-node WASM CPU fixture: gradients, ellipses and rounded rectangles. Final RGBA is byte-identical at 10%, 100%, 400% and 3200% zoom across six alternating before/after runs per zoom. A deliberately wrong zoom produces different output at every scale.
- Actual CPU raster workload remains 4 → 4 rasters for the representative uninterrupted burst and 10 → 10 for the repeated short-burst trace. The identical work sequences do not establish a raster-speed improvement. Wall-clock measurements are noisy: the final run's medians were 52.77 → 65.44 ms and 164.41 → 156.59 ms respectively. Raw per-run values are retained rather than selectively reporting a faster run.
- 78 targeted latest-WASM-initialized Vitest assertions and six activity-hook Node contracts pass. The normal React hook is tested to keep conservative 160 ms settling, one active RAF subscription, and cleanup on identity change, visibility, disable and unmount.

## Explicit experimental constructor option

Only `new NavigationZoom(view, { adaptiveQuiet: true })` enables the experiment. The normal application does not pass this option. Its measurements are separate under `experimentalAdmission` and the `experimental` result variant.

The experiment requires a complete eight-interval cadence window and uses three times its largest interval, bounded to 48–160 ms. If an early settle is followed by input inside the original 160 ms quiet window, it latches conservative settling until a genuine input gap of at least 160 ms. This prevents the short-resume fallback from being forgotten by subsequent dense events.

Experimental dense-input P95 remains 183.33 → 66.67 ms, and the representative uninterrupted CPU workload is 4 → 3 rasters. These numbers are not shipping-default performance. Longer repeated 20-event bursts still require 29 previews + 2 exact refinements versus the original 29 + 1. The experiment therefore has a real additional-work tradeoff and remains disabled pending hardware-backed interaction testing.

Negative-control replay restores the rejected four-interval threshold and disables the fallback. It reproduces the 13 + 13 regression, and longer traces amplify completed work further. The guarded experiment bounds premature exact refinement; the shipping default avoids it entirely in the tested repeated-burst traces.

A separate 3,200-input experimental pause/resume regression holds the original raster in flight while requests are superseded. Only the running job and newest request execute, concurrency stays one, and only the final 3200% camera commits in that harness. This tests backlog ownership, not completed-work efficiency; the fast-completion tests cover the latter separately.

## Artifacts and reproduction

`results.json` contains default and experimental results, raw raster timings, full short-resume sample sequences, and SHA-256 identities for the source, original source, runner, fixture, WASM and font. The runner also writes all 4,096 traces, the fixture, and raw exact RGBA artifacts.

From `frontend/design-client` after building the current WASM kernel:

```sh
node scripts/check-navigation-latency.mjs --output=/absolute/new/directory
node node_modules/vitest/vitest.mjs run src/kernel/navigation-zoom.test.ts src/kernel/use-navigation-zoom.test.ts src/kernel/render-work-queue.test.ts src/kernel/render-mailbox.test.ts src/kernel/tile-scheduler.test.ts src/kernel/render-kernel.test.ts src/kernel/frame-debounced-value.test.ts src/kernel/interaction-density.test.ts src/zoom-precision.test.ts
node --test src/kernel/use-zoom-activity.test.mjs
```

The output directory must not already exist. No dependency downloads, server, browser, socket, GPU or remote access are needed by the runner. Run hardware-backed Web and Electron interaction traces separately before claiming end-user frame-rate improvements.
