# Shortcut profiles verification

Date: 2026-10-19. Checkout base: `71d3215` (latest workspace, concurrent authorized API/performance work retained).

- Frontend: **114/114 passed**, 7 suites. Real rebuilt Rust/WASM + Editor; actual React/jsdom component and DOM-event tests are included. See `frontend-tests.log`.
- Native boundary: **45/45 passed**. Pure native shortcut policy plus real `main.mjs` registered-handler tests with explicit Electron/OS boundary doubles. See `native-tests.log`.
- `tsc --noEmit`, `git diff --check`, `node --check src/main.mjs` and `node --check src/keyboard-shortcuts.mjs`: passed.
- No browser, Electron GUI, GPU request, remote repository action, or dependency installation performed. UI layout, system IME and native focus sequencing remain runtime verification gates.

Commands (from frontend/design-client):

```sh
node node_modules/vitest/vitest.mjs run src/shortcut-dom.test.tsx src/shortcut-profiles.test.ts src/editor-commands.test.ts src/canvas-context-menu.test.ts src/editor-lifecycle.test.tsx src/clipboard-internal-review.test.ts src/clipboard-semantics.test.ts --maxWorkers=1
node --test ../design-desktop/test/keyboard-shortcuts.test.mjs ../design-desktop/test/main.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node --check ../design-desktop/src/main.mjs
node --check ../design-desktop/src/keyboard-shortcuts.mjs
git diff --check
```

Feature/source-reference documentation: `frontend/design-client/SHORTCUT_PROFILES.md`.
The retained review diff only covers existing keyboard/menu files. Newly added modules and App/native-main integration are available directly in the working tree; the diff is not a standalone patch.
