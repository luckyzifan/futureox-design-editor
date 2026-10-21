# Exact rendering and low-latency investigation, 2026-10-21

Acceptance remains incomplete. The confirmed improvement in first-3200% rendering does not establish instant clarity, low-latency continuous dragging, Figma parity, or physical 90/120 FPS. Use [summary.json](summary.json) for the final matched measurements and source/build identities. The [development skill](../../.agents/skills/futureox-design-development/SKILL.md) and [development contract](../../docs/DEVELOPMENT_CONTRACT_V1.md) apply.

## Implementation

- Build immutable exact horizontal image interpolation tables from actual finite uploaded pixels and all four native axis programs. Store three signed-96 words per channel; omit alpha storage only for an actual all-one alpha upload. Preserve the original bilinear RNE, alpha gate, per-sample quarter and ordered adds. Unknown layouts, borders, wide exponents, atlases and insufficient memory retain the original sampler.
- Bind private witnesses to the real upload. Snapshot mutable plan arrays before asynchronous pipeline compilation; keep the source pinned through preparation, active sampling and real completion. Charge table buffers, axes and bounded prefix scratch to the existing 256 MiB working ledger, with room reserved for following strips. Abort and retirement still wait for actual GPU completion.
- For fully supported opaque tent filters, calculate RGB and retain exact alpha one. Use three scan/solve pairs and one RGB resolve per band. Mixed masks, clipped support and ordinary RGBA keep the channel path. Align eligible strips to the actual RGB band size.
- Apply the proven linear-coefficient factorization and use 64-bit additions only in scans whose complete-row bound fits signed 63 bits. Keep storage, moments, solve and final rounding at their existing widths. Weighted admission uses complete window support while whole-line unweighted arithmetic retains its original guards.
- For small eligible image blurs, resolve the whole source once and use the original exact H/V dispatcher directly. Omit the original strip blits only with an actual nonnegative resolved-RGBA proof; signed inputs retain the blits and their zero canonicalization.
- Accumulate small reclaimable pools before maintenance waits when there is no real allocation or image pressure. The allocation limit, forced pressure fence and source pins remain enforced. Reuse finite validation from the successful image-upload proof instead of scanning the same upload a second time.
- Reuse immutable decoded pixels between canvas and interaction only after their complete authored source is proven identical. Keep the full working-color settings and source URI/ICC/orientation bytes in cache identity, plus all asynchronous owner fences; preserve the existing 64 MiB cache budget. See [the decoded-image record](decoded-image-lane-residency.md).

The accepted table, larger bounded table, factor, RGB resolve, narrow scan and eligible whole-image paths default on; explicit `0` selects their fallback. The experimental `VITE_DESIGN_PREFIX_TIGHT_BOUND` remains strict opt-in, and its BigInt parser is skipped by default. `VITE_DESIGN_DYNAMIC_UNIFORMS` and `VITE_DESIGN_KERNEL_CACHE` remain default-off. The unhelpful complete-filter cache was removed from production.

## Confirmed checkpoint

| Operation | d2 baseline | Default build, repeated matched runs |
| --- | ---: | ---: |
| 117 first 3200% exact presentation | 5637 ms | 3602 / 3610 ms |
| Its queue-completion waits | 4963 ms | 2760 / 2849 ms |
| Latest held-drag input to acknowledged preview | 1175 ms | 466 / 545 ms |

The final default build passes **25 exact RGBA comparisons** (12 stages per
fixture plus the held-versus-settled buffer), **4,300,416 independent raw-f32
GPU component comparisons**, and complete stored-document undo for both real
fixtures. Its full working ledger remains under 256 MiB. These improvements
are substantial but still fail the very-low-latency/continuous-motion target.
The image range scan's independent CPU improvement is documented
[separately](../verification-render-deep-20261020/image-range-scan/README.md);
the later run does not establish a further whole-editor speedup from it alone.

