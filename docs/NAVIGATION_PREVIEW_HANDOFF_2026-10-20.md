# Navigation preview handoff and zoom-out coverage

## Confirmed cause

`ProgressiveSurface.tsx` previously gave every navigation viewport capture the same revision-only key. `receive()` replaced that map entry and removed readiness immediately. Provisional captures do not enter `displayed.residents`, because exact-frame commit is explicitly disabled during navigation. Thus an acknowledged preview was unmounted/released before its replacement display upload completed. If another base tile existed, it could briefly show instead; if no base existed, the surface lost its provisional coverage.

The same collision destroyed useful wider-world coverage during zoom reversal: a narrow zoomed-in viewport replaced the wider sampled viewport even though both belonged to the same unchanged scene. A deterministic .25x → 4x → .25x case, blocking the third result, showed draw-plan coverage of 2,048 / 524,288 screen square pixels before the fix and 524,288 / 524,288 after it. These are mocked-transport geometric coverage values, NOT physical GPU measurements or a claim about the user's exact scene.

## Minimal correction

Assign each delivered navigation capture a distinct key using the surface's next monotonic tile serial. Using only sample sequence and extent is insufficient: the same sample can resize A → B → A. Existing byte-budgeted LRU, revision validity, readiness checks and compositor ownership now preserve acknowledged compatible captures until a replacement can actually participate in display. Existing quality ordering prefers sharper same-scene pixels, with old wider pixels supplying only the uncovered regions.

No camera interpolation, direct-input delay, navigation cadence, raster density, filter arithmetic, GPU renderer or cancellation behavior changes. Resident and bitmap compositors continue using the live requested camera. Exact completion remains false during navigation.

Navigation renders explicitly use `transparent: false`; the compositor treats captures as replacement planes (`blend` unset). Its shared draw plan subtracts covered rectangles before drawing. Ready overlapping captures therefore do not double-alpha-compose translucent authored scene content. Different document/page/session contracts cannot adopt late results; old result bitmaps and GPU IDs are released.

## Regressions

Added nine deterministic cases in the real surface hook/effect orchestration test harness:
- Delayed upload handoff in WebGL transport and WebGPU resident-payload cases, using fractional pan/zoom and a newer requested camera.
- One sample resizing A → B → A without capture-key collisions.
- 80 captures retaining bounded LRU history and releasing evicted GPU handles once in parent ownership.
- Late document/page/epoch results are rejected and bitmap/GPU ownership cleaned up.
- Identical overlapping capture planes produce one draw, not doubled alpha.
- Rapid zoom reversal preserves wider coverage while the next capture remains blocked and does not claim exact completion.

The compositor children and raster transport are mocked in these surface tests. Separate existing suites cover import lifecycle, geometry/UV pixel ownership, camera phase, CPU fallback and pending backend handoff. No browser, physical GPU, screenshot fidelity or frame-rate measurement is claimed.

## Remaining measurement requirement

This fix addresses a reproducible coverage/handoff defect, not all severe dragging or blur latency. A never-rendered region still needs pixels, and history may legitimately be evicted under the existing memory budget. Repeated WASM compilation/filter work and display/raster queue timing need the user's exact scene and a deployed-revision trace. Distinguish live camera reprojection, fresh capture publication and actual display scanout before attributing a reported content rate.

## Completed validation

Final isolated-tree run: 14 Vitest files, 147 tests passed. `tsc --noEmit` passed. Logs: `navigation-jitter-final-tests.log` and `navigation-jitter-final-tsc.log` in the shared workspace. The original-key zoom-out regression failure was retained in `navigation-jitter-zoomout-before.log`. Final integration must rerun against combined page-cache changes.
