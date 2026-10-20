# Canvas/editor diagnostics and targeted corrections

## Included

- Shared bounded, content-free action lifecycle diagnostics across Canvas, commands, utility owners, text/property controls, document IO and settings. Commit, observation, unchanged, cancellation, blocked and rejected outcomes remain distinct.
- UI RAF and resident software-submission windows, input correlation and sampled grid observations. Worker timestamp span determines software-submit rate; rate/duration capping is explicit. These are not physical display or new-content FPS measurements.
- A one-entry navigation budget latch prevents repeating the identical failed optional navigation sample until its exact target/contract changes. A controlled hook regression reduces 14 duplicate attempts to 1; this is not a measured device speedup or proof that every observed failure has that cause. Exact fill is unaffected.
- W/H property edits fix only the explicitly edited sizing axis, preserving the opposite hug/fill mode. Proportion-locked edits intentionally affect both. Legacy Canvas resize retains its existing dual-axis contract.
- Image insertion uses valid model defaults and source-relative placement with ownership/stale-session guards. Delayed export/copy and preference operations do not claim document commits from unrelated revision changes.

- Settings entry now has explicit visible 12px text and a distinct gear, plus native Settings menu and platform shortcut. Loading, transitions, modal ownership and pending-edit guards are preserved. This is source/contract verification, not fresh Chromium visual acceptance.

## Acceptance

The combined source passes TypeScript checking and a production Vite build. Validation is reported by independent suite groups rather than adding overlapping owner runs:

- Primary integration: 19 suites, 274 tests, covering new-document Canvas/utility gestures, command routes, image insertion, text/property controls, frame observations and navigation retry behavior.
- Additional selection/layout/CPU regression: 9 suites, 61 tests, covering selection workflows, handles, scale, layout ordering and grids.
- Export/settings async-outcome regression: 3 suites, 17 tests; SettingsDialog overlaps the primary run and is not added to a unique total.
- Initial desktop diagnostics/bridge/build-input regression: 80 tests.
- Final Settings-entry/native shortcut/preload/desktop regression: 119 tests, including 17 Settings contracts; overlaps earlier desktop runs and is not added to a unique total.

The first overlay build attempt failed because the HTML entry remained an external symlink. Materializing identical entry bytes locally fixed the build; no product code change was needed. Existing chunk-size and ineffective dynamic-import warnings remain.

## Not completed

See CANVAS_OPERATION_COVERAGE.md for the 43-family checklist and unverified routes. Fresh fixtures and software acknowledgements do not prove every imported-document operation, physical frame quality or complete Figma behavior. New device presets, native color-picker transaction/cancel semantics, versioned modern layout schema, multilevel page retention, broader GPU scheduling, regional fallback, complete import-semantics qualification, collaboration, UI animations, MCP/i18n work and full Nomi 2 are not included in this cohort. Existing cumulative changes remain present.
