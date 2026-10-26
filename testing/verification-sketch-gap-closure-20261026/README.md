# Sketch interop gap closure — 2026-10-26

## Scope

Implements the field/layout gaps identified by comparing
`/Users/Apple/project/core/sketch-kernel-analysis` (reverse-engineering docs
02/03/04/05/06/08/11/22/25) against the current `.sketch` import/export in
`design-studio/crates/design-kernel/src/interop.rs`. All work is in the
interop codec; no rendering, storage or GPU path changed.

Baseline: working tree of `39ff10b` **including its prior uncommitted
2026-10-24/25/26 modifications** (this increment is not measured against a
clean checkout; the interop.rs diff therefore mixes prior sessions' edits
with this one).

## What changed (import side)

| Source field | Mapping | Evidence base |
|---|---|---|
| `patternFillType` 0/1/2/3 | Tile → `Paint.tile{mode:"grid",size:0}`; Fill/Stretch/Fit → `Paint.fit` cover/stretch/contain | official file-format enum (Tile=0, Fill=1, Stretch=2, Fit=3) |
| `patternTileScale ≠ 1` | binding `sketchSourcePatternScale` + lossy note (no kernel slot without bitmap extent) | 05-style.md |
| noise fills (fillType 4/5 without image, any `noiseIndex`) | binding `sketchSourceNoiseFills` + lossy note (previously silently dropped) | 05-style.md |
| `style.colorControls` enabled | binding `sketchSourceColorControls` + lossy note | 05-style.md |
| `borderOptions.startMarkerType/endMarkerType` | per the Sketch 74–93/fig2sketch enum (0=None…7=OpenArrow) → `Stroke.start_marker/end_marker`; open→filled approximations noted | fig2sketch MarkerType skeleton + official schema cross-check |
| `MSAttributedStringTextTransformAttribute` 1/2 | per-run `TextRun.text_case` Upper/Lower (rendered by text_case.rs); other payload shapes still ride the node binding | official TextTransform enum |
| `horizontalPins/verticalPins/horizontalSizing/verticalSizing/flexItem` (plain/`_`/`__` spellings) | binding `sketchModernLayout` under the original spelling + lossy note — enums are not published in the schema, so nothing is guessed into kernel constraints | 08-layout.md, 22 号 §2 (only the legacy 6-bit mask is decoded) |
| `groupLayout._class = MSImmutableInferredGroupLayout` | binding `sketchInferredGroupLayout` {axis, layoutAnchor, min/maxSize} + lossy note; static child frames preserved | official inferred-group-layout schema |
| page `horizontalRulerData/verticalRulerData` | `Page.guides` {id, axis, position} (x from horizontal ruler, y from vertical) + raw `rulerData` container for exact round-trip; >1000 guides truncate with a page-node binding note | 03-layer-tree.md |
| document.json `assets` | raw container when non-empty (previously dropped entirely) | 02-document-model.md |

Schema gates added to the importer's version derivation: guides → 11,
`Paint.tile` → 14 (both required by `scene.rs` validation).

## What changed (export side — exact round-trip splices)

- `Paint.tile`/`fit` → `patternFillType`; `patternTileScale` re-spliced from
  `sketchSourcePatternScale` by admitted-paint index; noise fills re-inserted
  at their recorded positions (`fills-N`/`borders-N`).
- Markers → borderOptions codes (mixed-per-stroke sets and markerless-homes
  like Diamond are noted, never silently reshaped).
- Per-run `text_case` → `MSAttributedStringTextTransformAttribute`;
  Title/SmallCaps variants degrade with an explicit note and fall back to the
  imported binding payload.
- `sketchModernLayout` / `sketchInferredGroupLayout` / `sketchSourceColorControls`
  return verbatim (groupLayout only when no kernel layout is authored).
- Page rulerData: raw payload preferred while guide counts match, otherwise
  rebuilt from modeled guides. `assets` container returns via the existing
  document container loop.
- **New fix surfaced by the real-corpus gate:** `node.export_settings` are now
  serialized into `exportOptions.exportFormats` (previously every export wrote
  an empty list while the importer bumped schema 8 for them — 117.sketch
  round-trips dropped 8→7).
- **Writer now enforces the reader's budgets** (`write_zip` checks per-entry
  16 MiB / document.json 40 MiB / total 64 MiB before zipping) and JSON parts
  serialize compactly like native Sketch. Before: exporting 111.sketch
  produced an 18.3 MiB page (pretty-printed) that this codec's own reader
  rejected; now 5.95 MiB and re-importable.

## Tests

New unit tests in `interop.rs` (`interop::tests`):
`pattern_fills_map_fit_and_tile_and_round_trip`,
`noise_fills_and_color_controls_round_trip_instead_of_dropping`,
`border_markers_map_both_directions_with_honest_approximations`,
`per_run_text_transform_maps_to_authored_text_case`,
`modern_layout_fields_and_inferred_groups_round_trip`,
`ruler_guides_and_assets_round_trip`, plus the env-gated real-corpus gate
`real_corpus_gap_slots_round_trip_stably` (`#[ignore]`, set
`CORPUS_SKETCH=…`; optional `CORPUS_DUMP=path` writes the export,
largest-entry sizes printed).

## Measured gates

- `cargo test -p futureox-design-kernel` — all targets green except the
  environment-dependent `document_admission::legacy_32mib_threshold…`
  (macOS has no memory-budget detector → 512 MiB fallback → 32 MiB allowance;
  passes with `CORE_DOCUMENT_MEMORY_BYTES=4294967296` and on Linux/CI).
  Unrelated to this increment (same failure exists without it; file has no
  diff vs HEAD).
- Real corpus (downloads): `117.sketch` (Sketch 93) import→export→import
  stable, schema 8↔8; `111.sketch` (Sketch 74.1) now round-trips after the
  export-size fix (was self-unreadable before it); `拓扑素材.sketch` still
  rejected at import by the unchanged 16 MiB entry admission — desktop
  handles such sources via the separate 4 GiB large-document path.
- `cargo test -p futureox-design-desktop-backend` — green with the same
  memory-budget override; one same-family env failure without it.
- `cargo check --target wasm32-unknown-unknown` — clean.
- Clippy: remaining interop.rs warnings are pre-existing patterns in
  untouched code; new code adds none.

## Not claimed

- No rendering/GUI/hardware acceptance: slots like noise fills and color
  controls are preserved-and-reported, not rendered (kernel has no
  per-layer color matrix home; `texture_noise` wiring is G9 scope).
- Modern pins/sizing semantics are preserved, not interpreted — translating
  them into kernel constraints needs the published enum semantics first.
- Per-run paragraph properties (alignment/line-height per run) remain
  first-run-only; needs a kernel text-model change.
- Old-schema migration chain (per-version `migratingFrom:`) not attempted.
