# Electron screen tier and nested drag — 2026-10-21

Motion clarity is still **not accepted**. See [the continuous-zoom record](MOTION-CLARITY.md): removing deliberate low-density previews alone did not prevent old tiles from being enlarged. A whole-viewport candidate failed memory admission and has been parked. No claim of blur-free zooming or Figma-level motion is made.

This increment separates screen quality from export supersampling. It does not
change the authored document profile, layout, shaping, input geometry, editor
mutations, persistence or history. Four correlated coverage samples and full
managed effects remain enabled. The established exact arithmetic/prefix filter
is retained in the accepted screen-density candidate.

## Implementation and gates

- `desktopDisplay` is a pinned host policy independent of `desktopFullMath`.
  Ordinary managed SDR canvas/preview can use `figmaSubpixel` at physical screen
  density. Exact/reference readback, HDR, pixel preview, software profiles and
  exports retain their requested profile. This is a visual screen-quality
  choice, not a claim of pixel equality with export supersampling.
- The first live capture forwards newer transform-only input to its resident
  worker session. It checks owner/generation, camera revision, the completed
  capture document and that pending snapshot's own input sequence. Content or
  camera changes use normal capture/rebase.
- A narrow neutral ancestor can retain its complete static prefix as four
  immutable planes. Admission checks every static compiled descendant, absent
  compiler-culling sentinels, source identity, lease, quality and target extent.
  Initial construction disables the per-pose scissor for the whole prefix;
  restores always copy before in-place blends. One slot is capped at 64 MiB and
  remains in the existing working ledger. In the actual 117 capture it uses
  39,324,736 bytes. Unsupported/over-budget cases keep the ordinary graph.
- Native pose windows retain the initial capture origin. The previous code
  measured from the last recompiled moving node, so a repeated absolute pose
  on pointer release could shrink the window and crop the moved object. This
  bug became reachable when cold capture input began using the resident path.
- The independent native finite-image sampler is a separate candidate. It
  keeps actual-upload resource/shape/range proofs, exact fallback, same-device
  pipelines and exact readback/export exclusion. Its flag is not a declaration
  that it improves whole-editor latency.

Accepted default changes are desktop screen density, pending transform handoff,
neutral nested prefix reuse and the initial pose-origin fix. The separate
`VITE_DESIGN_SHARP_ZOOM`, `VITE_DESIGN_NESTED_IDLE_WARM`,
`VITE_DESIGN_DESKTOP_IMAGE_SOURCE`, `VITE_DESIGN_DESKTOP_NATIVE_MATH`,
`VITE_DESIGN_BOUNDED_DISPLAY_FILTER` and `VITE_DESIGN_DISPLAY_MATERIAL_SOURCE`
remain strict opt-ins (`1`). A candidate flag is not acceptance. In particular,
the native source-material blur changes the screen filter lattice and failed
the whole-motion gate; its exact PNG exports do not discharge that failure.
The bounded-f32 filter also lacks a valid full-domain signed-HDR error bound;
74 GPU oracle cases are prepared but unrun, and the candidate stays off.

`VITE_DESIGN_DYNAMIC_UNIFORMS` and `VITE_DESIGN_KERNEL_CACHE` remain default-off.
The earlier source-window/static-blur candidates are not enabled by this work.

## Actual runs so far

All editor runs use release Electron 44.7.0, Apple Metal-3, CSS 1440x960, DPR 2,
real pointer/keyboard UI input, sandbox retained and isolated local storage.
The passive visible test window uses opacity 0.01 to avoid taking the user's
physical input; the actual GPU compositor buffer is captured. UI rAF intervals
are not displayed content FPS or input-to-photon measurements. Extended phases
retain CPU sampling; the seven main stages are unsampled. Heavy tests are serial.

| Candidate | First 3200% ready | Queue completion waits | Held latest input to preview ACK |
| --- | ---: | ---: | ---: |
| Fresh bf3 baseline | 3692.56 ms | 2923.80 ms | 639.02 ms |
| Screen density only | 1405.90 ms | 952.90 ms | 325.13 ms |
| Density + prefix, before pending-pose handoff | see raw run | see raw run | 323.84 ms |
| Pending-pose handoff, before origin fix | 1334.30 ms | see raw run | 110.57 ms; **failed acceptance** |
| Origin fix, image sampler off | 1363.77 ms | see raw run | 166.08 ms |
| Native image candidate | 1482.31 ms | 824.20 ms | 114.27 ms |

These single runs are observations, not distribution estimates. The native
candidate reduced waits but did not improve complete first-zoom time over the
screen-density path, so it must not be enabled merely from its operation count.

The origin-fixed run's held/settled buffers are byte-identical, and both equal
the density-only run. It passed persisted edit and complete-document undo.
Screen density itself changes edge sampling relative to the old supersampled
screen. Both full physical-size screenshots and numerical differences are
reviewed; this is not described as zero-difference baseline rendering.

## Preserved failures and limits

- The first bf3 frontend snapshot missed ignored generated bindings/assets;
  copying the unchanged generated artifacts fixed its build. Its native release
  artifacts were reused only with unchanged Rust sources. Runtime asset hashes
  are captured. Subsequent origin/native builds used the full guarded release
  build, including source-input identity checks.
- Pending-pose v2 cropped part of the moved foreground on release. Its held
  image was correct; settled output differed in 9,192 pixels, max channel 52.
  The fixed initial-origin version restores exact same-tier equality.
