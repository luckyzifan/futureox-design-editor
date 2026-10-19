# Independent cache-invariant review

Review date: 2026-10-19 UTC. Status: independent review complete for the recorded source checkpoint; **not final artifact acceptance or a new delivery**. No unresolved correctness blocker was found within the reviewed/tested scope after the two corrections below.

Repository: `${REPO}`.
Delivered baseline: `futureox-desgin-design-tools-performance-cumulative-20261019.zip`, SHA-256 `02241e7467435d4e47a79041d0fccfea234c52d1b3a3b0e46eaa8f781ff1bafb` (independently rehashed). Its unchanged base is `71d32153e6f55b3723c99708b4c4c49ac7342e67`.

## Findings

1. **Optional image-read work budget skipped wrong-format payloads. Fixed and independently verified.** The initial implementation charged bytes only after requested byte/linear-format admission. A correctly shaped cached array of the wrong variant could therefore consume repeated persistent reads without debiting the request ledger. The author now charges returned typed-array backing allocations before format/shape admission. The independent test verifies one 256-byte wrong-format record exhausts a 256-byte request budget, populates no residency, and still falls back to the original full-resolution decoder. This is a returned-payload work/admission bound, not a strict IndexedDB clone allocation bound; malformed records discarded inside persistence are instead bounded by request count.

2. **Pre-existing priority-yield color-context restoration gap. Fixed and independently verified.** Worker request admission retires the renderer when color settings change, but the delivered tile-resume branch only restored backend/reference/batching flags. If higher-priority interaction work had installed another managed color setting, the resumed canvas could retain its same-URI floating texture. Correctly rebinding the image decoder alone cannot replace a texture already in the renderer cache. The root-authorized correction now restores the color key and retires incompatible residency at resume. Both preview-generation and fill-generation cancellation are checked before selecting/restoring the returning lane, so a canceled old canvas task leaves the newer interaction renderer alive.

The independent negative uses a real WASM-encoded Rec.2100 PQ PNG, two actual VectorEngines with reference-white settings 100/203 nits, production `GpuRenderer.loadImages`/`imageFor`, and the exact extracted production resume branch. The same URI produces materially different linear texels: at 100 nits `[1.0149508715, 0.5074782372, 0.2537426054, 1]`, versus at 203 nits `[0.4999758005, 0.2499892861, 0.1249963641, 1]`. Both baseline directions retain the wrong uploaded texture; the corrected directions retire it and upload the exact expected WASM payload. Sixteen alternating cancellation cases (8 direction changes × preview/fill cancellation) preserve the newer renderer and stop before lane selection/render. Same-color uncanceled controls retain residency. This records the upload boundary; no GPU device or final GPU-rendered pixels are claimed.

The delivered worker file is absent from the cumulative ZIP's changed-file payload and exactly equals git-base file SHA-256 `536bba8636d30cf866cf1503534e0fe71982b8b1790a669fde12aba2740b6f17`. Its extracted resume branch SHA-256 is `15dc6c91695a59a6d6c92a595f8b63ba1302428cc27fa24f42a1bba6d87affa1`. See `lane-color-delivered-baseline-identity.json`, `lane-color-delivered-baseline-resume.txt`, and `lane-color-final-real-pq-baseline.log` (two expected failures; cancellation case deliberately not selected by this baseline command). Earlier synthetic-float and real-PQ diagnostics are also retained. This distinguishes the existing bug from the new hydration patch.

## Independent completed checks

- Seven external Vitest tests pass against actual CPU/WASM/Editor/cache code: wrong-format budget charging and exact decoder fallback; queued hydration cancellation without clearing/repopulating a replacement owner; delayed persistence writes preserving captured pixels/settings without affecting a later lane; 30 actual Editor edit/preview/cancel/undo/redo sequences comparing fresh ordered scene/index results and testing query-result mutation isolation, followed by a font-epoch invalidation; the two real-PQ color-return directions; and repeated canceled returns with same-color controls.
- 196 black-box baseline/candidate stdio/SQLite checks pass. A fixed-seed sequence applies 96 metadata transactions with Unicode/control/empty strings, tied timestamps, deletion/restoration, repeated values, rollback, and old/current/empty view hashes. Each response is compared in full against the unchanged executable and against a separately canonicalized fresh list SHA-256. Additional checks cover warm queries, missing-table errors despite a hot cache, table restoration, and candidate restart.
- Tested backend source: `workspace.rs` SHA-256 `a55d4660ef678779c4780215682cb3a33f456d7ad16dd5e68373ba17e5312f11`. Baseline executable SHA-256 `3ebc574d61cff5b5573ecfbcb7f83b61fed083df8b03164b793deb6de9d78930`; candidate executable SHA-256 `c167b2327d071b7f113c2310cb72c3b3e9219610c6b793d6f75815f8cdce6532`.
- The first black-box invocation used the CLI flags in an unsupported order and exited before opening a workspace; that harness error is retained in `observe-randomized.log`. The supported flag order was corrected and the complete rerun passed in `observe-randomized-retry.log`. No product workaround or restriction bypass was used.
- Exact final review-checkpoint source/test hashes are recorded in `reviewed-source-identity.json`. The corrected worker SHA-256 is `05c5aa47aaa672bb4d3d66413d5523f21aa237c63b4b2b90dc04e5d23c6fab8c`; `scene-image-hydration.ts` is `377f7ec28a1c139bab6f74b60e6a673d3bf17781e8469693d75d9ca9e31812fd`. Earlier `tested-source-identity.json` remains an explicit earlier checkpoint. `vitest-final.log` is the final 7/7 result after portable-path options were added; `observe-randomized-results.json` lists all 196 black-box checks. The Python path override is the only post-run harness change; its oracle logic is unchanged.

