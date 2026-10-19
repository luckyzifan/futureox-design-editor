# Default-canvas compiled-scene image hydration

## Result

The default Web/Electron render-worker now hydrates only the image dependencies of each actual compiled GPU scene, and only the byte or linear representation that the production renderer requests. It no longer blocks document admission on a full-document, two-format persistent-cache sweep.

- Focused verification: **55/55 tests passed in 6 files**, with zero skipped or failed tests. TypeScript `tsc --noEmit` passed.
- Reproducible 1,000-image fixture: **2,000 → 4 persistent key computations/reads**, and **20,000 → 64 returned payload bytes**, for four compiled image dependencies. Peak concurrent reads remained one. Hot-cache decoder calls were zero in both implementations; this experiment proves avoided cache work, not fewer decodes.
- Quiet-host ABBA hydration-boundary CPU proxy, 10 measured samples per implementation: baseline median **152.836382 ms**, candidate **0.604586 ms**. Baseline range 132.475196–170.153468 ms; candidate range 0.435857–3.013503 ms. Raw ordered samples are preserved in `benchmark-abba.json`. These timings exclude real IndexedDB/disk latency, GPU execution, display and FPS.
- Exact authored-document, compiled-packet, CPU pixel and decoded source-texel equality is asserted. Production GpuRenderer cache/upload-selection tests also compare the exact uploaded source arrays. Full GPU-composited framebuffer pixels are not measured.
- A real PQ cross-lane texture-cache defect was reproduced and corrected, with repeated switches in both directions and cancellation controls.

## Implementation

`render-worker.ts` completes ordered document synchronization, revision tracking and authored snapshot publication before optional asynchronous cache hydration. CPU/PNG routes do no JS image-cache warmup. All four actual GPU-render call sites hydrate their compiled scene immediately before rendering, including pose, full-frame, presentation-tile and readback/split-tile paths. One request session avoids duplicate reads across tiles.

The new `scene-image-hydration.ts` uses the existing `sceneIndex(scene).images`; it introduces no independent geometry or visibility heuristic. Compiled masks, clips, image adjustments, blending, background blur and offscreen effect dependencies remain authoritative. The representation rule matches GpuRenderer defaults: linear if `floatCompositing || colorManagement`, byte otherwise. Tests cover omitted, false and true floating flags under managed and unmanaged modes.

The render-work queue holds the complete GPU render promise. Priority lane changes happen only after a completed tile, providing the serialization fence for binding the loader context. Each asynchronous hydration operation captures immutable engine/lane/document/resource/color ownership and checks it before and after awaits. A canceled or stale read cannot insert into or clear the newer owner. Full-quality synchronous decoding checks cancellation before expensive fallback; cache misses, oversized or malformed records, unavailable fingerprinting and exhausted optional budgets do not reduce output precision.

Limits remain explicit: the existing decoded cache is a 64 MiB LRU; each hydration session also limits optional returned payload work to 64 MiB, attempted entries to 1,024 and retained key strings to 4 MiB. Wrong-variant typed payloads are charged before admission. The read budget is post-read accounting, **not a strict IndexedDB clone peak-memory guarantee**. One in-flight storage/key operation is not aborted; subsequent work is stopped and late results are rejected. The persistent store's existing 256 MiB post-read cap, cache key algorithm and storage schema are unchanged.

## Real cross-lane color regression

The original tile resume branch restored backend preferences but did not restore `colorKey`. If an interaction lane used different managed color settings while keeping the same float mode and image URI, its production GpuRenderer texture could be retained for the resumed canvas lane. Rebinding a loader alone cannot invalidate an already resident URI/level texture.

The test generates a real Rec.2100-PQ PNG using the shipped WASM encoder, then decodes the same URI in two real VectorEngines. Reference white 100 yields `[1.0149508714675903, 0.5074782371520996, 0.25374260544776917, 1]`; reference white 203 yields `[0.4999758005142212, 0.24998928606510162, 0.1249963641166687, 1]`. Before the fix, the actual worker test retained the other lane's wrong float payload on resume in both directions. This is an actual WASM payload difference, not a fabricated decoder response.

