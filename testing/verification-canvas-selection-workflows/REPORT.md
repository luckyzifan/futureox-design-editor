# Canvas selection workflow increment

Checked against current official documentation on 2026-10-19. This is a bounded Sketch-like interaction increment, not a claim of complete Sketch/Figma parity.

## Implemented scope

- Sketch-like Option marquee requires complete containment of the existing world-space selection AABB. Reverse-direction, rotated geometry, and pan/zoom are covered. Modifier state and coordinates are read from the owning pointer's final release.
- Sketch-like Shift marquee toggles candidates against the original selection, including primary-modifier + Shift deep marquee. Untouched selected layers stay selected. Mac uses Command; Windows/Linux Control is an explicit local adaptation.
- Sketch-like Escape selects the parent when idle; top-level selection clears. Active gesture/drawing cancellation keeps priority. Figma Escape clearing and Shift+Enter parent navigation remain unchanged.
- Holding X temporarily forces a deep marquee from occupied canvas, including through transform/layout handles, without replacing the current tool. It excludes the starting hit and its ancestor chain so an ignored only child cannot promote its container. The chain exclusion is the bounded implementation of the documented contents-without-starting-frame workflow.
- Held-X state clears on key release, blur, hidden document, editable/modal focus, profile change, document/page/session change, and Escape. IME/editable/modal events never arm it; repeats do not toggle it. Native Mac Control-click and hand/Space panning retain priority.
- The shared shortcut module implements the shared center-selection/Cmd+3 command. This suite additionally verifies the actual Canvas dispatch on Mac/Windows/Linux desktop, browser/Figma non-interception, pending-camera zoom retention, empty/hidden/stale/other-page no-op, visible locked selection centering, and busy/interaction/input/history guards. This increment does not modify command/profile files.

## Official references and boundary

- [Sketch selecting layers](https://www.sketch.com/docs/designing/layer-basics/selecting-layers/): occupied-canvas marquee, containment, deep and toggle modifiers.
- [Sketch Mac shortcuts](https://www.sketch.com/docs/shortcuts/mac/): Shift marquee add/remove, Escape parent, and Command+3 centering.
- [Sketch changelog](https://www.sketch.com/changelog/2/) and [Frames and Graphics](https://www.sketch.com/blog/frames/): X marquee across hierarchy and ignoring its starting layer/frame.
- [Figma select layers](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects): unchanged Escape deselection and Shift+Enter parent selection.

Sketch documents both press and hold X. This local increment implements only holding X; tap-to-enter persistent marquee mode remains unsupported. Existing AABB picking remains authoritative, including masks/clipping/effects: there is no new paint-pixel selection algorithm. Existing hidden/locked ancestor exclusions are retained. These checks do not establish native OS/browser event behavior or GPU/pixel/performance parity.

## Verification

- Final actual mounted React/jsdom Canvas + real Editor/current WASM: 29/29 passed (`affected-tests-final-pass.log`; the earlier selection-only 24/24 checkpoint is retained in `new-test.log`). Only the render-device presentation boundary is replaced; Canvas handlers, child event propagation, geometry, history, and selection are real.
- Final affected suites: 8 files, 130/130 tests passed (`affected-tests-final-pass.log`; the earlier 125-test checkpoint remains in `affected-tests.log`). Includes new selection suite, Canvas CPU, minimap absence, DOM shortcuts, shortcut profiles, selection hierarchy, pointer intents, and workflow shortcuts.
- Exact current preimage `Canvas.tsx` b67532fbd90c7d130852f9c159c56bc9a8f1484798293cb3a7ac8257547b1ff4 was captured before edits. It includes the already-unshipped performance/minimap work; no Git-baseline reset was used.
- Six selected behavioral witnesses fail with that preimage, using the same real mounted Canvas/WASM harness (`old-code-behavior-failure.log`). Failures cover containment, three platform XOR cases, forced-X over a real resize handle, and Escape parent navigation. They fail on selection behavior, not a missing import or cosmetic style assertion.
- Final TypeScript check passed (`typecheck-final-pass.log`); Git whitespace check passed. Intermediate logs retain the discovered and subsequently fixed empty/hidden Cmd+3 eligibility defects, plus corrected fixture issues; those intermediate failing logs are not the final result.
- Increment-only Canvas patch: `canvas-increment.patch`. Exact final owned source and WASM identities: `source-hashes-final.sha256`. Earlier checkpoint manifests are preserved separately.

## Source ownership and deletions

Modified: `frontend/design-client/src/Canvas.tsx`.
Added: `frontend/design-client/src/canvas-selection-workflows.ts`, `frontend/design-client/src/canvas-selection-workflows.test.tsx`.
No product/source deletions in this increment. Temporary anti-vacuity witness files (`Canvas.selection-before.tsx`, `canvas-selection-before.test.tsx`) were removed after testing; the complete Canvas preimage is retained at before/frontend/design-client/src/Canvas.tsx alongside the patch, hashes, and logs. Use it only in an isolated test copy and verify its recorded hash. No Rust/GPU/engine/render code, toolchain, binary, cache, or retained verification record was removed.
