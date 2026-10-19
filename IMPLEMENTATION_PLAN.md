# Design Kernel - Feature Implementation Plan

## Overview
This document tracks the implementation status of missing features compared to Figma/Sketch, plus critical performance optimizations for large documents.

## Implementation Status

### ✅ **Completed Features**

#### 1. Image File Import (Priority 1)
**Status**: DONE ✅
**Implementation**: 
- Added PNG/JPG/JPEG/WEBP support to file drop and open dialog
- Created `importImageFiles` function in App.tsx
- Places images as rectangle nodes with image fills
- Centers images in viewport with 20px vertical spacing for multiple imports
- **Files Modified**: `frontend/design-client/src/App.tsx`
- **Tests**: `frontend/design-client/src/__tests__/image-import.test.ts` (6 tests, all passing)

#### 2. GPU Mipmap Fallback (Priority 1 - Critical for Stability)
**Status**: DONE ✅
**Implementation**:
- Changed hard error on >16M pixels at level 0 to mipmap level fallback
- Allows graceful degradation for large images (≥1600% zoom退一级 mipmap)
- Prevents GPU memory exhaustion crashes
- **Figma-aligned**: Follows "original resolution is clarity ceiling" semantics
- **Files Modified**: `frontend/design-client/src/kernel/gpu/renderer.ts:1045`
- **Tests**: `frontend/design-client/src/__tests__/gpu-mipmap-fallback.test.ts` (7 tests, all passing)

#### 3. Text Justify Alignment (Priority 2)
**Status**: DONE ✅
**Implementation**:
- Removed validation rejection for `align: "justify"` in text nodes
- Schema already supported justify, just needed validation fix
- **Files Modified**: `frontend/design-client/src/kernel/text.ts:245`
- **Tests**: `frontend/design-client/src/__tests__/text-justify.test.ts` (4 tests, all passing)

---

### 🚧 **Planned Features** (By Priority)

#### 4. Auto-Layout Distribution Modes (Priority 2)
**Current Gap**: SpaceBetween/SpaceAround/SpaceEvenly rejected in layout validation (layout.rs:122-134)
**Implementation Plan**:
- **Backend** (Rust):
  - Add `Distribution` enum to `design-studio/crates/design-kernel/src/layout.rs`
  - Implement spacing calculation for each distribution mode
  - Update auto-layout solver to apply distribution
- **Frontend** (TypeScript):
  - Add distribution UI controls to auto-layout panel
  - Update schema validation to accept distribution modes
- **Estimated Effort**: 4-6 hours
- **Figma Equivalent**: "Packed" vs "Space Between" toggle

#### 5. SVG Document Import/Export (Priority 2)
**Current Gap**: Only node-level path-data export; import-svg.ts only parses paths
**Implementation Plan**:
- **Import** (frontend/design-client/src/import-svg.ts):
  - Parse `<text>` → text nodes with font mapping
  - Parse `<linearGradient>` / `<radialGradient>` → gradient fills
  - Parse `<filter>` → effects (blur, shadow)
  - Parse `<clipPath>` → clip masks
  - Handle nested groups → frame hierarchy
- **Export** (design-studio/crates/design-kernel/src/export.rs):
  - Add `export_svg_document` function
  - Serialize entire document tree to SVG
  - Map text nodes → `<text>` with proper font attributes
  - Map gradients → SVG gradient defs
  - Map effects → SVG filters
- **Estimated Effort**: 12-16 hours
- **Figma Equivalent**: "Export → SVG" (full document)

#### 6. Component Properties Extension (Priority 3)
**Current Gap**: Only text/boolean/instance-swap (components.rs:49)
**Implementation Plan**:
- **Backend**:
  - Add `PropertyType::Number` with min/max/step
  - Add `PropertyType::Variant` for component variant selection
  - Update component instance resolution to handle new types
- **Frontend**:
  - Add UI for number properties (slider + input)
  - Add variant dropdown in properties panel
  - Update component editor to define property types
- **Estimated Effort**: 6-8 hours
- **Figma Equivalent**: Component properties panel

#### 7. Prototype Interactions Extension (Priority 3)
**Current Gap**: Missing drag/keyboard triggers; no media actions (prototype.ts:247-250)
**Implementation Plan**:
- **Triggers**:
  - Add `onDrag` trigger type
  - Add `onKeyDown` / `onKeyUp` trigger types
  - Add keyboard key mapping configuration
- **Actions**:
  - Add `playVideo` / `pauseVideo` actions
  - Add `playAudio` / `pauseAudio` actions
  - Add video/audio embed support in renderer
- **Estimated Effort**: 8-10 hours
- **Figma Equivalent**: Prototype panel → "While dragging" trigger

#### 8. Dark Theme & i18n (Priority 4)
**Current Gap**: Only `color-scheme: light`; hardcoded Chinese strings
**Implementation Plan**:
- **Dark Theme**:
  - Add theme context provider
  - Duplicate CSS custom properties with dark mode values
  - Add theme toggle in app settings
  - Store preference in localStorage
- **Internationalization**:
  - Add `i18next` library
  - Extract all UI strings to translation files (en, zh-CN)
  - Add language switcher in app settings
- **Estimated Effort**: 6-8 hours
- **Figma Equivalent**: Settings → "Theme" and "Language"

