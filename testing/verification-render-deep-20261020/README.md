# Real Electron rendering optimization, 2026-10-20/21

**Acceptance remains incomplete.** This increment preserves verified improvements;
it does not establish Figma-level interaction, instant 3200% clarity, or physical
90/120 FPS. Text layout v2 and the previous parallel-prefix candidate remain
outside the default implementation.

The repository [development skill](../../.agents/skills/futureox-design-development/SKILL.md)
and [development contract](../../docs/DEVELOPMENT_CONTRACT_V1.md) apply.
`VITE_DESIGN_DYNAMIC_UNIFORMS` and `VITE_DESIGN_KERNEL_CACHE` remain default-off.

## Retained changes

- Fuse eligible finite image paint, normal-over-transparent and one ordered
  sample resolve. Preserve every original multiplication/addition boundary,
  zero canonicalization, alpha gate, physical coverage and coordinate field.
  Unknown uploads, atlases and unsupported cases retain the original path.
- Retain one completed horizontal filter plane, at most 64 MiB inside the
  existing 256 MiB ledger. Private batch identity, source texture identity,
  exact bit-tagged geometry/paint keys and authoritative four-sample coverage
  guard reuse. Cancellation, pressure, source changes and batch completion retire
  the entry through the existing lifetime rules.
- Preserve the first tile and actual hole/coarse/sharp priorities, then keep
  eligible same-column work together. Preparation and consumption use immutable
  original indices, with an additional tile-object identity check.
- Extend the existing exact prefix cost policy to radius 32. Keep its rational,
  exponent, channel and resource checks and exact fallback.
- Yield before submitting more obsolete GPU work; cancel only the releasing
  interaction owner's capture. Keep completed pixels until the committed exact
  canvas is ready. Already submitted document mutations still synchronize.
- Include empty canvas synchronization plans in pre-dispatch ACK admission.
  Unsent obsolete snapshots can coalesce; submitted patch chains and undo are
  preserved.
- Treat preview cancellation as recoverable and keep canvas fill cancellation
  separate from interaction cancellation. Navigation can install an inactive
  live controller without starting a competing GPU capture.
- A strictly ordinary final foreground branch can use a smaller swept output
  scope. Every ancestor/sibling ordering, material, layout, mask and derived
  property check must pass; otherwise retain the conservative path. Its smaller
  movement guard still expands for the complete old/new footprint.

## Matched local results

Visible release Electron, Apple Metal 3, 1440×960 CSS, DPR 2, fresh isolated
profiles. Fixtures are unchanged; their SHA-256 values, build sources and runtime
asset hashes are recorded in [summary.json](summary.json) and
[accepted-build-manifest.json](accepted-build-manifest.json).
The baseline production source is unchanged between `23c96df` and `40d53b6`.

| Operation | Fresh baseline | Accepted source |
|---|---:|---:|
| 117 first 3200% exact presentation | 9095 ms | 5675 ms; 5622 ms with CPU sampling |
| 117 normal pointer drag start → exact presentation | 7307 ms | 1684 ms |
| 117 after drag action → exact presentation | 6822 ms | 1409 ms |
| 117 repeat 3200% | 203 ms | 225 / 209 ms |
| FIG text anchor first 3200% | 841 ms | 451 ms |
| FIG X-property edit → exact presentation | 4034 ms | 2984 ms |

The two accepted 117 runs use identical production assets. The held run
intentionally waits before pointer-up and is not a second comparable normal-drag
measurement. Its last movement took a further **1026 ms** to reach a GPU
presentation acknowledgement: moves 23, samples 2, acknowledged sequence 23.
Thus continuous content motion is still far from 90/120 FPS.

For 117's first 3200% request, the accepted run delivered 20 tiles, with 15
horizontal-cache hits and 31,780 rows reused. Encoded pass pixel visits fell from
3,796,979,220 to 1,379,175,220. Field CPU work remained about 15 ms.
Queue-completion waits totalled 4909 / 4882 ms versus 8017 ms in the fresh
baseline; their count increased from 170 to 191. These are completion waits,
including scheduling and other GPU clients, not exclusive shader execution time.

The actual sampled first-3200% CPU stacks show about 181 ms active / 5462 ms idle
on the main renderer, and 548 ms active / 5157 ms idle on its worker. The worker
flame contains `streamIsolatedFilter`, `exactTentAxis`, image resolve/field setup,
image upload and command encoding. It does not support blaming the remaining
multi-second delay on a 15 ms field calculation.

## Correctness and validation

- Final targeted integration run: **20 Vitest files, 290 tests passed**.
  Desktop diagnostics: **18 passed**. Release build includes typechecking.
- Current production WebGPU driver: **3,537,072 raw f32 components**, across
  8 cases and 32 sample boundaries, equal between the original sequence and
  fused image resolve. Covers ordinary inputs, signed HDR, subnormals,
  zero-alpha HDR, maximum finite values, dense/axis fields and a 3484×58 strip.
- Actual GPU texture copies: **224 components equal**, including signed zero,
  subnormals, infinities and NaN payloads; 6 invalid copies rejected.