## Static invariant review

### Compiled-scene image hydration

Hydration and renderer resource validation use the same compiled-scene image index; hydration adds no geometry culling or filter/backdrop/mask policy. A missed optional hydration still falls through to the kernel decoder. Variant selection matches the renderer's `floatCompositing || colorManagement` branch. Mips remain the original exact requested-level decoder. Boundaries check both request cancellation and the captured lane/document/resource/engine/settings owner after asynchronous hashing and persistent reads. Pending hydration calls serialize. Eviction drops references instead of mutating borrowed arrays; image adjustment in the renderer is out-of-place. Persistent writes capture original settings and pixels. All four worker GPU-render sites bind hydration; GPU ownership is serialized through each render promise.

### Canvas-local scenes/indexes

Reuse is confined to two active current/displayed scene slots, with lazy indexes, and one refine key/bounds record. It is not a general mutable-document cache. Identity guards include document, nodes, pages, fonts, page, owner, session/readiness, and an opaque picking-font epoch. Published Editor edits/previews/history replace snapshots. Scene arrays and indexes were inspected for mutation by the actual Canvas consumers; index query returns a new array. Epoch changes cover successful initialization, document-font activation, and PDF document/font installation. Rust font loading stages new resources before replacement. This review does not claim to redesign the pre-existing global picking-font environment for arbitrary older displayed documents.

### Workspace observation

The complete original ordered SELECT remains authoritative on every poll. Derived Entry equality covers all six serialized fields, length, and ordering. The original `Value` representation, 32 MiB bounded canonical serialization, and SHA-256 are preserved on misses. Presence/TTL/peer work remains fresh. Cache hits do not suppress SQL errors. Each published entries/hash pair is immutable; even a delayed older publication must match a later fresh list before reuse. Poisoned optional cache falls back. No schema, migration, persistent generation, or writer protocol changes were found. Retention is one store-owned snapshot with a 4 MiB capacity accounting limit; this is not a total process/transient/concurrent-memory cap.

## Performance interpretation

- Delivered Canvas already memoized current entries/index. Camera/hover zero-work results are preservation controls. New savings concern current/displayed/refine duplication and reusing an unchanged displayed snapshot while current previews publish.
- Image read-count reductions are optional persistence work, not proof of GPU frame-rate or input latency improvements. CPU packet/source-pixel equality and exact upload payload checks do not establish actual GPU-rendered pixels.
- The workspace author's ABBA report transparently identifies dev `opt-level=0/debug=0` binaries, full retained SQL work, child CPU versus stdio wall time, presence-only and every-poll-change controls, raw samples, and response encoding excluded from canonical-hash counters. It does not claim release-desktop/UI/GPU speedups. The 4 MiB retention and IndexedDB limits must retain their stated qualifications.

## Reproduction and required inputs

The external tests may be copied as a complete directory. From the reconstructed repository's `frontend/design-client`, run:

    REVIEW_REPOSITORY=/absolute/repository node node_modules/vitest/vitest.mjs run --config /absolute/copied-review/vitest.config.mjs --reporter=verbose

The config maps the original absolute import prefix to `REVIEW_REPOSITORY`, locates setup/WASM through that repository, and discovers tests relative to the copied config. No source text rewrite is required. The final 7/7 run used this config at the current checkout; a separate clean-machine relocation is not claimed here.

For the expected failing baseline color control, add `RENDER_WORKER_REVIEW_SOURCE=/absolute/baseline/render-worker.ts` and select `worker-lane-color -t 'priority-yield resume'`. The unmodified worker is recovered from the git base above; its exact hash is checked in the baseline identity file.

For the independent black-box protocol checks, copy the script to a fresh writable evidence directory and run:

    REVIEW_BASELINE_EXECUTABLE=/absolute/baseline/backend REVIEW_CANDIDATE_EXECUTABLE=/absolute/candidate/backend python3 /absolute/fresh-evidence/verify_observe_randomized.py

It writes results/stderr beside itself and creates/removes only its own isolated temporary databases. Use fresh evidence directories to preserve prior results. Prerequisites are the declared frontend dependencies/test setup, the existing portable WASM SHA-256 `2c50f87de40b6e2ecc456eb053706d4e2c3c058da82aafffd1b191eddd8b039a`, the repository's shipped default font/test-fixture support, Python standard library, and the two separately built backend executables. This reviewer did not build those executables or regenerate assets.

## Remaining acceptance limits

Final aggregate gates, author test completion, frozen-artifact verification, and publication remain the root's responsibility. Recompare the recorded source hashes if any product source changes. The independent lane test executes the exact resumed-worker branch with the real image resource cache and actual WASM-decoded pixels, rather than a complete worker event loop or device render; the author separately exercises the actual queued worker path. This review launched no browser/GPU/socket, performed no rebuild or dependency installation, and changed no product source. It does not establish device/visual correctness or whole-application performance.
