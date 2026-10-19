# SVG compatibility evidence

Scope: the SVG document importer and SVG-only helpers. No renderer/kernel/export edits. `path-network.ts` remains byte-identical to the retained baseline.

## Reproduce

From the repository root:

```sh
cd frontend/design-client
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run src/svg-values.test.ts src/svg-color.test.ts src/import-svg-compatibility.test.ts src/import-svg-viewport.test.ts src/svg-path-closure.test.ts src/path-network.test.ts src/export-native.test.ts src/export-regions.test.ts --reporter=default --reporter=json --outputFile.json=../../testing/verification-svg-compatibility/focused.final.json
node --test src/svg-presentation.test.mjs
cd ../..
node --expose-gc --experimental-transform-types --import ./testing/lib/register-typescript.mjs testing/verification-svg-compatibility/benchmark.mjs
```

No dependency installation, server, browser, GPU, socket, external SVG asset, or script execution occurs.

## Evidence classes

- `focused.final.json` / `.log`: real XML `DOMParser` from the installed JSDOM host, real production SVG importer, existing CPU/WASM geometry and renderer, binary `.fd` codec, exact affine coordinate checks, existing export/path regressions. The host is not a browser rendering engine.
- `svg-color.test.ts`: explicit minimal Canvas host double tests fallback cache ownership and validation control flow only. Hex imports use the production CPU path with no Canvas at all.
- `presentation.log`: seven existing Node/source/presentation contracts, not renderer pixel tests.
- `typecheck.final.log`: TypeScript static checking; empty log plus successful exit is expected.
- `benchmark.json`: 15 alternating-order before/after samples, 3 warmups per implementation/fixture, GC between samples, SHA-256 of exact production inputs, allocation counters, full samples and median/p95. Runs on a shared Linux CPU, not a controlled browser benchmark.
- The geometry/no-paint timing cases use real XML and model/WASM code, no Canvas double. For colored baseline fixtures only, JSDOM lacks Canvas: a deliberately tiny opaque-hex fillStyle host double is used. Counts prove avoided createElement/getContext calls; those timings cannot be presented as browser/Canvas speedups. A real-browser measurement remains not run.
- `baseline.sha256` and `.before.ts`: original pre-change production source. Initial/iteration logs are retained, including an initial JSDOM test environment setup failure and a differential failure caused by JSON-equivalent `-0`/`0`. Final results must be read from the explicitly named final files, not pooled with initial runs.

## Negative controls

Wrong transform arity, NaN/Infinity/coercible JavaScript numbers, matrix overflow, malformed/long unclosed transform input, transform operation budget, bad absolute units/dashes, gradient cycles/missing/external/wrong references, the 64/65 template boundary, 32/33 stop boundary, alpha/focal/spread/color-space limitations, rejected declarations/oversized text, nested SVG and use recursion. The old endpoint-only gradient matrix produces different real CPU pixels; restored `.fd` produces exactly the corrected pixels. Per-layer stop mutation does not leak through caches.

## Acceptance limits

This is a bounded SVG compatibility improvement, not a complete SVG conformance suite. The feature matrix and known gaps are in `docs/SVG_COMPATIBILITY_AUDIT.zh-CN.md`. Actual browser/SVG-reference pixels, installed application interoperability, GPU, native OS and font matching are not claimed. The parent task owns aggregate repository verification and packaging.

## Final observed results

- Focused Vitest: 161/161 passed, 0 skipped, across 8 files. This includes existing path/export/viewport regressions; it is not a claim of 161 newly written tests.
- Existing presentation Node contracts: 7/7 passed.
- TypeScript: passed.
- Retained baseline source hashes and the unchanged path-network hash: verified.
- Benchmark hashes match the final production files.

| Fixture | Before median ms | After median ms | Interpretation |
| --- | ---: | ---: | --- |
| 2,000 rectangles, no paint | 421.68 | 445.98 | +5.8%; strict validation plus shared-host variation, no speedup claim |
| 200 paths, no paint | 37.50 | 38.19 | +1.9%; no general throughput improvement established |
| 2,000 repeated hex fills | 387.30 | 382.74 | -1.2%; Canvas host double, not a browser speedup |
| 1,000 repeated gradients | 161.58 | 130.99 | -18.9% in this CPU host fixture; Canvas host double |

For both colored fixtures, baseline creates 2,000 canvases/contexts and performs 8,000 fillStyle assignments; final creates zero and performs zero. The no-paint cases use none in either implementation. Other supported color syntaxes lazily share one context per import. The deterministic reduction is more transferable than this noisy host's timing ratios. Earlier runs are retained and must not be cherry-picked to advertise a broader improvement.