FIG first-3200% was 510 / 473 ms, property edit 3502 / 3214 ms, and import
8452 / 9101 ms (baseline / final). The import variation is a regression in this
single pair; no FIG loading improvement is claimed. Property editing still
contains a roughly 1.66-second main-thread gap. Overall smoothness acceptance
remains open.

FIG exposed an additional persistence failure: visible undo restored the
original pixels, but a busy automatic save could leave the edited value on
disk. [The fix](fig-undo-autosave-busy.md) retries only an explicitly busy
snapshot with its exact original mutation identity and expected revision,
retains all pending-input guards and stops automatic retry on unknown outcomes.
The old FIG reference stays recorded as failed. The explicit
`--known-baseline-undo-save-failure` comparison option accepts only its complete,
error-free rendering stages and the diagnosed transform-only storage failure;
the candidate must still pass full persisted undo. The final FIG run does.

## Matched device verification

Release Electron, Metal-3, CSS 1440×960, DPR 2; actual compositor buffer 1710×1776. Each run uses a fresh isolated workspace and the unchanged user fixture. Performance runs are serial. Other ordinary user applications remain running. Original fixture bytes and user workspaces are not edited by the harness.

The final harness uses a passive visible nonfocusable window at opacity 0.01, ignores physical mouse input, disables macOS occlusion/background throttling and checks that native rAF is active. This prevents accidental OS input from changing the scripted sequence. Captures read the real compositor PNG buffer, not a blank/transparent DOM. The same mode is used on both sides; the d2 held buffer also equals the earlier visible-window d2 buffer exactly. It is not input-to-photon or physical smoothness acceptance. UI rAF intervals are callbacks, not rendered content FPS.

All viewport stages must settle with complete native detail and no fallback. Real Control-wheel, selection, authored drag/property change, persistence and complete-document undo are checked. Held dragging additionally requires a live interaction, nonzero GPU samples, acknowledgement of the latest moved sequence, and equality with the settled actual compositor buffer. Timing intentionally includes diagnostics; extended phases retain CPU sampling on both sides. The held stage includes the hold and PNG readback; use its separate latest-input-to-acknowledged-preview time for comparison.

Queue waits include OS scheduling and other GPU clients; they are not exclusive shader time. GPU raw-float oracles use the independent original scalar shader or original image paint/normal-over/ordered-resolve sequence. Operator parity is separate from integrated latency. [gpu-summary.json](gpu-summary.json) records cases, counts, admission boundaries and input hashes.

## Rejected or limited results

- Earlier v5: first 3200% 3557 ms, queue waits 2718 ms, held latest-input wait 899 ms; 13 pixel comparisons and complete undo passed. This used the older visible background mode and is not a matched final passive-window latency pair.
- CPU rational-bound metadata expands the accepted span from 22 to 30 at the 117 low radius and 27 to 35 at high radius. Independent GPU boundary cases passed. Its integrated v8 result was 3609 ms first 3200%, 2714 ms queue waits, 1214 ms held preview versus 5637 / 4963 / 1175 ms for passive d2. Fewer declined lines alone did not improve dragging, so the extra bound stays disabled.
- The earlier GPU-computed bound was bitwise correct but slower; the helper was replaced by immutable CPU-upload metadata. No GPU-helper latency is attributed to the CPU version.
- [Y96 arithmetic](image-y96-candidate.md) passed GPU parity but did not demonstrate an integrated gain; it remains a parked patch.
- [Complete-filter cache](complete-filter-cache-parked.md) had too few useful hits and retained working memory; production code and telemetry were removed. Its isolated recovery patch is a historical snapshot, subject to review after later context changes.
- Early v4 contained 220 unplanned wheel events; v7 lost pointer capture before completing the held workload. These are excluded from acceptance. The harness now audits all wheel deltas and lost capture.
- Hidden-window experiments produced approximately 1 Hz native callbacks even with background throttling disabled and could not support latency claims. They were aborted and excluded. Passive visible runs must pass a native-frame sanity check.
- The first passive baseline had an overly eager harness cancellation check before the first ready frame. That check was removed; the corrected baseline completes the held sequence and undo. Failed fixtures and corrected CPU reruns are recorded in local logs.

