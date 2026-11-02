# UI / ops / locale / tabs / export — 2026-11-02

Parallel to the zoom-tile / VRAM track. This increment does not change the rasterizer, navigation tiles, GPU budgets, or sampling.

## What changed

- Header language control switches `zh-CN` and `en` through the existing interface preference. The blue accent (`--workspace-accent`) stays. Chinese copy remains the default.
- Rectangle, ellipse, polygon, frame, and sticky/whiteboard creation tools stay armed after a successful create. Pen completion, Escape, and text edit still return to the select tool.
- Workspace tabs can be clicked while a file operation owns the editor. The click is queued and applied when that operation releases the editor.
- `workspace-open` no longer takes the desktop file-operation lock, so an in-progress import/open dialog or write does not reject a tab read with `Another file operation is in progress`.
- Documents already opened in the session are cached (at most 8, keyed by id and revision). If a later read is still `BUSY` or `WORKSPACE_BUSY` and the cache matches the last known head, the tab switches to that copy and refreshes quietly when the lock is free. A missing or stale cache does not replace the current canvas with the English lock error; it retries a few times, then asks the user to try again.
- The export panel labels follow the interface language. PNG copy states that export writes an sRGB chunk; JPEG, WebP, and PDF stay sRGB and the export path rejects a non-sRGB color output for those formats. This panel does not encode FFmpeg, MP4, or WebM.

## Retest

Local `dev` WASM was built only so vitest could import the kernel. It is gitignored and is not a rendering acceptance build.

Passed, 2026-11-02, vitest 5:

- `workspace-tab-cache.test.ts` (2)
- `shape-creation.test.ts` (30)
- `document-switch-ownership.test.ts` (12)
- `workspace-session.test.ts` (26)
- `ExportPanel.options.test.tsx` (1)
- `electron-local-board-review-picker-next.test.tsx` and `electron-freehand-board-connector-next.test.tsx` (21)
- `desktop-session.test.ts` and `desktop-json-admission.test.ts` (green in the same vitest run as the board files)

Not run: hardware GPU, whole-editor latency, 33 ms / 100 ms, full G2/G5, packaged Electron click-through, or the desktop `main.test.mjs` host suite. `workspace-open` skipping the file lock is covered by the session cache tests and the host registration, not by a live Electron dialog.