#### 9. Shared Component Libraries (Priority 4)
**Current Gap**: LibraryVersion schema exists but no publish/sync
**Implementation Plan**:
- **Local Library** (Phase 1):
  - Add "Publish Library" action to file menu
  - Store published library files in `~/.design-kernel/libraries/`
  - Add library browser panel
  - Implement component sync (update all instances)
- **Team Library** (Phase 2 - Future):
  - Add cloud storage integration
  - Implement library versioning
  - Add permission management
- **Estimated Effort**: 12-16 hours (Phase 1 only)
- **Figma Equivalent**: Team Libraries

#### 10. Granular Undo Panel (Priority 5)
**Current Gap**: document-history.ts is snapshot-based, not step-level
**Implementation Plan**:
- Add operation log to document state
- Store operation metadata (timestamp, user, description)
- Build undo panel UI showing operation list
- Allow clicking any operation to jump to that state
- **Estimated Effort**: 4-6 hours
- **Figma Equivalent**: "Version history" panel

#### 11. Export Presets (Priority 5)
**Current Gap**: No preset management
**Implementation Plan**:
- Add export preset schema (format, scale, suffix)
- Store presets in document + user settings
- Add "+" button to save current export settings as preset
- Allow applying/editing/deleting presets
- **Estimated Effort**: 3-4 hours
- **Figma Equivalent**: Export section → "Save preset"

---

## 🎯 **Performance Optimizations**

### ✅ Mipmap Fallback (DONE)
**Impact**: Prevents crashes on large images at high zoom
**Implementation**: Allow退一级 mipmap when admission fails (renderer.ts:1045)

### 🚧 Planned Optimizations

#### A. Scene Graph Pagination (Priority 1 - Critical for Scale)
**Current Gap**: 32MB document hard limit; full BTreeMap in memory
**Figma Solution**: "Scenebook" paging system
**Implementation Plan**:
- **Phase 1**: Lazy node loading
  - Only load visible viewport nodes + ancestors
  - Implement node LRU cache with eviction
  - Add "load more" sentinel nodes
- **Phase 2**: Offscreen subtree eviction
  - Evict collapsed/hidden subtree children from memory
  - Reload on expand/show
  - Keep tile cache for fast restore
- **Estimated Effort**: 20-24 hours
- **Target**: Support 100k+ node documents

#### B. Import-Side Downsampling (Priority 2)
**Current Gap**: No max resolution limit on import
**Implementation Plan**:
- Add 8192px max dimension setting (configurable)
- Downsample images on import if >8192px
- Preserve original in document for future export
- Show downsampling notice in import dialog
- **Estimated Effort**: 4-6 hours
- **Target**: Cap per-image memory at 256MB (8192²×4 bytes RGBA8)

#### C. Selective Float Surfaces (Priority 2)
**Current Gap**: All rendering uses float surfaces
**Figma Solution**: RGBA8 for display path, float only for effects
**Implementation Plan**:
- Default to RGBA8 format for simple nodes
- Switch to float16/float32 only when needed:
  - Gaussian blur effects
  - Layer blend modes requiring HDR
  - Gradient mesh rendering
- **Estimated Effort**: 6-8 hours
- **Target**: 4x memory reduction for typical documents

---

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

## Next Steps

### Immediate (This Session)
1. ✅ Image file import
2. ✅ GPU mipmap fallback
3. ✅ Text justify alignment
4. 🚧 Test with real Sketch/Figma files from Downloads
5. 🚧 Profile GPU memory usage with large images
6. 🚧 Integrate into Electron app
7. 🚧 Integrate into web client

### Short Term (Next Sprint)
1. Implement auto-layout distribution modes
2. Add scene graph pagination (critical for scale)
3. Improve SVG import/export to handle full documents
4. Add dark theme support

### Medium Term (1-2 Months)
1. Component properties extension (number, variant)
2. Prototype interactions (drag, keyboard, media)
3. Shared component libraries (local first)
4. Performance optimizations (downsampling, selective float)

---

## Known Limitations

### PDF Import (Deferred - Listed in Original Requirements)
**Current Status**: Doesn't import text, drops clips, skips sh/form XObjects
**Rationale**: Documented technical debt with honest boundaries (pdf_import.rs header)
**Priority**: Low (focus on core features first)

### Typography Features (Deferred)
- Hyphenation/word breaking (pdf_export.rs limitation)
- Vertical text in PDF export
- Underline fallback to outline

---

## File Manifest

### Modified Files
1. `frontend/design-client/src/App.tsx` - Image import support
2. `frontend/design-client/src/kernel/gpu/renderer.ts` - Mipmap fallback
3. `frontend/design-client/src/kernel/text.ts` - Justify alignment validation
4. `frontend/design-client/src/kernel/layout.ts` - Auto-layout validation (ready for distribution)

### New Test Files
1. `frontend/design-client/src/__tests__/image-import.test.ts`
2. `frontend/design-client/src/__tests__/gpu-mipmap-fallback.test.ts`
3. `frontend/design-client/src/__tests__/text-justify.test.ts`

---

## Success Metrics

### Feature Completeness
- ✅ 3/11 features implemented (27%)
- 🎯 Target: 8/11 within 2 sprints (73%)

### Performance
- ✅ Large image crashes: FIXED (mipmap fallback)
- 🎯 Document scale: Target 100k nodes (currently ~10k max)
- 🎯 Memory per image: Target 64MB (Figma parity)

### Quality
- ✅ All tests passing (1422/1423)
- ✅ No regressions in existing features
- 🎯 Maintain >95% test pass rate
