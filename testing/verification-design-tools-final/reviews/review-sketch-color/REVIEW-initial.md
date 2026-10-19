# Independent review: Sketch color exchange patch

Review date: 2026-10-19 UTC. Scope: the dedicated interop color patch and its new `sketch_color_profiles` integration suite in `design-latest-20261019T1209`. No product files changed by this review. No network, GPU, browser, socket, display, Sketch app, or WASM rebuild was used.

## Decision

No newly introduced regression was found for core-valid hex/color() inputs on the paths the patch actually converts. The patch is suitable to proceed to coordinated WASM rebuild and broader validation. This is **not** a conclusion that all Sketch color paths are fixed. The existing gradient-stroke loss described below prevents a blanket “all HDR/out-of-gamut colors reject before archive creation” claim.

Independent checks compiled against the completed current-source native rlib: **10 test functions passed**, with multiple parameter cases. Several tests intentionally reproduce residual bad behavior; their passing status proves the limitation, not product acceptance. The original worker's 59 tests were reviewed as evidence, not counted as rerun here.

Root subsequently supplied a normal offline Cargo check; its actual `color-space/root-cargo-check.log` was inspected and reports success in 13.64 seconds. The earlier missing-axum Cargo failure was therefore not a remaining project blocker.

## Verified patch behavior

- `hex_to_rgba` preserves byte/255 f64 coordinates exactly for core-supported six-digit hex, including mixed case. It avoids the previous attempted color-parser f32 precision regression. Core's unusual `#+12345` input, accepted by its unsigned integer parser, also continues to export the same coordinates. No supported `#RGB`, `#RGBA`, or `#RRGGBBAA` contract exists in current core: `Pixel::hex` accepts only length 7.
- A source profile different from the Sketch target uses straight RGB → working linear sRGB → target profile. No premultiplication occurs inside the profile conversion. Same-profile coordinates take the direct f64 path. Independent probes verified fractional coordinates near 0 and 1 and alpha 0, 0.1, and 1 without loss; all eight sRGB cube corners export successfully to P3.
- The original suite has an independent W3C numeric sRGB-red→P3 anchor `[0.9174875573251657, 0.200286807740847, 0.138560591211114]`. Its same-space tests do not inadvertently accept f32 rounding.
- `None`, explicit sRGB, and explicit Display P3 remain archive profile codes 0, 1, and 2 respectively. `None` uses sRGB conversion semantics while preserving the legacy unmanaged tag.
- Solid fills retain intrinsic alpha in color plus paint opacity in contextSettings. Gradient stops retain their intrinsic alpha and the gradient paint retains its outer opacity. Solid borders and outer/inner shadows fold their external opacity into intrinsic alpha once. Native-named typed solid overrides do likewise. Text attributes retain intrinsic alpha in the exported color payload.
- P3 transparent gradient stops import as explicit Display P3 instead of incorrectly explicit sRGB. Existing opaque-stop quantization is unchanged; the new test/report correctly avoids claiming all import colors are lossless.
- Invalid/HDR colors propagate as errors through solid fills, gradient stops, solid borders, outer/inner shadows, text attributes, native-named typed solid overrides, shared fills/borders/shadows, and embedded foreign masters. These paths reach no final ZIP write when an error occurs. Result conversions no longer use a `filter_map` that could silently consume such errors.
- Unsupported document targets reject before layer/archive work. Genuine target gamut excursions reject, with only the documented encoded-coordinate 1e-10 boundary tolerance.

## Findings and compatibility notes

### R1 — Existing, important: gradient/image strokes bypass color admission and silently flatten

Location: `interop.rs:2622–2640`, `export_style_parts`; matching import limitation in `Importer::strokes` near lines 640–680.

The exporter unconditionally writes `fillType: 0` and converts only `s.paint.color`, regardless of stroke paint kind. It never visits stroke gradient stops. The independent probe constructs a document that **passes `Document::validate()`**, with a linear stroke, black fallback color, and PQ gradient stops. Export succeeds and contains an opaque solid black border with no gradient. This is pre-existing, not a regression introduced by the new helper/Result conversion. It still directly limits any no-silent-loss claim.

