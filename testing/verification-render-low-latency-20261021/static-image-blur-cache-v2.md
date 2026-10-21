# Static image blur cache v2: one complete tile, default off

This supersedes the storage/admission limits in the [v1 candidate record](static-image-blur-cache-candidate.md). The exact source, native-coordinate, complete-halo, four-merge and GPU lifetime proofs remain unchanged. Enable only with `VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE=1`; no default activation or latency acceptance is claimed.

## Why the first candidate was narrowed

The main agent's actual Electron v1 run preserved all 13 compared PNGs and full-document undo. It hit one 1,065,024-pixel result and skipped one table plus two whole filter axes. However, a fresh same-source-build control with the cache disabled had held-input acknowledgement at 517.15 ms versus 623.42 ms with v1; the measured verified-pixel upper bounds were 731.14/837.12 ms. Total drag queue wait was essentially unchanged, approximately 897.6/898.4 ms. These are software-visible timings, not physical input-to-photon.

Detailed older matched f2 comparisons showed the cached latest group improving while the preceding capture group slowed. The three smaller edge results never hit but grew retained results from 17,040,384 bytes to 32,051,008 bytes. Retaining a result can also remove a texture from the normal ordered reuse pool: some later working-set samples increased by exactly 17,040,384 bytes and crossed the existing image-maintenance threshold. There was no recorded hard-admission pressure in that group. The first table wait occurred before those edge results existed, so the entire regression cannot be assigned to edge retention alone.

The worker CPU sample attributed about 14.4 ms inclusive to repeatedly constructing a source descriptor containing the full URI. That is a removable cost, but it is not an explanation for the whole latency regression.

## The two changes

1. **One complete large tile.** Result residency is now at most one slot and 17 MiB. Production performance admission requires the actual native `scene.output` crop to be exactly `TILE_SIDE + 2` on both axes, plus an integer source-plane window at least 1024×1024 and no larger than 17 MiB. The native crop comes from `compile_gpu_region_impl`, not the gesture's union width/height. Narrow and near-full edge crops cannot look up, stage, replace or clear the common first-tile slot. A complete large-tile miss retires the old slot before source upload or H/table allocation; normal epoch/reader fences still govern physical release.
2. **Separate URI and policy equality.** An actual upload's private record now stores the original complete URI string and a small exact policy string separately. Both must compare equal on lookup. The small policy still covers adjustment and complete working-color/driver settings. The URI is no longer fed through `exactFilterKey` on every lookup. The private range, resource, shape, texture identity and writer-revocation checks are unchanged.

Cache-context and per-entry pixel keys were not changed. Partial-overlap rendering was not added. No shader, filter support, global maintenance heuristic, image precision or 256 MiB working budget was changed. The shared 17,040,384-byte result still occupies that much pool capacity; v2 does not presume its cold-frame cost disappears.

## CPU verification and limits

The same seven targeted suites listed in the v1 record passed **101 tests** in 8.26 seconds after changes A+B. The desktop numeric-diagnostics suite passed **19 tests**, including the reduced 17 MiB/one-entry bounds. Full-project `tsc --noEmit` and `git diff --check` passed.

The final additional native-full-crop check and near-full-negative cases were followed by another run of the two new cache suites: **20 tests passed**, then full-project typecheck and whitespace check passed again. These are overlapping runs; their counts must not be added together.

The small native-coordinate CPU transport overrides only the new performance size predicate, so source/native-table/coverage/halo/equality/lifetime behavior remains tested without allocating large synthetic image planes. The real size predicate has separate tests for complete padded tiles, narrow edges, near-full native crops, missing native crops, oversized storage and noninteger sizes. The transport still proves neither Metal timing nor WGSL arithmetic. The main agent owns the next matched actual-device run.

## Final v2 source hashes

| File under the client GPU directory unless noted | SHA-256 |
| --- | --- |
| `static-image-blur-cache.ts` | `94a0030cd5149aaf84b5ed3bbc5cc819593dd0815e26abd62481c0a9c1b2972f` |
| `static-image-blur-cache.test.ts` | `8a1fc7a0a33eed50ea068d5a9b25235fa22351e4fc140d104ef64a4bf4849f2b` |
| `static-image-blur-renderer.test.ts` | `0bd7834d71ba5a1e809ec3c302bc0e1625230cbf30c2218003fa7c6c9afe683b` |
| `renderer.ts` | `119f6c5ee2b90613965af78a2d77c57d64b3ab9e242abb93b701274bee942745` |
| desktop `render-terminal-diagnostics.mjs` | `13f3f33e0ffac01e24d8a85f8b65ff9161cc4e8e0508b9cd9adfe3ff24263582` |
