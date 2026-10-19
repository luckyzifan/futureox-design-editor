# Canvas scene snapshot reuse: implementation notes

This is a Canvas-only optimization. Global scene(), kernel bounds arithmetic, SpatialIndex cell sizing/order, and Editor transaction/publication behavior are unchanged.

## Ownership and immutability

Editor documents are immutable by publication contract, not runtime freezing. Editor.change uses Immer copy-on-write, Editor.preview clones the map and changed nodes, component override capture clones affected component records, and history/load publish new snapshots. Existing Editor.pickContext already relies on the same contract. The new code must not be applied to mutable drafts or arbitrary mutable caller documents.

CanvasSceneSnapshots keeps only its current and displayed full scene/index owners, plus a scalar-only refine overview. Each slot is replaced rather than accumulated. There is no WeakMap/history cache, LRU, incremental scene, or retained third refine scene. Session/editor/page/readiness changes clear the slots. No valid document is refused or simplified for cache admission; owner-bounded full scene retention matches the old current/displayed useMemo retention. A failed new scene/index build is not published as a usable partial value.

Keys compare exact document identity and nodes/pages/fonts guards, page ID and the picking resource epoch. Every new preview gets a fresh document key despite unchanged Editor.state.version. The epoch is an opaque object without font/document references. It advances after successful picking initialization, document-font installation, PDF font installation and PDF load_document. Rust font/document resource installation is staged atomically on failure; rejected loads preserve the epoch.

Returned Canvas entries are readonly at the array interface; geometry.ts's global API is unchanged. The only downstream signature changes are readonly array inputs to worldGuides and CanvasScrollbars. Query/filter operations allocate before sorting/reversing. Tests deep-freeze published documents and complete SceneEntry graphs, and exercise overview, index queries and Editor hit/hover consumers.

## Limits

The existing picking engine has a global font environment. Resource epochs prevent reuse across a switch but do not choose/activate fonts for a requested old document. That existing behavior is not changed or claimed fixed here. Exact comparisons use the same active environment as uncached scene(), with explicit activation in font-switch tests.

The change removes duplicate derivation of the same active immutable snapshot. It does not make new preview layout, node-map copying, component resolution or scene geometry incremental. No GPU, browser, frame-rate, image-quality or input-to-display measurements are claimed.

## Reproducibility

Baseline Canvas fixture is byte-for-byte from delivered ZIP SHA-256 02241e7467435d4e47a79041d0fccfea234c52d1b3a3b0e46eaa8f781ff1bafb. Geometry/picking baseline files absent from the increment are taken from Git base 71d32153e6f55b3723c99708b4c4c49ac7342e67. baseline-identity.json records exact hashes. The baseline Vitest loader reads the original Canvas source in its original module location, verifies its SHA-256, and leaves production relative imports unchanged.

The already-installed dependencies and portable WASM SHA-256 2c50f87de40b6e2ecc456eb053706d4e2c3c058da82aafffd1b191eddd8b039a are used. Real font tests use the shipped deterministic font-test-fixtures helper and baseline Noto font, writing only its declared external temporary cache. No product assets, repositories, dependencies or binaries are rebuilt or downloaded.