The drag flame is actual CDP sampling, with matching runtime source maps and checked WASM symbols. Its v8 worker showed about 1268 ms active and 1545 ms idle over the whole held stage, including roughly 288 ms in native color conversion `pow`, 145 ms in image-range certification and 99 ms in parameter upload. The final worker showed about 343 ms active / 1569 ms idle; image-range certification self time was about 66 ms, while the cold conversion and persistent-cache write were no longer dominant. The successful range proof also avoids the duplicate finite scan. This CPU activity does not explain all multi-second GPU completion waits. The SVG was rasterized offline and inspected; no browser file-URL restriction was bypassed.

117 selects a nested group with no image or filter of its own; the expensive blurred image is an earlier static sibling. Current exact Figma tile requests do not enter the retained four-sample translation controller, and the existing interaction planner accepts page roots only. A resolved tile includes the static background, color encoding and screen-position dithering, so shifting it would not preserve authored pixels. Removing those eligibility checks is not an accepted low-latency fix.

## Reproduction

From the repository root, after installing the existing dependencies:

```sh
node frontend/design-desktop/scripts/build.mjs --release
DESIGN_CPU_PROFILE=0 DESIGN_RENDER_DIAGNOSTICS=detail DESIGN_EXTENDED=1 \
DESIGN_VERIFY_HELD_DRAG=1 DESIGN_TEST_PASSIVE=1 DESIGN_SAVE_FIXTURE=1 \
node testing/verification-render-low-latency-20261021/run-electron.mjs \
  "$FIXTURE_117" "$OUTPUT_117"
```

For FIG use `DESIGN_ANCHOR_NAME='Whooops, that page i'` and `$FIXTURE_FIG` with a fresh output directory. The baseline uses an immutable d2 desktop snapshot via `DESIGN_DESKTOP_ROOT`; do not point the final build at a stale bundle. Each harness run captures build and actual runtime hashes. It records the exact owned test process and isolated profile; never terminate another application to clean up tests.

```sh
node testing/verification-render-low-latency-20261021/summarize-run.mjs "$OUTPUT_117"
python3 testing/verification-render-low-latency-20261021/compare-images.py "$BASELINE_117" "$OUTPUT_117"
node testing/verification-render-low-latency-20261021/analyze.mjs "$OUTPUT_117"
node testing/verification-render-low-latency-20261021/prepare-real117-gpu.mjs \
  "$OUTPUT_117/fixture-document.json" "$GPU_FIXTURE_DIR"
```

The last command uses the production WASM compiler to regenerate the actual 117 scene at the recorded camera/support. Source Sketch/FIG files, imported JSON, GPU images, complete raw logs, profiles and temporary local workspaces remain local and excluded from Git. Small numerical summaries, reproducible scripts, mathematical bounds and the final build manifest are committed.

The final held trace places its last moved sequence at about phase+238 ms,
the first complete preview sample at +414 ms and the latest sample at +781 ms.
That accounts for about 176 ms waiting for the running old pose and 367 ms
rendering the latest one. Worker queue wait was zero for those requests. The
latest request had 244 ms of actual completion waits (table 72 ms, admission
127 ms, prefix finish 44 ms); the remaining wall time is not exclusive CPU or
shader time. Reusing the unchanged static blur before opacity/blend/HQ resolve,
with exact sampling and complete halo, is the next rendering investigation.

CPU validation: 85 GPU suites / 550 tests after default enablement; 69 range,
upload and lifetime checks for the final scan; 61 decoded-residency tests;
114 session tests and one real Editor/WASM/SQLite BUSY/undo/reopen test;
61 Node renderer contracts; 18 desktop diagnostics. Counts from overlapping
runs are not added together. Project typechecking and the final release build
passed. System Node 26 rejected the existing transform-mode test loader;
rerunning the Node contracts under Node 24.19 passed all 61. The release build
emits the pre-existing native dead-code warning.
