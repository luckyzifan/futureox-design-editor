# Independent review: Sketch color exchange patch

Review date: 2026-10-19 UTC. Scope: the dedicated interop color patch and its new `sketch_color_profiles` integration suite in `design-latest-20261019T1209`. The initial independent review made no product changes. After its finding, the parent authorized the narrow non-solid-stroke rejection and two regression tests described below; only interop.rs and sketch_color_profiles.rs were edited. No network, GPU, browser, socket, display, Sketch app, or WASM rebuild was used.

## Decision

No newly introduced regression was found for core-valid hex/color() inputs on the paths the patch actually converts. The patch is suitable to proceed to coordinated WASM rebuild and broader validation. This is **not** a conclusion that all Sketch color paths are fixed. The gradient-stroke loss found during review is now explicitly rejected. Raw foreign metadata and text import still have the limitations below, so a blanket “all Sketch color paths fixed” claim remains inaccurate.

Independent initial checks compiled against the original patch native rlib: **10 test functions passed**, with multiple parameter cases. After the authorized guard, the updated independent probes compiled against the final normal-Cargo debug rlib: **10 test functions passed** again. Separately, final-source normal offline Cargo ran **33 integration tests across six Sketch suites, all passed**, including the now-9-test color suite. The two added tests exercise 40 non-solid rejection iterations (32 gradient cases plus repeated image cases) and 12 exact solid compatibility cases. Residual-gap tests intentionally reproduce bad behavior; their passing status proves the limitation, not product acceptance. The original worker's 59 tests were reviewed as earlier evidence, not counted as rerun here.

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

### R1 — Existing defect found, now addressed: gradient/image strokes silently flattened

Location in the reviewed pre-guard source: `interop.rs:2622–2640`, `export_style_parts`; matching import limitation in `Importer::strokes` near lines 640–680.

The exporter unconditionally writes `fillType: 0` and converts only `s.paint.color`, regardless of stroke paint kind. It never visits stroke gradient stops. The independent probe constructs a document that **passes `Document::validate()`**, with a linear stroke, black fallback color, and PQ gradient stops. Export succeeds and contains an opaque solid black border with no gradient. This is pre-existing, not a regression introduced by the new helper/Result conversion. The original reproduction and its old-source hash are preserved. The authorized guard now rejects this case before ZIP creation.

Authorized implementation: an early guard rejects every non-solid stroke paint in `export_style_parts`, including shared-style and hidden strokes, with an error identifying its kind. Solid stroke serialization is unchanged. This is a bounded admission change from already-lossy success to explicit unsupported error. Native gradient border support was not implemented: import currently flattens gradients too, and the shared export helper lacks the node size needed for faithful gradient transforms.

Regression matrix and compatibility boundary:

1. Node and shared-style strokes with `linear`, `radial`, `angular`, `diamond`, and `image` reject; include bounded SDR and HDR stop cases.
2. Existing solid stroke coordinates, opacity product, visibility behavior, width/alignment/dash/cap/join stay unchanged.
3. `sketch_color_profiles`, `sketch_shared_styles`, `sketch_overrides`, `sketch_adaptable_color`, `sketch_import_admission`, and `sketch_text_attrs` were rerun through final-source normal Cargo (33 passed). The internal unit `shared_style_borders_and_shadows_round_trip` is additionally requested in this review; its result is recorded in the final verification addendum below. Inspected existing Sketch tests contain no non-solid stroke success expectation; the internal shared-style regression uses a solid border.
4. Avoid silently dropping invisible non-solid strokes as a workaround: the existing exporter serializes disabled borders, so a dropped record would hide authored data loss.

### R2 — Existing: raw native metadata bypasses typed color validation

Location: final `interop.rs:2894–2896` (initially 2885–2887), plus raw adaptable/shared container restoration near lines 348 and 3982.

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
- `initial-source-hashes.json`: initial reviewed source, dedicated pre-patch baseline/patch, old native rlib and tests, and the old shared WASM identity captured before root rebuild.
- `source-hashes.json`: final guarded product source and normal-Cargo rlib hash.
- `stroke-guard.patch` and `stroke-guard-tests.patch`: exact authorized follow-up deltas; before snapshots are also preserved.
- `independent-after.rs`, `command-after.json`, `compile-after.log`, `results-after.log`: final-Cargo-rlib rerun of independent probes, with the old gradient-loss reproduction changed to require explicit rejection.
- `final-cargo-tests.log`: final normal offline Cargo integration result. Command: source the existing `__BUILD_ROOT__/rust-env.sh`, run from `__WORKSPACE_ROOT__`, then `cargo test --manifest-path __DESIGN_REPO__/design-studio/Cargo.toml -p futureox-design-kernel --test sketch_color_profiles --test sketch_shared_styles --test sketch_overrides --test sketch_adaptable_color --test sketch_import_admission --test sketch_text_attrs --locked --offline`.
- `artifact-hashes.json`: report/probe/log/tool-command hashes.
- The reviewed interop/test hashes matched `color-space/source-manifest.json` exactly before probing.
- Scoped `git diff --check` for interop.rs and sketch_color_profiles.rs passed. Whole-repository `git diff --check` found an unrelated new blank line at EOF in `frontend/design-client/src/svg-presentation.ts:50`; it was not changed by this review.

This review did not rebuild or use shared WASM. The parent began a separately coordinated rebuild while the guard was being added, explicitly treating that first build as provisional; final runtime hash/acceptance belongs to the parent's freeze. These native results are not GPU or physical-display acceptance.

## Final verification addendum

The normal offline Cargo internal unit `interop::tests::shared_style_borders_and_shadows_round_trip` passed: 1 passed, 0 failed, 459 filtered out; see `final-cargo-unit.log`. Together with six integration suites this review ran **34 final-source Cargo tests, all passed**, plus the **10 final-rlib independent probes, all passed**. Final scoped diff-check passed. Product source remains frozen at interop SHA256 `cf961d82c1f11ecdacc8c79b7d9f124a25c778564afc010b5c667ad97adf9e7d` and color-profile-test SHA256 `621c10b581aec1949eebb00f9aa94baaf2195d6c5369fd6d8169217e2ace9f51`. No further product changes are required by this review.
