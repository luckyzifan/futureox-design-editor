# Unified settings dialog: implementation and verification

## Implemented scope

- `SettingsDialog.tsx` presents three accessible, keyboard-operated sections: input habits, canvas aids, and saving/scope information.
- Keyboard presets reuse `KeyboardProfileSettings` and `shortcut-preference.ts` unchanged. Wheel navigation reuses `Editor.setScrollWheelZoom()` and its existing `forma-scroll-wheel-zoom` key. Neither value is duplicated in the new preference store.
- `settings-preference.ts` persists only six existing, genuinely consumed Editor booleans: smart snapping, pixel snapping, pixel-grid visibility, rulers, transparency checkerboard, and canvas grid. `bindEditorSettings()` connects settings, existing view controls, and document sessions to the same values.
- Changes apply immediately. Default restoration resets these six flags plus the existing keyboard and wheel preference owners. Corrupt data is validated field by field; invalid setter patches are rejected atomically. Storage denial/quota errors retain usable session preferences and show a session-only warning.
- Background content is inert while open. The dialog traps focus, restores the original trigger or canvas on dismissal, restores prior inert attributes and body scroll state, ignores composing/repeated Escape, and allows normal native input/button behavior. Parent-owned `busy` prevents dismissal during an asynchronous workspace operation.
- The new stylesheet is scoped to settings classes and adapts the dialog to narrow/short viewports with scrollable content. It does not scale the canvas or change renderer quality.

## Scope boundaries

Preferences are scoped to the current application's local-storage profile/origin, not to the entire device. The main desktop window retains its profile across workspace restarts. Independently opened desktop local windows use independent `local-window-*` profile/session directories; shared preferences across those windows, and restoration into a newly created independent window, are not provided by this change. A shared native preference authority would be a separate feature. Cross-window storage synchronization only applies to windows that actually share the same storage area.

Document color management, page background colors, ruler-guide content, pixels, camera coordinates, graph data and undo history are not rewritten by preference changes. The dialog has no unsupported memory/GPU/quality controls or configurable autosave interval. Saving information accurately describes the current browser 350 ms scheduling and desktop 600 ms recovery scheduling, with editing/recovery/error caveats. Native workspace relocation controls are supplied by App through a slot and verified separately.

## Integration contract

The App owns the long-lived binding, even while Settings is closed:

```tsx
import { SettingsDialog } from './SettingsDialog'
import { bindEditorSettings } from './settings-preference'

useEffect(() => bindEditorSettings(editor), [editor])

{settingsOpen && <SettingsDialog
  editor={editor}
  onClose={() => setSettingsOpen(false)}
  desktop={!!desktop}
  returnFocus={persistentMenuTrigger.current}
  busy={workspaceActionPending}
  workspaceControls={workspaceControls}
/>}
```

`workspaceControls?: ReactNode` renders in the saving section; App owns native permissions, asynchronous work, result/error handling and disabled states. `busy?: boolean` disables Close/Done/reset and blocks Escape/backdrop dismissal. The dialog imports its own CSS. The App should commit/validate pending document fields before opening it and dismiss it before presenting a higher-priority native close/save prompt, so that the new prompt is not under the modal's inert background.

## Executed checks

All commands ran in `frontend/design-client` using the installed dependencies. No download or install was required.

1. `node node_modules/vitest/vitest.mjs run src/settings-preference.test.ts src/SettingsDialog.test.tsx`
   - Latest scope-corrected run: **25 tests passed, 2 files**.
   - Raw output: `focused-scope-correction.log`.
2. `node node_modules/vitest/vitest.mjs run src/settings-preference.test.ts src/SettingsDialog.test.tsx src/shortcut-dom.test.tsx src/shortcut-profiles.test.ts src/interaction-ui-runtime.test.tsx src/editor-lifecycle.test.tsx`
   - **114 tests passed, 6 files** before the final scope-only copy/test correction; the 25 settings tests were rerun after that correction.
   - Raw output: `regressions-final.log`.
3. `node node_modules/typescript/bin/tsc --noEmit`
   - Exit 0; output: `typecheck-final.log`.

Behavior assertions use real React, jsdom events, `Editor`, and the checked-in WASM. They cover initial restore/rebind, current controls, actual keyboard and wheel-camera consumers, all six setting values, unchanged authored document/undo state/exact camera values, retained preferences across document loading, storage errors/clear/cross-window events, default reset, reopen, tab navigation, modal keyboard isolation, IME/repeat guards, busy state, background cleanup and focus restoration. A 1,000-camera-notification test asserts zero preference-storage reads/writes or preference subscriber notifications.

## Verification limits

jsdom does not validate actual responsive layout, screen-reader behavior, real browser rendering, OS dialogs, native relaunch, GPU output, or pixel fidelity. Those have not been claimed as passed here. Existing OS/browser/GPU restrictions were not bypassed. Native workspace preference tests and broader aggregate/build results belong to their own verification records.
