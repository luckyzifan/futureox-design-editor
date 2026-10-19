# Compiled-scene image hydration verification

This directory is additive evidence and a reproducible CPU probe for the default Web/Electron render-worker change. It does not contain screenshots or GPU device measurements.

## Reproduce

From `frontend/design-client`:

```
node_modules/.bin/vitest run src/kernel/scene-image-hydration.test.ts src/kernel/render-worker-image-hydration.test.ts src/kernel/decoded-image-cache.test.ts src/kernel/image-mip-cache.test.ts src/kernel/image-mip-cache-storage.test.ts src/kernel/render-work-queue.test.ts
node_modules/.bin/tsc --noEmit
```

From the repository root, on a quiet CPU host:

```
node testing/verification-image-hydration-20261019/benchmark.mjs
```

The probe requires the shipped portable WASM and existing client source. It does not fetch dependencies, compile Rust/WASM, launch a browser or create an OS socket. Its fetch double supplies the exact local WASM bytes to the unchanged production persistent-key implementation.

## Baseline provenance

`baseline-image-cache.txt` is an exact contiguous excerpt of `frontend/design-client/src/kernel/render-worker.ts` in the required base commit `71d32153e6f55b3723c99708b4c4c49ac7342e67`. That file was unchanged by the previously delivered cumulative ZIP. `baseline.json` records both the full source SHA-256 and excerpt SHA-256. Tests execute the excerpt after TypeScript type removal; they do not reimplement the old warmup algorithm. The baseline remains reproducible without an undeclared external checkout or private fixture.

All image fixtures are generated from source with the shipped PNG encoder. The default-route tests execute the actual render-worker admission, lane, compilation, hydration, fallback and publication code. The GPU device boundary is a double; image cache/texture upload selection uses the production GpuRenderer and real WASM-decoded pixels. Full compositor/GPU pixel fidelity and frame rate are not measured.

## Change and boundaries

- Ordered document synchronization and revision publication finish before cancellation and optional hydration.
- Exact compiled-scene dependencies come from the existing sceneIndex used by GpuRenderer, including mask, clip, blend and effect dependencies. No new geometry visibility heuristic is introduced.
- Each actual scene chooses one representation, linear when floatCompositing or colorManagement is set and byte otherwise. Subdivided/tiled/fallback scenes make the decision separately.
- Request state bounds repeated reads and URI retention. Residency remains the existing 64 MiB LRU; returned payload work is capped separately. Oversized, missing, malformed or unavailable records use the unchanged synchronous full-quality decoder.
- The byte cap is post-read admission/accounting, not a strict peak-allocation guarantee for IndexedDB cloning. The persistent store and its existing post-read 256 MiB cap are unchanged.
- Captured lane/document-generation/resource/color ownership is checked around every await. Late results cannot populate or clear a newer owner. The synchronous decoder also checks cancellation before decoding.
- RenderWorkQueue holds a complete gpu.render promise; priority switching occurs only after a completed tile. This is the serialization fence for binding the current image decoder.

The standalone ABBA benchmark measures this optional hydration boundary only: real persistent SHA keys, production cache control flow, and an in-memory structured-clone persistence double. It excludes real disk/IndexedDB delay, compiler startup, GPU execution and display. No timing threshold makes a correctness test pass or fail.

## Frozen result

See `report.md` for the 55-test result, raw ABBA interpretation, true PQ lane-color regression and boundary doubles. `source-manifest.json` records the tested source identity; `SHA256SUMS` records the evidence files.
