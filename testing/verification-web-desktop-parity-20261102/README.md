# Web and desktop parity — 2026-11-02

The Vite web app and Electron both load `frontend/design-client`. Canvas edits go through `Editor` and the Rust/WASM kernel (hit testing, pixel snap, Sketch import, PNG encode). This pass does not add a web-only document model, and it does not change raster tiles, GPU budgets, or experimental flags.

## What now matches

- Selection chrome: a single non-frame selection shows its name in `#0d99ff` above the box. Selecting a frame or section turns that title blue instead of adding a second name. The W×H chip rounds to two decimal places. Inspector metrics stay exact. Rotate corners show a screen-space handle. The SVG `<title>设计画布</title>` tooltip is gone.
- Create tools: rectangle, ellipse, polygon, star, frame, and section clicks are 100×100. Drags still use the pointer span. The fill (or line stroke) is drawn on pointerdown and stays until that document is the presented frame. Shape tools stay armed. A hint above the toolbar states drag, click, Shift, and Alt.
- Drag: an already selected layer keeps the drag. Overlapping text is selected only on a click that does not pass the drag threshold. Thin bars stay grabbable inside an 8px screen slop. The hit itself still comes from the kernel.
- Zoom: the percentage reads the parked wheel camera, so it does not wait for the next committed frame. When the properties panel is closed, the control sticks to the canvas at the lower left, above the toolbar.
- Locale: the header language control still switches `zh-CN` and `en`. The file menu, save/export labels, properties tab list, and Design API launcher follow that switch. Chinese remains the default. The blue accent stays `#3459d4` (`--workspace-accent`). Canvas selection blue stays `#0d99ff`.
- Open: the web file input accepts `.fd`, `.json`, `.svg`, `.svgz`, `.fig`, `.sketch`, `.pdf`, and images. `.sketch` and `.pdf` decode with the same WASM entry Electron’s worker uses (`import_sketch_json`, `import_pdf_json`). `.fig` uses the shared `importFig` worker path, which is also what Electron uses for a normal open.
- Export PNG: the shared export panel writes an sRGB PNG through the kernel encoder and says so in both languages.
- Design API: the header button is **设计 API / Design API**. On the web it runs the shared editing API. It is not a Figma plugin host.

## Desktop-only by design

- Native Sketch inspect/edit session and the large JSON/Sketch workspace.
- `window.coreDesktop`: system font list, native preparation sidecar, opt-in native render probe, workspace SQLite, and the external MCP socket.
- Higher GPU working-set fraction in Electron (`kernel/gpu/adaptive-budget.ts`).
- OS menus, save dialogs, and sandboxed plugin UI windows. The in-app Design API is available on the web; connecting an outside MCP client is not.

## Still open

- Much of the inspector, prototype copy, and error logs stay Chinese when English is selected.
- The toolbar stays on the bottom. Figma’s current app uses a left tool rail.
- Browser FIG import is still the shared TypeScript reader, not `import_fig_native`. The native reader is an extra desktop entry and is not exported to WASM. `stackReverseZIndex`, variables, and several node kinds remain a browser/native split.
- Display P3 is not the default PNG. 33/100ms and full G2/G5 were not run.

## Retest

Local `dev` WASM, when built, is only so vitest can import the kernel. It is gitignored and is not a rendering acceptance build.

Not a claim of hardware GPU, packaged Electron click-through, or whole-editor latency.
