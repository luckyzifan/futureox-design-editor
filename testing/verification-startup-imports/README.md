# Synchronous SVG path import extraction

## Change and limits

`src/path-network.ts` contains the original `pathNetwork` function byte-for-byte (function SHA-256 `de128cda4c183d418c4641b2ea51fef040dc294091953a4b5e4250e93035ae49`). It imports only the existing `svg-pathdata` dependency and model ID/type definitions. `import-svg.ts` still exports the same function object, and uses it internally. `engine.ts` and `editable-network.ts` now import that synchronous helper directly. No parser, math, geometry, font, sampling, ID-allocation or asynchronous behavior changed.

The frozen full original importer is `import-svg.before.ts`, SHA-256 `1c00e9d6b5b3c0c556dcc1da364c459f85545dec612bb99aff5cb8719e5fc556`, identical to the file at repository base `71d32153e6f55b3723c99708b4c4c49ac7342e67`. The cumulative delivered baseline archive was `e7fea613c2aafbcd277dc6648bd8b425d65f18683c6ad8089577aabad4858d51`.

## Executed verification

- 75/75 focused Vitest tests in four files pass. Includes the actual retained old parser versus the current module on 256 seeded valid + 256 seeded malformed paths, 45 explicit edge/error cases, and three admission-boundary cases. Complete outputs, IDs, floats, handles, edges, error names/messages, and ID allocation counts are compared exactly.
- Explicit mutation controls prove that coordinate, control-point, edge, ID and error changes are detected. The old import path is verified to export exactly the same synchronous function object.
- Existing SVG closure and editable-network tests invoke the actual CPU WASM kernel, including document/undo and ellipse pixel checks. This does not establish GPU behavior or application startup timing.
- 23/23 existing SVG presentation/import-ownership Node tests pass.
- TypeScript `--noEmit` passes. A silent `typecheck.log` records its empty successful output; `summary.json` records the result.
- Two isolated Vite 8.3.0 production builds pass. Other source inputs are identical and frozen between the pair; only the four production sources listed above differ. Original build snapshots and dedicated outputs are in `/workspace/shared/design-ai-workspace-next/startup-build`. Public copying was disabled, and no shared generated/public assets or repository dist were changed.

The initial static JS closure shrank from 1,468,057 to 1,455,886 bytes, a 12,171-byte decrease. Sum of individually gzip-compressed initial chunks decreased 4,629 bytes (453,591 to 448,962). Three importer/presentation/viewport modules moved to the dynamic SVG chunk; the small parser module remains synchronous (net initial module count 330 to 328). The baseline's ineffective dynamic SVG import warning disappears; its unrelated export-module warning remains.

These are actual emitted bytes and module-placement results, not measured browser startup, CPU milliseconds, FPS or network transfer. The build timings printed by Vite are not used for a performance claim. No browser, socket, GPU, or kernel build was run.

## Reproduce

From the repository root:

```sh
./frontend/design-client/node_modules/.bin/vitest run --root frontend/design-client src/path-network.test.ts src/svg-path-closure.test.ts src/editable-network.test.ts src/import-svg-viewport.test.ts --maxWorkers=2
node --test frontend/design-client/src/svg-presentation.test.mjs frontend/design-client/src/import-ownership.test.mjs
./frontend/design-client/node_modules/.bin/tsc --noEmit --project frontend/design-client/tsconfig.json
python3 testing/verification-startup-imports/prepare-build-snapshot.py /tmp/design-startup-comparison-new
node testing/verification-startup-imports/compare-builds.mjs /tmp/design-startup-comparison-new
```

The build preparer requires a new directory, captures current other sources, and refuses unrelated changes to the importer. New unrelated app changes can alter absolute sizes; each pair still isolates this extraction. `compare-builds.mjs` writes build reports beside itself, so use a fresh evidence copy when retaining an earlier run. Dependencies must already be installed; scripts do not install anything or start a server.

`initial-focused-tests.*` retain the first three harness failures: two inputs assumed valid were already rejected identically by the old and new parser, and a source regex matched a comment. These expectations were corrected. There were no old/new parser differences and no product-code changes needed. Final results are `focused-tests.*`, `import-contracts.log`, `typecheck.log`, `build-graph.*.json`, `build-summary.json`, and `summary.json`.