- The v2 persistence probe got `workspace.open status:error`; its old harness
  omitted the error code, so the cause remains unclassified. Later checks log
  status/code/message and retry only read-only BUSY/WORKSPACE_BUSY requests with
  the same document id, bounded by five seconds. Exact edit/undo assertions are
  unchanged. The origin-fixed run had no read retry failures.
- Origin v3 generated all three export previews and passed edit/undo, but its
  first export-byte probe used `fetch(blob:)`, rejected by Electron CSP. That
  run is failed, not an export pass. The corrected harness clicks the actual
  download link through the product's existing origin/type/size validation;
  the owned test process supplies the save location, then Node reads the saved
  file. CSP and product download validation remain unchanged. The native Save
  dialog itself is not operated manually.
- New CPU harness checks initially had literal-replacement/name errors; those
  test-executor errors were corrected. A new pending-pose positive test initially
  omitted its opt-in flag; it passed after explicit test configuration. Neither
  failure was counted as GPU evidence.

## Reproduction

From the repository root, build the release with the candidate flags recorded
in `summary.json`/the build manifest, then use fresh output directories:

```sh
node frontend/design-desktop/scripts/build.mjs --release
DESIGN_CPU_PROFILE=0 DESIGN_RENDER_DIAGNOSTICS=detail DESIGN_EXTENDED=1 \
DESIGN_VERIFY_HELD_DRAG=1 DESIGN_VERIFY_EXPORT=1 DESIGN_TEST_PASSIVE=1 \
node testing/verification-electron-display-tier-20261021/run-electron-display.mjs \
  "$FIXTURE_117" "$OUTPUT_117"
```

For FIG also set `DESIGN_ANCHOR_NAME='Whooops, that page i'`. Each run records
source/build/runtime identity and its exact owned process/profile. Only that
owned process is cleaned up. Original fixtures, raw logs, PNGs, CPU profiles and
SQLite workspaces remain local and excluded from Git.

`compare-visual.py BASELINE CANDIDATE --require-exports` records fixed screen
metrics and requires the three actual PNG exports to match byte-for-byte.
`--require-exact-canvas` additionally enforces same-tier canvas identity. The
report-only visual metrics are not an automatically relaxed quality threshold.

Actual GPU sampler oracle, from `frontend/design-client`:

```sh
DESIGN_TEST_OUTPUT="$GPU_OUTPUT" VITE_DESIGN_EXACT_IMAGE_X_TABLE=1 \
bun scripts/check-display-image-source.ts
```

It uses the original paint/over-zero/ordered-four-sample implementation as the
independent reference. The first actual Metal run passed 44 phase comparisons,
10,138,624 components, including rejected domains with raw equality. Actual 117
three-window source errors were at most 1.1920928955078125e-7; alpha was unchanged,
and measured SDR conversion differed by at most one byte. This is a numeric
screen-candidate check, not an export, visual or performance acceptance result.

## Final default checkpoint

The final guarded release build has no experimental launch flags set. Both
`final-audited-117` and `final-audited-fig` use the same actual runtime assets.
[summary.json](summary.json) records source/build/artifact hashes and the exact
scope. Latest single-run observations:

| Fixture | First 3200% ready | Queue-completion waits | Latest held input to preview submission ACK |
| --- | ---: | ---: | ---: |
| 117 | 1469.56 ms | 891.80 ms / 64 fences | 74.83 ms |
| FIG | 445.33 ms | 26.50 ms / 6 fences | not measured |

The preceding default 117 observation was 1279.20 ms / 133.86 ms. These are
individual observations across the documented audit changes, not a latency
distribution or a claim that every drag reaches the latest observed 74.83 ms.
Final 117 passes 14 exact same-tier RGBA comparisons, including held/settled,
and all three original PNG bytes match. Both fixtures pass actual authored
edit, complete stored-document undo and preserved source-file bytes. FIG's
three PNGs also match after an independent read-only structural target proof:
FIG imports regenerate opaque IDs, and the unmodified strict UUID comparator
correctly refused to compare them. See [FIG-EXPORT.md](FIG-EXPORT.md) and the
read-only proof script; no whole-document cross-import equality is claimed.

The audit also disables the sharp candidate's activity timer when that
candidate is off, and invalidates retained interaction roots when display
arithmetic policy changes before an exact readback. The existing retirement
boundary is retained. Six material-lifetime counterexamples plus the new
root-domain counterexample use deferred CPU transport, not shader-math mocks
presented as GPU acceptance.

Final CPU validation: 16 targeted Vitest suites / 236 tests, 43 Node policy and
diagnostic tests, project typecheck and the full guarded release build passed.
Initial fixture-URI, initial-zoom and texture-identity test-double errors, plus
an outdated diagnostic source-format assertion, are preserved in local logs;
assertions were corrected and rerun. The 74-case bounded-filter GPU oracle is
prepared but unrun. Historical image-source GPU evidence is separately scoped
in [gpu-summary.json](gpu-summary.json); it predates later driver edits and
does not accept the final experimental candidate.

**Continuous-motion blur remains unresolved.** The default changes reduce
settled rendering/drag costs; failed sharp/material/whole-viewport candidates
are not promoted into the default product. FIG property editing still takes
about 3.26 seconds and contains a roughly 1.6-second main-thread gap. Nothing
in this checkpoint establishes Figma parity or physical 90/120 FPS.
