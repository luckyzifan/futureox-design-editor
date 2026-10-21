# Exact decoded-image residency across an acknowledged interaction fork

## Observed path and scope

The main Electron profiling run identified `image_info → Images::base → ColorSettings::to_working → libm pow` during the first held drag. The measured `pow` self time was 287.6 ms in that profile. This is a real conversion path, not a pure dimensions query: `design-studio/crates/design-kernel/src/lib.rs` calls `image_data` from `image_info`, and `paint.rs::Images::base` fully decodes and converts on a cache miss.

The immediately following `image_linear` call uses the **same** Rust asset engine and its populated `Images` cache. It exports the float pixels; it does not repeat color conversion. The duplicated residency boundary was between lanes: `render-worker.ts` creates a separate asset `VectorEngine` for canvas and interaction, while the JS `DecodedImageCache` previously cleared its one bounded cache when the scope's lane changed. An optional persistent-store miss then made the interaction lane decode the same source again.

This change does not modify Rust, image decoding, ICC processing, orientation, color transfer functions, floating-point arithmetic, mip generation, or the GPU renderer.

## Admission and lifetime

- Each full document synchronization starts with a fresh private, frozen decoded-image owner token, registered in a `WeakMap`. A file-supplied document ID or a copied token-shaped object cannot manufacture that identity.
- An interaction synchronization can inherit the canvas token only after complete JSON equality has reused the same immutable authored object, or after the existing native derivation receipt validation has produced that object. Both the canvas current and synchronized document references must still match; a deferred canvas pose is excluded.
- The cache scope contains the token identity and the **complete** serialized working-color settings. The per-entry key still contains the byte/linear variant and full image data URI, including its ICC/EXIF and encoded image bytes. Changed source data or settings cannot hit the old entry.
- Pose/document patches retain the owner. Their changed image URIs select different entries; changed color settings select a different scope. Full canvas reopen, including identical JSON with the same document ID, starts new residency.
- The existing lane, document generation, resource generation, engine promise, cancellation and current-color guards remain around asynchronous hydration. The captured decoded-image owner is an additional check. A late read cannot repopulate a new owner or a different active lane. A late optional persistence write retains its captured key/settings/pixels and never changes live residency.
- Cache capacity remains 64 MiB, including its keys, scope and complete backing allocations. Borrowed immutable decoded arrays retain the existing ownership contract. GPU image adjustments already allocate out of place. Level-above-zero requests continue through the original exact mip API.

The optimization can miss if the canvas never decoded a required source, its pixels were evicted, another scope replaced residency, or the interaction does not have a proven common source. Those cases use the unchanged exact decoder. This change alone does not establish an end-to-end drag speedup.

## CPU verification

Executed from `frontend/design-client`:

```sh
./node_modules/.bin/vitest run src/kernel/decoded-image-cache.test.ts src/kernel/scene-image-hydration.test.ts src/kernel/render-worker-image-hydration.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/tsc --noEmit
```

Final result: **3 suites, 61 tests passed**, 5.81 seconds; typecheck passed. These suites use real WASM decoding/preparation and CPU doubles for GPU uploads/transport. They are not GPU rendering or whole-Electron acceptance.

New coverage includes:

- Actual worker canvas → interaction → pose patch → canvas, with forced backend recreation to require new image uploads rather than allowing retained GPU textures to conceal another decode. Four source images produce four `image_info` calls throughout, and exact uploaded bytes/float bits remain equal. The same-ID full reopen raises the count to eight as expected.
- Actual preparation-worker/native derivation with no full-document fallback: four decoded sources remain four `image_info` calls, and the second lane's uploaded float bits match.
- Same-ID different authored JSON and a different document do not inherit residency.
- Existing real PQ color-context switch tests remain passing, including return to the prior canvas lane. Complete settings remain part of the scope.
- Opaque-token forgery rejection, variant/source key separation, immutable borrowed bits, pending old-lane reads, same-ID owner replacement, and delayed optional persistence writes.

The first run had six failures: five existing tile-route tests lacked the recently introduced `releaseFilterBatch` method on their GPU double, and the new preparation-worker test's resource double returned no font. The test double now supplies that release method and loads the real bundled font only for the preparation test. The final run above passed without relaxing assertions or changing production rendering for those failures.

## Frozen source identity

SHA-256 at the completed CPU check:

| File under `frontend/design-client/src/kernel` | SHA-256 |
| --- | --- |
| `decoded-image-cache.ts` | `de1f9bad1f6009c636d4449d38dd523f2a1c71937aed09e124cb44e5a550c812` |
| `render-lane-state.ts` | `6304866859c89829f4d81202516bea3aa7b1440e638f9f28136be262f900793e` |
| `render-worker.ts` | `0a031652346790f8594df04282cafe8df1820ed76b6bac2299f50c87dadaca17` |
| `decoded-image-cache.test.ts` | `55f010bde68422d69bf0774afdb957a2b2a120da3c34b09010fc286ef95f6485` |
| `scene-image-hydration.test.ts` | `ff221054c71d1809e711dfce7e1c3cf4d3834b35f83130d3e883beec1ad92773` |
| `render-worker-image-hydration.test.ts` | `eaa7a77380d084f115a76001a2c269426b95eb02aa4994f682581a192b041ce5` |

Integrated held-drag latency, final canvas and undo equivalence are recorded separately in [the matched Electron record](README.md). The CPU checks above do not replace that device gate.