Narrow recommendation: reject non-solid stroke paints in `export_style_parts` before serialization, including shared-style strokes, and identify the unsupported kind in the error. Preserve solid stroke export exactly. Do not implement native gradient borders inside this small patch: import currently flattens them too, and the shared export helper lacks the node size needed for faithful gradient transforms.

Required follow-up regression matrix if authorized:

1. Node and shared-style strokes with `linear`, `radial`, `angular`, `diamond`, and `image` reject; include bounded SDR and HDR stop cases.
2. Existing solid stroke coordinates, opacity product, visibility behavior, width/alignment/dash/cap/join stay unchanged.
3. Re-run `sketch_color_profiles`, `sketch_shared_styles`, and the internal unit `shared_style_borders_and_shadows_round_trip` plus broader Sketch integrations. Inspected existing Sketch tests contain no non-solid stroke success expectation; the internal shared-style regression uses a solid border.
4. Avoid silently dropping invisible non-solid strokes as a workaround: the existing exporter serializes disabled borders, so a dropped record would hide authored data loss.

### R2 — Existing: raw native metadata bypasses typed color validation

Location: `interop.rs:2885–2887`, plus raw adaptable/shared container restoration at lines 348 onward and 3973 onward.

Objects carrying `_class` pass through unchanged. A raw native color override containing red=4 and green=-1 is exported unchanged; the new `Result` flow does not inspect it. Canonical component overrides not translated into native Sketch fields are preserved in userInfo and intentionally take another route. Raw adaptable colors and stored native containers can likewise overwrite converted slots. The dedicated worker report already marks raw metadata limitations. Restrict claims to converted typed paths; robust raw-color admission needs separate validation and provenance rules rather than indiscriminate conversion of foreign JSON.

### R3 — Existing: text-run alpha is lost on import/re-export

Location: `interop.rs:1127`, text-run import calls `color_hex`, which discards intrinsic alpha; export at lines 3593–3597 is now profile-aware.

A P3 run `color(display-p3 1 0 0 / 0.25)` first exports correctly with alpha=.25. Import stores run color `#ff0000`; re-export emits the run alpha=1. The independent test reproduces this. The pre-patch import code already behaved this way. Do not describe text alpha round-trips as fixed merely because first export is correct.

### C1 — Exporter-only compatibility change, not a valid-core regression

Location: `interop.rs:2445–2459`, compared with `color-space/interop-before.rs` helper near line 2435.

The old exporter accepted `123456` without `#` (also multiple leading hashes) via `trim_start_matches('#')`; it emitted correct six-digit byte coordinates. The new exporter rejects that input. Core color parsing and validation already require `#RRGGBB`, so no core-supported input contract is lost. The parent explicitly accepted this diagnosis as non-blocking. If compatibility with direct unvalidated exporter callers is desired, normalize those legacy strings deliberately and test it; do not reintroduce silent black fallback for malformed expressions.

## Evidence and reproducibility

- `independent.rs`: all independent native probes, including residual-gap reproductions.
- `run.py`, `command.json`, `compile.log`, `results.log`: exact native compilation and run. Uses the worker's completed current-source rlib with pre-existing dependency rlibs; product files are not copied or patched.
- `source-hashes.json`: reviewed source, dedicated pre-patch baseline/patch, native rlib and tests, and the old shared WASM identity captured at review time.
- `artifact-hashes.json`: report/probe/log/tool-command hashes.
- The reviewed interop/test hashes matched `color-space/source-manifest.json` exactly before probing.
- Scoped `git diff --check` for interop.rs and sketch_color_profiles.rs passed. Whole-repository `git diff --check` found an unrelated new blank line at EOF in `frontend/design-client/src/svg-presentation.ts:50`; it was not changed by this review.

The shared WASM was not rebuilt or used by this review. Native-source correctness here must not be misreported as runtime/display acceptance for that older WASM.
