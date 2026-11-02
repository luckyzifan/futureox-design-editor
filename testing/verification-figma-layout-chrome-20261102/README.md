# Figma Mac layout chrome — 2026-11-02

Web and Electron share `frontend/design-client` and the same Rust/WASM layout pass. This increment does not change the rasterizer, navigation tiles, GPU budgets, sampling, glass shader, or corner-flattening math.

## Before

- Option/Alt spacing drew an edge-offset on an axis where the boxes already overlapped, and the red segment had no end ticks. The number sat off the midpoint.
- Union, subtract, intersect, and exclude were inserted at the back-most selected sibling and were rejected when the immediate parent used auto layout. Operand fill/hug sizing was left on a group that is not itself auto layout.
- Rectangle, frame, and section corners always showed four fields. Glass was labeled as refraction and listed depth before the light controls.
- Page rows still used the old purple index and dot (`#b0a6c9`, `#9782c8`) outside the editor-workspace overrides.

## After

- Spacing guides follow the Mac Figma Option measurement: four paddings when one box contains the other; otherwise only a positive gap. A perpendicular overlap centers that gap. A diagonal pair forms an L on the selection's facing edges. Both the DOM fallback and the GPU overlay draw `#f24822` segments with six-pixel end ticks and a centered halo label. The geometry lives in `canvas-measurements.ts`.
- A boolean merge is named 联集 / 减去 / 交集 / 排除, takes the front-most selected sibling's slot, and is allowed inside an auto-layout parent. The result is one fixed-size flow item. Operand fill/hug sizing is frozen to fixed. Child world spacing is preserved relative to that item. Ordinary group wrapping still rejects an auto-layout parent and still uses the back-most slot.
- Equal corner radii use one field. The independent-corners control, or mixed values, shows top-left, top-right, bottom-right, and bottom-left. Corner smoothing is unchanged.
- Glass controls follow light angle, light intensity, refraction, depth, dispersion, then bevel width. The effect name is 玻璃 / Glass. Authored glass numbers and the shader are unchanged.
- Page rows are 32px with a 6px radius. The active page uses `--workspace-accent` (`#3459d4`) on web and Electron.

## Retest

Dev WASM was built only so vitest could import the kernel (`design-studio/scripts/build-web.py --profile dev`). It is gitignored and is not a rendering acceptance build.

Passed, 2026-11-02, vitest 5.0.1, Linux, `tsc --noEmit` exit 0:

- `canvas-measurements.test.ts`, `corner-radius-fields.test.ts`, `kernel/gpu/canvas-overlay.test.ts`, `selection-chrome-label.test.ts`, `commands/boolean-command.test.ts`, `automation/boolean-command-mcp.test.ts` (43 passed)
- `canvas-overlay-ui-ownership.mounted.test.tsx`, `commands/plans.test.ts`, `outline-compositing.test.ts` included in a later 38-test run (38 passed)

Not run: hardware GPU, packaged Electron click-through, 33 ms / 100 ms, full G2/G5, or the desktop `main.test.mjs` host suite.

## Still open

- Glass pixels are still the existing bevel model, not a claim of matching Figma's private shader.
- Corner smoothing geometry is unchanged.
- The toolbar remains on the bottom. This pass did not move it to a left rail.
- Auto-layout gap and padding defaults are unchanged.
- No claim that these interactions meet 33/100ms or full G2/G5.