- Prefix crossover probe: 3 radii × 3 input patterns × 2 axes, warm-up and two
  ABBA cycles. Every warm/measured raw-float comparison passed. This is operator
  evidence, separate from complete-app latency.
- **24 final viewport screenshots**: 12 for 117 and 12 for FIG, all zero pixel
  differences against their fresh baseline runs.
- Held drag's actual canvas buffer versus the final exact canvas buffer:
  **3,036,960 opaque pixels, zero differences**, with 121,686 distinct colors.
  This uses `canvas.toDataURL`, excluding overlaid DOM guides/labels; ordinary
  element screenshots include those UI differences and are not used for this
  parity claim.
- Both real fixtures preserved navigation state, persisted their actual UI
  edits, and restored the complete stored document with undo.

Detailed numerical evidence is in [gpu-summary.json](gpu-summary.json).
Raw profiles, fixture pixels, host logs and isolated workspaces stay local and
are excluded from Git. Local flamecharts are under
`accepted-held-117/flamegraphs.html` and `zoom-3200-1.svg`/`.png`.
The browser file-URL policy refused opening the HTML; the static sampled SVG was
rasterized offline and inspected without executing that HTML in another browser.

## Rejected experiments and corrected validation gaps

- Parallel scan from the previous increment remains parked: bitwise GPU parity
  did not establish sufficient whole-app benefit.
- [Split prefix resolve](resolve-split-candidate.patch): GPU parity passed, but
  first 3200% remained about 8.865 seconds. Not active.
- [Shared bilinear weights](shared-weights-candidate.patch): GPU parity passed;
  an integrated cold import took about 8.98 seconds. Compilation/run-order
  effects were not sufficiently isolated to accept it. Not active.
- [Strip pool reuse](strip-pool-candidate.md): 985 planning bypasses did not
  reduce actual fence count (190 versus 189), and peak memory increased.
  Its standalone replayable patch is retained; production changes were removed.
- An early 1.49-second drag result was **invalid as interaction acceptance**:
  `PREVIEW_CANCELLED` had latched an empty preview, with moves/samples remaining
  zero. The harness now records compositor errors, movement, samples and GPU
  input acknowledgement. Cancellation recovery and owner isolation were fixed.
- An initial recovery implementation restarted idle capture after navigation
  and caused a **21.7-second high-zoom regression**. Deferring inactive live
  capture fixed that regression; those runs are excluded from accepted results.
- The first fresh FIG attempt used an old import-generated node ID and stopped
  after import. The corrected runs resolve the same observed text-layer name
  within each imported document.
- Some new CPU test fixtures initially needed active-gesture setup after idle
  warming was removed; corrected fixtures and the final combined run passed.

A 350 ms pan callback interval occurred in an intermediate run and did not
reproduce in the targeted pan profile. That is not evidence it was fixed.
The accepted held drag also had an 84 ms interval, and FIG property editing
still had a 1525 ms main-thread long task. No broad smoothness acceptance is made.
Other local applications were left running; timing samples are limited and
cannot establish cross-device performance.

## Reproduce

From the repository root, build with
`node frontend/design-desktop/scripts/build.mjs --release`. Run with fresh
output directories and the user's local fixtures:

```sh
DESIGN_CPU_PROFILE=0 DESIGN_RENDER_DIAGNOSTICS=detail DESIGN_EXTENDED=1 \
  node testing/verification-render-deep-20261020/run-electron.mjs \
  "$FIXTURE_117" "$OUTPUT_117"

DESIGN_CPU_PROFILE=0 DESIGN_PROFILE_STAGES=zoom-3200,pan-3200 \
  DESIGN_VERIFY_HELD_DRAG=1 DESIGN_RENDER_DIAGNOSTICS=detail DESIGN_EXTENDED=1 \
  node testing/verification-render-deep-20261020/run-electron.mjs \
  "$FIXTURE_117" "$OUTPUT_HELD"

DESIGN_ANCHOR_NAME='Whooops, that page i' DESIGN_CPU_PROFILE=0 \
  DESIGN_RENDER_DIAGNOSTICS=detail DESIGN_EXTENDED=1 \
  node testing/verification-render-deep-20261020/run-electron.mjs \
  "$FIXTURE_FIG" "$OUTPUT_FIG"
```

`DESIGN_DESKTOP_ROOT` selects a separately built immutable baseline desktop
directory. Never replace its assets between sampling and source-map analysis.
Run `analyze.mjs OUTPUT` and `summarize-run.mjs OUTPUT` from this directory's
scripts, retaining the matching assets and maps.

From `frontend/design-client`, run `bun scripts/check-image-resolve-fusion.ts`,
`bun scripts/check-filter-texture-copy.ts` and
`bun scripts/benchmark-prefix-crossover.ts`, each with a fresh absolute
`DESIGN_TEST_OUTPUT`. GPU tests/builds must run serially. These probes launch
sandboxed headless Chromium on Metal and verify production driver/shader
outputs; the visible Electron workload is a separate acceptance layer.
