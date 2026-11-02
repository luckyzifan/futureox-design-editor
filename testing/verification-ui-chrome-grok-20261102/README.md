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
