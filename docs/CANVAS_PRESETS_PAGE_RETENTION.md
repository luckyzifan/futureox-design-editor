# Logical sizing, frame presets and page-display retention

## Included UI behavior

Selection size labels now preserve fractional logical design units rather than rounding everything to integers. The same display-only formatter is used by the ordinary SVG and resident-overlay paths, with up to twelve significant digits. It does not round or rewrite authored geometry, change resize math, or report physical/DPR raster pixels. Existing single/group/multiselection unit conventions remain unchanged.

The region-tool menu opens a categorized, searchable device/frame preset panel with 32 reference sizes, orientation switching and custom dimensions. These are logical design-canvas dimensions transcribed from the supplied reference, not current hardware specifications, screen emulation or a complete device catalog. Creation uses normal editable top-level frames and one undo transaction. Placement includes hidden/locked existing geometry and rejects invalid/cyclic/multiply-parented hierarchy rather than guessing. Iterative traversal avoids imported hierarchy call-stack exhaustion. Pending edits and interaction ownership remain guarded. Only numeric comparison/outcome telemetry is emitted, not preset names or authored content.

## Page-display retention

Settings exposes conservative, balanced and expanded inactive-page retention tiers: 32/96/192 MiB estimated inactive allowance and 3/8/16 inactive pages. The estimated surface total remains capped at 512 MiB; active viewport planning quality and the renderer working-set limits are not enlarged.

Ordinary unchanged A→B→A navigation can reuse original completed tile objects and serials. Shared typed-array buffers and GPU/bitmap handles are accounted by identity; per-eviction union pressure is recalculated after each actual LRU victim. Releasing one alias does not destroy a handle still owned by the active page, an inactive retained page or interaction output. The final known owner retires it once.

These values are estimates of display surface payload, not measured whole-process memory or total VRAM. They exclude browser/driver/mip overhead and pending physical destruction. Increasing the tier may retain more inactive display data; it is not a globally coordinated GPU memory manager.

Any authored edit conservatively clears inactive-page cache state. Edited, first-opened and evicted pages still render. There is no selective per-page edit invalidation or promise that all page switches avoid work.

## Local import and operation contracts

UI imports explicitly adopt a new local document identity without changing authored content; MCP import operations retain their existing append semantics. Trusted user/automation provenance reaches native edit history without changing grants or undo policy. Generated operation coverage records current descriptors and unsupported boundaries, not a claim that every UI operation has been implemented or externally accepted. See IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md and OPERATION_COVERAGE_V1.json. No backend, authentication provider or network collaboration was added.

## Verification and remaining scope

Combined validation passes 54 suites / 478 tests, including precision/blue-box mounted gestures, preset creation/traversal, page A→B→A, active/interaction shared handles, per-eviction union pressure and existing admission/performance regressions. The local-contract reproduction additionally passes 14 suites / 172 tests, with one existing optional real-Sketch fixture test skipped because that input was not provided. Its generated operation coverage matches exactly. These suite counts overlap and should not be added together. Full TypeScript checking passes. Production Vite compilation/minification is checked with public-directory copying disabled to avoid duplicating unchanged generated kernel assets; this is not a fresh Rust/WASM build or a new native install.

Mounted fixtures and source contracts do not prove live Web/Electron visual layout, actual GPU pixel fidelity, device FPS or an end-to-end memory/latency improvement. Home-page redesign, transactional color picker, modern layout schema, full MCP/import/collaboration semantics and Nomi2 remain separate. Earlier operation-diagnostic coverage gaps remain documented.