The narrow fix applies the existing request-admission color/settings disposal semantics at the resume boundary. It checks preview/fill cancellation before selecting or restoring the older lane, preserving the newer lane's live resources if the older request has been canceled. Three repeated interruptions in each direction now yield exactly A/B/A/B/A/B/A source payloads, seven resource instances and six nonduplicated disposals. Preview and tile-fill cancellation both prevent stale resource recreation and still admit the next ordered document patch.

`lane-color-real-pq-before-fix.log` preserves two expected failing cases from the hydration candidate before the resume correction. `lane-color-negative-identity.json` identifies that source and proves its faulty resume span is byte-identical to the delivered baseline; `baseline-lane-resume.txt` ships the exact span. The independent review additionally reproduced the exact delivered-baseline branch with real PQ WASM/GpuRenderer inputs and reported 7/7 fixed-candidate checks. Its evidence belongs to the separate independent-review publication, not the 55-test count above.

## Tests and boundary doubles

The 55 tests comprise 28 hydration tests, 11 actual render-worker tests, 6 decoded-cache tests, 3 persistent-key tests, 3 persistent-storage tests and 4 render-queue tests. Controls cover cancellation during hashing/reading/yield, late stale-source data, same-ID reopen, ordered patches after cancellation, both missing and rejected storage results, malformed/wrong-variant records, oversized buffers, request and residency budgets, immutable borrowed pixels after eviction, exact byte/linear mip levels, default representation flags and compiled effect dependencies.

The worker tests import production render-worker admission/compilation/cancellation and real VectorEngine code. They double resource boot, persistent-store calls and GPU device/transport construction. The latter retains the real GpuRenderer resource cache, image lookup and upload-selection implementation and records exact decoded arrays; the returned transport framebuffer is synthetic and is not used as GPU pixel evidence. Separate CPU/PNG route tests compare real WASM output exactly. Node MessageChannel is used for the existing worker scheduling seam; no browser or GPU is launched.

The ABBA probe executes the exact delivered warmup source excerpt after TypeScript type removal versus production candidate code. It uses real persistent SHA keys and the unchanged local WASM fingerprint, with an in-memory structured-clone persistence double. All PNG/PQ fixtures are generated from shipped source. No private checkout or external generated fixture is needed to run the focused tests or benchmark.

## Provenance and artifacts

- `README.md`: reproduction commands and scope.
- `baseline.json` and `baseline-image-cache.txt`: exact baseline source/excerpt identity and executable excerpt.
- `source-manifest.json`: fixed product/test dependencies, benchmark, baseline spans and portable WASM hashes.
- `targeted.log` / `targeted.json`: final 55-test run; `typecheck.log`: successful typecheck, no diagnostics.
- `benchmark.mjs`, `benchmark-abba.json`, `benchmark-abba.stderr.log`: reproducible CPU probe, raw ABBA samples and runtime warning.
- `lane-color-real-pq-before-fix.log`, `lane-color-negative-identity.json`, `baseline-lane-resume.txt`: explicit expected-failure control and identity.
- `SHA256SUMS`: frozen evidence checksums.

The base commit is `71d32153e6f55b3723c99708b4c4c49ac7342e67`. The preceding cumulative ZIP SHA is `02241e7467435d4e47a79041d0fccfea234c52d1b3a3b0e46eaa8f781ff1bafb`; it is an archive identity, not a commit. Its unchanged render-worker source SHA is `536bba8636d30cf866cf1503534e0fe71982b8b1790a669fde12aba2740b6f17`. Portable WASM remains `2c50f87de40b6e2ecc456eb053706d4e2c3c058da82aafffd1b191eddd8b039a` and was not rebuilt. All source hashes are in the manifest; earlier delivered ZIPs and verification directories were left untouched.
