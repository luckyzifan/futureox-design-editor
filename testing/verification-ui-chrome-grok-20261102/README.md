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

# UI chrome, warm surfaces — 2026-11-02

Desktop and browser share `frontend/design-client`. This pass changes chrome surfaces, type, and selection name/size chips. It does not change the rasterizer, navigation tiles, GPU budgets, sampling, document history strings, or the blue accent.

## Before

- Neutrals were cool gray: canvas `#f1f2f4`, text `#262a31`, muted `#666e79`, borders `#e2e5e9`, fields `#f5f6f8`.
- Panels, the left tool rail, and dialogs used tight 6–12px corners, cool shadows, and a 3px scrim.
- Menu rows highlighted with a solid accent fill. The floating tool bar nudged 1px on press.
- Empty inspector, library, variables, and source lists were plain muted text.
- A selected shape’s name and W×H read as bare `#0d99ff` text. The selection stroke stayed `#0d99ff`. The product accent stayed `#3459d4`.

## After

- Neutrals are warm paper. Canvas `#f3eee6`, panel `#fffcf9`, text `#1c1917`, muted `#746c64`, border `#e6dfd4`, field `#f6f1ea`, hover `#f4efe8`. Selected rows stay a blue wash `#e7eefb`.
- Accent and accent hover are unchanged: `#3459d4` and `#2747b6`. Primary buttons stay that blue.
- The tool rail uses 12px buttons. The pressed tool is the blue wash with a hairline accent ring, not a solid fill.
- Panels, search, and number fields use 8px corners. Dialogs, settings, batch rename, plugins, frame presets, the shape builder, and the animation player use an 18px radius, a warm shadow, and a `#1c191752` scrim with a 10px blur.
- Menus and the context menu rest on a warm hover. Checked rows keep the accent. Destructive context rows keep the danger color.
- Empty states (inspector, library, variables, local home, source list) sit on a soft field with a short title. Existing 中文 / English catalogs are unchanged; no new user-facing strings.
- Selection name and size chips draw a warm paper pill in the DOM and in the GPU label raster. Stroke, handles, and label color stay `#0d99ff`. Overlay UI identity prefix moves from 2 to 3 so an older GPU label cannot cover the chip.
- Motion on chrome controls is 160ms `cubic-bezier(0.2, 0, 0, 1)`. Panel entrance stays a 4px slide at full opacity, 140ms. Reduced motion still collapses it.

## Retest

Passed, 2026-11-02, vitest 5, Linux, with the suite setup file skipped because this environment has no built kernel:

- `src/chrome-surface.test.ts`
- `src/adaptive-panels.test.tsx`

16 passed. The CSS contract still requires `animation: panel-enter-left 140ms ease-out` and rejects an opacity-0 panel entrance. The new test checks the accent tokens and that a single rectangle’s name and size labels are `frame: 'pill'` in `#0d99ff`, while the parent frame title stays `#73778b` without a pill.

Headless Chrome screenshots of the production stylesheets on the editor chrome markup (rail, layers, empty inspector, dialog, settings, variables, selection chips) are `chrome-before.png` and `chrome-after.png`. They are not a packaged Electron session and not a GPU pixel capture.

Not run: hardware GPU, packaged Electron click-through, 33 ms / 100 ms, full G2/G5, or the desktop host suite. The dev WASM kernel was not built here.

## Still open

- File-menu bodies, many inspector sections, and prototype copy stay Chinese when English is selected, as in the previous chrome pass.
- The creation toolbar stays along the bottom of the canvas. This pass softens it; it does not move it to the left rail.
- Canvas selection blue remains `#0d99ff` so existing outline checks keep matching.
- No claim that chrome motion meets 33/100ms or full G2/G5.
