# Interaction preparation work reduction

## Change

The live InteractionRenderer now groups scene entries into page-root envelopes in one traversal instead of filtering the complete scene for every root. The original per-entry effect/stroke padding, unionBounds function, scene order, page-root key order, hidden/empty roots, and direct-plus-ancestor membership are preserved. There is no cross-document cache. Renderer arithmetic, image sampling, effects, zoom cadence, tile publication and raster request policy were not changed.

Owned source files are in final-source-manifest.json. The production change is interaction-renderer.ts plus interaction-scene-bounds.ts. The two corresponding test files contain regressions and exact comparison coverage. The pre-change renderer matches the prior delivered a9fb36a1 source snapshot; its isolated raw copy is retained outside this increment. Tests include the old per-root expression for comparison.

## Evidence

- before.log: production 3,000-root regression fails on the old renderer with 18,009,002 identity/ancestor reads; the expected native raster request and capture window already pass.
- bounds-final.log: 3,000-root direct helper counts are 18,000,000 before and 9,000 after. CPU timing is a separate alternating 15-pair loop over ordinary, unwrapped entries. Final medians are 201.67 ms before and 9.16 ms after; an earlier paired run was 219.67 ms and 11.15 ms. This is only root-envelope preparation, not complete warm-up or FPS.
- Small CPU/WASM crop: 18×19, camera x=3 y=3 zoom=1, analytic profile, 3,000 nodes; 1,368 bytes identical. SHA256 78a3b6046e69a9b3051e00ddc77af665301f3fe67eb6f0d762c9d947d8220f35. This is crop evidence, not full-scene acceptance.
- Larger CPU/WASM viewport: 312×284, camera x=45 y=19 zoom=1, analytic profile, 3,016 nodes including nested groups, alpha masks, clipping, shadows, background blur, hidden descendants and distant offscreen roots; 354,432 bytes identical, 318 distinct RGBA colors, and authored content in all four tested regions. SHA256 5f9e2596bcf8590d090ea0848d484161fa071b1bbfee746f280a634d209a077e.
- Deterministic 60/90/120/144 Hz traces use the production InteractionRenderer with a controlled worker and performance clock, 3,000 nodes, a replaced selection, delayed stale completion and increasing pointer inputs. Every trace submits exactly three renders, releases the old selection texture without publishing it, and publishes the newest input at 1,000 ms. These are scheduling/ownership tests, not hardware frame-rate measurements.
- focused-final.log: 121 tests across interaction renderer/layers, root bounds, navigation zoom, render mailbox and progressive damage passed. After the final clock assertion, owned-final.log records 41/41 owned tests passing. typecheck-final.log is clean.
- The optional benchmark repeats the deliberately slow baseline 15 times; its test-only timeout is 30 seconds when DESIGN_INTERACTION_BENCHMARK is set. The normal correctness test retains its 5-second timeout. No assertion was removed or relaxed.

## Limits

No GPU, browser, socket or remote access was attempted. CPU/WASM used the existing shipped module; this focused run did not rebuild Rust. CPU timings reflect the shared cloud host and should not be described as end-to-end interaction latency or GPU/FPS gains. Independent differential review is recorded separately in the independent verification records.
