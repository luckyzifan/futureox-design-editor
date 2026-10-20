# Three-family document regression

Run from `frontend/design-client`:

    MULTIFONT_EVIDENCE=/tmp/core-multifont-evidence ./node_modules/.bin/vitest run src/automation/multifont-e2e.test.ts src/FontManagementPanel.test.tsx src/font-management.test.ts src/text-face-reuse.test.ts --maxWorkers=1

Requires the existing built WASM and Python with fontTools (the repository pins 4.61.1 in `testing/font-fixtures-requirements.txt`). The test never installs packages, downloads fonts, or scans system fonts. It generates three tiny original synthetic families using `testing/generate-multifont-fixtures.py`; their geometric outlines and metadata are dedicated under CC0-1.0. Font bytes and rendered artifacts are generated outside the checkout. These are test faces, not substitutes for typographically complete production fonts.

The new test traverses the real MCP server over in-memory NDJSON streams, the shared operation API, Editor, and native WASM. It verifies import, duplicate/corrupt rejection, explicit family/settings selection, two pages, per-run mixed faces, Chinese/Greek fallback, actual different advances, nonblank CPU raster pixels, native FD save/reopen with identical pixels, native SVG export, and atomic document replacement plus one undo. Font-loading instrumentation asserts camera changes, page switches and a targeted setting change do not reload document font resources.

The companion suites cover real DOM font upload/settings, invalid drafts, stale selection/reopen reads, close/reselect out-of-order completion, final async mutation fences, missing-font degradation, 1,000-layer bounded replacement, and document preservation. Their desktop-font boundary is a controlled adapter; no real native system-font scan, GUI, GPU, browser screenshot, OS socket, or production font-license permission is claimed. Embedding permission flags do not independently grant redistribution rights.

Outputs: `report.json`, `multifont.fd`, `page-1.png`, `page-2.png`, `page-1.svg`, and synthetic font manifest/files. The report records native glyph IDs, selected font IDs, actual advances, ink-pixel counts, and replacement work counts.
