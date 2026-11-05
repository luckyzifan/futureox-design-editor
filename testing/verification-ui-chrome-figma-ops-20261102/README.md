# UI chrome / Figma ops — 2026-11-02

Desktop and browser share `frontend/design-client`. This increment does not change the rasterizer, navigation tiles, GPU budgets, sampling, or document history strings.

## Before

- Opening the layers or properties panel replayed a 140ms fade that started at opacity 0, so the chrome was invisible for the start of every reopen.
- A selected shape had a blue box and size label, but not the layer name Figma draws above the box. A selected frame title stayed gray (`#73778b`).
- Shape creation used a dashed rubber-band. Figma’s live creation outline is a solid selection stroke; the click / Shift / Alt contract already matched and was left in place.
- The armed creation tool had no modifier hint. The comments tool used a text glyph and did not take the selected-tool style.
- Selected layer rows used `#0071c2` instead of the product accent `#3459d4`. The active tool was a solid accent fill.
- Layers search, page actions, the document name, the file-menu button, and the properties tabs stayed Chinese when the interface language was English. Chinese remains the default, and those Chinese strings are unchanged.

## After

- Panel entrance is a 4px slide at full opacity. The animation name and 140ms duration stay so existing CSS contracts still match. Reduced-motion preferences still collapse the duration.
- Single selection of a shape, text, or group draws its name in `#0d99ff` above the box, in both the DOM and the GPU overlay label list. Selecting a frame or section turns that existing title `#0d99ff` instead of adding a second name. Multi-select and vector/pencil/brush/marker/width tools do not add a name. Renaming changes the overlay UI identity, so an older GPU label cannot cover the new name. The name moves and hides with the rest of the selection chrome during a drag.
- Creation rubber-band for shape tools is a solid `#0d99ff` stroke. Marquee and zoom are unchanged. Rectangle, ellipse, polygon, star, frame, section, slice, line, and arrow show a pill above the toolbar while the tool is armed and no gesture is active: drag, click-for-default, Shift, Alt. The pill uses the current accent and hides as soon as `editor.begin` opens the gesture.
- Active toolbar tools use the accent on `--workspace-selected`, not a solid fill. Primary buttons stay solid `#3459d4`. Design / Prototype is an accent underline. Auto-layout direction uses the accent. Selected layer rows use `--workspace-accent`.
- Tool menus estimate a position from the trigger before measurement, so the first frame is not parked at 0,0. Layout still corrects the final box before paint.
- Layers, the document title, the file-menu button name, workspace actions, collapse/expand, and the properties tablist follow `zh-CN` / `en`. History labels such as `重命名图层` stay Chinese.

## Retest

Local `dev` WASM was built only so vitest could import the kernel. It is gitignored and is not a rendering acceptance build.

Passed, 2026-11-02, vitest 5, Linux:

- `selection-chrome-label.test.ts`, `adaptive-panels.test.tsx`, `canvas-move-feedback.test.ts`, `shape-creation.test.ts`, `Layers.navigation.test.tsx`, `electron-canvas-locale-repair.test.tsx`, `canvas-event-batching.test.tsx` (99 passed, 1 skipped)
- `canvas-overlay-ui-ownership.mounted.test.tsx`, `canvas-block-interaction.test.tsx`, `app-operation-flows.test.tsx`, `kernel/gpu/canvas-overlay.test.ts`, `kernel/release-overlay-ownership.integration.test.tsx` (59 passed)

Not run: hardware GPU, packaged Electron click-through, 33 ms / 100 ms, full G2/G5, or the desktop `main.test.mjs` host suite.

## Still open

- File-menu item bodies, many inspector sections, prototype copy, and error logs are still Chinese when English is selected.
- The toolbar stays on the bottom. Figma’s current app uses a left tool rail; this pass did not move it.
- Tooltips still wait 450ms. That is tooltip delay, not panel chrome.
- Canvas selection blue remains `#0d99ff` so existing outline checks keep matching. Chrome accent remains `#3459d4`.
- No claim that create, select, or panel motion meets 33/100ms or full G2/G5.
