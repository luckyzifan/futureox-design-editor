# Shared chrome polish — 2026-11-02

Web and Electron use the same `design-client` shell. This pass does not change raster, tiles, GPU budgets, sampling, or document history strings. It is not a 33 ms / 100 ms or full G2/G5 result.

## What changed

- Soft surfaces, the existing blue accent `#3459d4`, and bilingual loading copy for kernel boot, file open, import, and an empty ready canvas.
- New interactions default to a 300 ms ease-out with no slide style, so the existing kernel animation plan can run a short smart-animate sample. Hotspot opacity fades with a compositor transition. No extra timers were added; the player still uses its one animation frame while a transition is in progress.
- Panel and dialog overflow uses thin overlay scrollbars. The canvas keeps its own thumbs, drawn thinner and in the same gray.
- Width bands are shared: `≤900` narrow overlay, `901–1180` desk (Electron’s 1000 px minimum sits here), `≥1181` wide. JavaScript reads the same media queries as CSS and falls back to `innerWidth` only when those queries do not match.
- The app mark is a white F on an indigo squircle, used by the web favicon and the Electron window icon. Toolbar and file-type icons are local SVGs in the accent color.

## Checks

Passed on Linux, 2026-11-02:

- `vitest run` with a setup-free config: `chrome-polish.test.ts`, `adaptive-panels.test.tsx`, `SourceDocumentStatus.test.tsx` (20 passed). The default Vitest setup needs the gitignored dev WASM, which was not built.
- `node --test frontend/design-desktop/test/branding.test.mjs` and `window-state.test.mjs` (12 passed).
- A static shell fixture was opened in headless Chrome at 1440×900 and 1000×720. That fixture is not the live editor: the WASM kernel was not built, so canvas pixels, file open, and Electron packaging were not exercised.

`settings-entry.test.mjs` still fails one pre-existing assertion that looks for a literal `<span>设置</span>` on the settings button. The button already uses `panelText.settingsTitle`. The compact-header and 1000 px window contracts in that file passed.

## Still open

- Mod+Shift+N remains the Sketch desktop shortcut. The page list and `editor.addPage` are already shared.
- Many inspector and file-menu strings stay Chinese when English is selected.
- Smart animate still depends on the kernel plan sampler. A 300 ms default does not make large documents animate inside 33 ms.
- No claim that this chrome work meets 33/100 ms or full G2/G5.
