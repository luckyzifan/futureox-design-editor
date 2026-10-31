# Work log

- Baseline frozen; no source changes yet in this increment.
- Implementation groups: A resize; B ICC/rows; C Grid query/cache; D shared geometry/cold fields/capacity; E packet and GPU preparation.
- Larger source-provider and display-quality research requires preserving existing authoritative paths; only validated candidates will be selected.

## In progress

- A: positive finite bit-identical resize skips geometry mutation; zero/signed-zero paths retain old behavior. Added shared-geometry regression.
- B: WorkingTransform prepares ICC once per row decoder and retains row scratch. Single native PNG decoder spans dimensions/upload with explicit dispose and unused-source expiry; renderer releases on all exits. Ten lifecycle tests passed (mock boundary only).
- C: Grid track scratch contains only frame/direct children after original admission; Canvas memo is tied to published scene (including font epoch), document and selected frame.
- D: Node Network is Arc-backed with COW writes; large optional payloads boxed transparently; paint/stroke/effect capacity tightened at immutable adoption/read. Image cache keys are Arc strings so decoder forks do not duplicate long URI keys. JSON field order retained. Kernel/type consumers adapted; full lib tests running.
- E: GPU worker gets a materialized CPU scene plus exact segmented witness. Coalesced scene consumers copy geometry only; transferable packet API unchanged. Late/cancelled preparation certificates preserved. Filter preparation prefers RGBA and builds RGB channel fallbacks only on opt-out/failure; alpha/scalar reducers remain separate.
- Still to validate: full native/integration suites, rebuilt portable WASM, frontend scene/row/Grid regression, GPU pipeline failures and real pixels, native memory/store parity. No latency or full G2/G5 claim yet.

- Full native test compilation now passes after adapting Arc/Box test callers. Targeted row lifecycle and real filter dispatch tests: 23 passed (mock attachment writes; no shader arithmetic claim).
- Expanded native suite found `stroke_markers::native_export_presets_validate_roundtrip_and_cannot_be_dropped_by_old_schema` rejecting an already-allowed scale=0. The exact frozen test linked against the prechange release rlib also fails at the same line; see baseline-export-test*.log. No export admission math changed. The prior FIG inverse-gradient assertion is separately recorded in kernel-tests.log and older verification evidence; skipped explicitly in the expanded run.
- All production Rust sources frozen in rust-build-sources.json before release rebuild. Benchmark probes use the same source descriptor without map recollect or post-load repacking.
