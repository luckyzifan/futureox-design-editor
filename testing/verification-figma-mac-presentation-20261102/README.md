# Mac desktop Figma presentation — 2026-11-02

Web and Electron share `frontend/design-client`. This increment does not change the rasterizer, navigation tiles, GPU budgets, sampling, or document history strings.

## Before

- A rectangle, frame, or section always showed four corner fields. The canvas had a vertex-radius handle for polygons and stars, and no per-corner handle for rectangles or frames.
- Glass controls were a flat grid ordered depth, bevel, refraction, dispersion, light angle, light intensity. Multi-selection also exposed glass opacity and amount, which the modern glass material does not use.
- Pages were a numbered list. Nested frames hid their names until selected. Sections used the same floating label as frames. A frame with no visible fill had no canvas boundary.

## After

- Equal corner radii use one Corner radius field. Independent corners expands to top-left, top-right, bottom-left, and bottom-right. Corner smoothing stays available once any radius or smoothing is non-zero. A selected rectangle, frame, or section shows a canvas handle. Dragging sets every corner; Option/Alt changes the dragged corner; Shift rounds. The plugin host exposes `topLeftRadius`, `topRightRadius`, `bottomRightRadius`, `bottomLeftRadius`, and `cornerSmoothing` on rectangles, frames, and sections.
- Glass reads frost, refraction, depth, dispersion, light angle, light intensity, then bevel width. The glass group uses a light accent-tinted panel. The effect name is 玻璃 / Glass. The product accent stays `#3459d4`. Canvas selection and frame titles stay `#0d99ff`.
- The page list header is the current page and can collapse. Page rows are names, without a numeric prefix. Direct child frames and sections show their names while the parent is selected. Section names sit on a chip filled from the section’s solid paint. Frames with no visible fill draw a hairline on the canvas overlay, not in the exported pixels.

## Retest

Local vitest 5, Linux, dev WASM (not a rendering acceptance build). `tsc --noEmit` passed.

Passed:

- `corner-radius.test.ts`, `page-frame-chrome.test.ts`, `property-units.test.tsx`, `plugins/plugin-host.test.ts`, `selection-chrome-label.test.ts`, `canvas-block-interaction.test.tsx` (38 passed)
- `canvas-event-batching.test.tsx`, `canvas-overlay-ui-ownership.mounted.test.tsx`, `adaptive-panels.test.tsx`

`canvas-overlay-capture-chain.test.tsx` still fails two constrained-frame capture assertions (`editor.state.doc` is not the rotated preview). The same mismatch happens on the unmodified canvas with this dev kernel, so it is not a regression from the chrome change.

Not run: hardware GPU, packaged Electron click-through, a full browser click-through of the running app, 33 ms / 100 ms, full G2/G5.

## Still open

- Glass pixels stay on the existing distance-field and analytic paths. This pass does not retune refraction, dispersion, or bevel to a Figma reference image.
- The toolbar stays on the bottom. Figma’s current app uses a left tool rail.
- Canvas selection blue remains `#0d99ff` so existing outline checks keep matching. Chrome accent remains `#3459d4`.
- No claim that corner drags, page switching, or panel layout meet 33/100ms or full G2/G5.
