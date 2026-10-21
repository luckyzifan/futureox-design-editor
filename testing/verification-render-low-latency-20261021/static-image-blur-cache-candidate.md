# Static image blur: exact first-tile reuse candidate

Status: CPU-checked candidate, **default off**. Enable only with `VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE=1`. Actual Metal/Electron correctness and latency gates are separate and had not run when this record was written. This candidate follows the committed `f2b5817` checkpoint; it does not change that checkpoint's acceptance claims.

## Scope and expected work removal

The measured 117 gesture moves a foreground group without an image or filter. An earlier stationary image has a source-space blur radius of `38.25948715209961` at the 100% sampling density. The first tile in consecutive capture requests has identical source coordinates, input support and output extent. Re-running that image's source sampling and H/V blur is redundant.

This first implementation accepts only a leaf with one visible normal image paint at paint opacity one, one non-gradient blur, no strokes/masks/clips/pass-through/replay, native four-sample full coverage, complete support on both axes, no image mip/atlas, managed exact WebGPU and an admitted native-axis image table. It is further restricted to `32 <= radius < 64` so cold high-zoom tiles retain their existing horizontal-filter working set.

Only **identical input and output rectangles** can hit. Partial overlaps, changed windows and edge-zero-padding equivalence are not claimed or implemented. The cached surface is the existing H/V result, before node opacity, blending, clip or final HQ/color/dither processing. A hit borrows this same RGBA32F surface and calls the existing four `merge` operations in their original order. It introduces no float copy, resampling, extra blend or arithmetic.

The observed common 1032×1032 output occupies 16.25 MiB. Reuse can avoid its 1112×1112 source, 1032×1112 horizontal work and X table. This is a work-removal hypothesis, not an end-to-end latency measurement. It cannot accelerate the first 3200% render without an existing same-camera result.

## Identity and lifetime proof

1. **Upload authority.** The renderer registers an opaque source token only after its actual managed linear upload succeeds and `driver.imageTableRange` returns the private proof for that texture. The source record binds the exact texture object, resource, width, height and proof, plus the full URI/ICC/EXIF, working-color settings and image-adjustment descriptor. Public finite flags and packet-shaped objects cannot mint a token.
2. **Conservative residency.** This version pins that actual source texture; it does not reuse a content token across eviction/reupload. Ordinary/forced eviction and the evictable-image predicate exclude pinned sources. A source leaving the compiled scene retires associated entries; submitted reads keep their pins until completed. Source writers must irreversibly revoke private image proofs—the concurrent driver proof-revocation change is a prerequisite.
3. **Native sampling.** A cache candidate must satisfy `fullSampleCoverage` over its complete input and `completeFilterAxisSupport` for X and Y. Registration of an eligible result also requires a handle returned by the actual `prepareFilterImageTable` path, which built all four native axes and passed the existing private range/plan admission. Same input, original matrices/paint/size/camera and arithmetic policy reproduce those same coordinates; this does not infer general translation invariance.
4. **Exact entry key.** Binary64 values, including signed zero, use `exactFilterKey`. The entry key binds the actual node mapping, image policy, effects, radius, full camera and resolve/presentation/arithmetic settings. Tile origins/crops stay in the entry comparison rather than clearing all entries at every tile. Zoom or working-color/arithmetic changes retire the broader context.
5. **Completed publication.** Staging is not publication. A successful current frame must accept the result, and `completedResourceEpoch` must reach its production epoch before it can be borrowed. Failure, cancellation and a subsequent frame cannot accidentally approve abandoned pending entries.
6. **Borrow safety.** A hit marks the plane used and holds a reader across all four asynchronous reclaim boundaries. Retirement waits for both readers and the last submitted read epoch. The renderer's final busy sweep excludes owned cache planes, and its explicit filter-destination seam rejects writes into them.

## Budget and fallback

The cache retains at most four result planes totaling 32 MiB. Pinned image textures remain charged to the existing renderer byte ledger too. Neither results nor sources enter the separately exempted interaction-residency counter: exact coherent work retains its 256 MiB limit.

Ordinary completed pool/parameter/image resources are reclaimed before retiring completed blur entries. A current frame's unpublished, unborrowed candidate may be abandoned under pressure and returned to the ordered target pool; its producer still marks it used, so destruction requires the existing fence. Prior-frame, accepted and borrowed resources retain their stricter completion guard. Unsupported admission and cache misses execute the original path. No reduced density, shorter support, fallback image or increased working budget was introduced.

Five bounded numeric counters are forwarded through both tiled-render return paths and terminal diagnostics: `staticImageBlurEligible`, `staticImageBlurHits`, `staticImageBlurPixels`, `staticImageBlurBytes`, `staticImageBlurEntries`. They expose no URI, document, source token or private pixel data.

## CPU checks

From `frontend/design-client`:

```sh
./node_modules/.bin/vitest run \
  src/kernel/gpu/static-image-blur-cache.test.ts \
  src/kernel/gpu/static-image-blur-renderer.test.ts \
  src/kernel/gpu/horizontal-filter-cache.test.ts \
  src/kernel/gpu/whole-image-filter.test.ts \
  src/kernel/gpu/reclaim-maintenance.test.ts \
  src/kernel/gpu/renderer.test.ts \
  src/kernel/gpu/image-table-lifetime.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Result: **7 suites, 97 tests passed** in 8.07 seconds. The new two suites contain 16 tests. The renderer fixtures use real WASM coordinate fields and production CPU plan/range admission, with an independent CPU storage/neighborhood transport. They compare all four output planes' raw bits against the same uncached path and verify that hits skip upload, table preparation and both filter axes while retaining four merges. This transport does **not** prove WGSL rounding or Metal behavior.

The first fixture runs exposed test issues, corrected before the final pass: a synthetic completed epoch incorrectly moved backward, reused target buffers were not cleared as real frame targets are, a coverage mutation was outside the sampled rows, and teardown expected individual destroys although the renderer uses the driver's bulk dispose contract. Pixel and lifetime assertions were retained. No shader/math change was made to address these fixture failures.

From the repository root:

```sh
node --test frontend/design-desktop/test/render-terminal-diagnostics.test.mjs
git diff --check
```

Result: **19 diagnostic tests passed**; whitespace check passed. The concurrent driver source-window agent subsequently reran the full project's `npm run typecheck` after both branches' negative-fixture type corrections and reported exit 0. All cache source and tests were frozen before the device gate.

## Cache source freeze hashes

| File | SHA-256 |
| --- | --- |
| `static-image-blur-cache.ts` | `f51dfbae376d1da613799d6e4d907d3bff259bdef7c5dcf9fdbc9c37fd6dd79e` |
| `static-image-blur-cache.test.ts` | `9b7698d4f03edbd6cf7c87ec723cb8dda05880b1538528bbad00f5402997e7df` |
| `static-image-blur-renderer.test.ts` | `d270da6bcd0023ff79913f11f550c39d6b95f85d0bfc8f01982a9d7373abde09` |
| `renderer.ts` | `dd60d853d838213d381f4f5e52101017f8fa15c1a75b639a478b22a309bcccba` |
| `render-worker.ts` | `efab2a3f1eebe67f134d006e544a97cc025b0ec2744bf1337dd1134cc83c2942` |
| `render-terminal-diagnostics.mjs` | `ee619f18282b9d86bb212cf0b82c89bcf142be06bc2704a26f09d2d57700d1c8` |

The main agent owns the next actual-device oracle, matched normal drag, held latest-input acknowledgement, full-document undo and peak-memory checks. A nonzero cache-hit count alone does not satisfy those gates.
