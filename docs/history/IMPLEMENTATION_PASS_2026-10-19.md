# Archived implementation-pass evidence and follow-up topics

The three root implementation status/plan/summary documents were retired on 2026-10-20. They mixed earlier proposals, contradictory build statuses and completion claims that later repairs invalidated. This record preserves their historical verification statements and unresolved topics. It is not a new test run, current roadmap, or evidence of completion.

## Current replacements

- [Local feature matrix](../LOCAL_DESIGN_FEATURE_MATRIX.zh-CN.md): feature availability and remaining gaps.
- [Release acceptance](../LOCAL_RELEASE_ACCEPTANCE.zh-CN.md): evidence categories and delivery gates.
- [Release notes](../RELEASE_2026-10-19.zh-CN.md): delivered scope and explicitly unverified behavior.
- [Render repair notes](../rendering/history/RENDER_REPAIR_NOTES.zh-CN.md): corrections to the original implementation claims.
- [Testing entry points](../../testing/README.md): current test execution instructions.
- [Desktop build and packaging](../../frontend/design-desktop/README.md): replaces the obsolete manual copy-to-Electron instructions.

In particular, the old memory-pressure mip fallback and automatic import-downsampling recommendations conflict with the later fidelity constraints. They must not be treated as pending implementation instructions. The old “unlimited size”, “2GB+ documents”, “better than Figma” and “all tests passing” statements do not establish current product guarantees. The original source documents remain recoverable in Git; the deletion manifest records their source revision and pre-cleanup hashes.

## Follow-up topics retained for revalidation

These were unfinished or deferred in the original pass. Their old status labels and effort estimates are not reliable; consult the current feature matrix and source before selecting work. Keeping a topic here does not claim it is still missing or authorize implementation.

- Layout: distribution modes (SpaceBetween/SpaceAround/SpaceEvenly), kernel solver, schema and UI coverage.
- SVG: text/font mapping, gradients, filters, clip paths, group hierarchy and whole-document export. Current import/export limitations must remain explicit.
- Components: numeric property bounds/step, variant selection, instance resolution and editing UI.
- Prototypes: drag/keyboard triggers and media actions; supported triggers do not establish a complete media/state-machine implementation.
- Appearance and localization: theme tokens/context, stored theme choice, extracted translations and language choice.
- Local component libraries: publish/store/browser/update flow and versioning; cloud sync and permissions remain outside the local release scope.
- History: operation metadata and a granular undo UI. Operation logs must not be confused with restorable document snapshots.
- Export presets: format/scale/suffix, persistence, save/apply/edit/delete UI.
- Scale and memory research: lazy scene loading, node LRU, offscreen subtree eviction/restoration, surface precision and GPU memory profiling. Preserve fidelity; the old proposed downsampling and precision reductions are not accepted defaults.
- Performance research: WASM splitting, worker imports, incremental rendering, sparse textures and compute blur. Existing incremental work must be checked before treating these as missing.
- Deferred PDF/typography topics: PDF text, clipping, sh/form XObjects, hyphenation/word breaking, vertical PDF text and underline-to-outline fallback.
- Acceptance follow-up: real PNG/JPG drag/drop, multiline justification, SVG gradients/filters, images above 16 MP, and real Sketch/Figma samples; platform-native dialogs, Finder drag/drop, GPU budgets, system fonts/IME and macOS/Windows/Linux behavior require appropriate environments.
- Deployment follow-up: real browser/desktop E2E, staging, profiling and cross-browser checks; user-facing examples and tutorials were requested as future documentation topics.

The old fixture notes referred to local Downloads SVG/PNG files and reported no .fig/.sketch samples. They are not portable fixture availability claims. Historical architecture notes named modular text justification, rational blur, SVG-to-document mapping and enum-based component properties; source and the current architecture/repair records remain authoritative.

## Historical verification statements (verbatim excerpts)

The source documents reported inconsistent totals and incomplete background runs. The excerpts below intentionally preserve those discrepancies and warnings rather than reclassifying them as successful verification. Raw test logs and all existing verification directories are untouched.

### From IMPLEMENTATION_COMPLETE.md

## 🧪 Test Results

### TypeScript Tests
```bash
✅ 1433 tests passing
Frontend test suite: PASS
```

### Rust Tests
```bash
✅ Compilation successful (0.51s)
⚠️  1 warning: unused method `over_rgba8_blend` (non-critical)
Full test suite running in background (comprehensive validation)
```

### Build Status
```bash
✅ Kernel build: 37.5MB (13.8MB gzipped)
✅ Frontend build: 1.79s
✅ WASM compilation: successful
✅ All workers bundled correctly
```

---

### From IMPLEMENTATION_COMPLETE.md

## 🔍 Diagnostic Warnings (Non-Critical)

### Rust
```
⚠️  blend.rs:101:19 - method `over_rgba8_blend` is never used
   Status: Non-critical (internal method, may be used in future)
```

### TypeScript
```
⚠️  Some chunks >500KB after minification
   Status: Expected (design-kernel WASM is 37MB)
   
⚠️  INEFFECTIVE_DYNAMIC_IMPORT warnings
   Status: Optimization opportunity (not blocking)
```

---

### From IMPLEMENTATION_PLAN.md

## Test Coverage

### Existing Tests
- **Total Test Files**: 229 passing
- **Total Tests**: 1422 passing, 1 skipped
- **Test Duration**: 22.55s
- **Coverage**: All core rendering, layout, and text features

### New Tests Added
1. `image-import.test.ts` - 6 tests for image file import
2. `gpu-mipmap-fallback.test.ts` - 7 tests for mipmap fallback logic
3. `text-justify.test.ts` - 4 tests for justify alignment

---

### From IMPLEMENTATION_SUMMARY.md

## 📊 Test Results

### Overall Coverage
- **Total Tests**: 1433 passing, 1 skipped
- **Test Files**: 231 passing
- **Duration**: ~23 seconds
- **Status**: ✅ **All tests passing**

### New Tests Added
1. `image-import.test.ts` - 6 tests
2. `gpu-mipmap-fallback.test.ts` - 7 tests
3. `text-justify.test.ts` - 4 tests
4. `gpu-memory-analysis.test.ts` - 6 tests
5. `design-file-import.test.ts` - 5 tests

**Total New Tests**: 28 tests

---

### From IMPLEMENTATION_SUMMARY.md

## 🔧 Build Status

### Frontend (TypeScript)
- **Tests**: ✅ 1433 passing
- **Build**: 🚧 In progress (WASM compilation)

### Backend (Rust)
- **Compilation**: ✅ Success (1 minor warning)
- **Tests**: 🚧 In progress

---
