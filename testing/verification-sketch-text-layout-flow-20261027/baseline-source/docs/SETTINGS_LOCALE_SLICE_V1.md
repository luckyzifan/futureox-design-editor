# Shared settings and navigation locale slice v1

## Contract

The existing `interface-preference.ts` store remains the single preference owner. Default locale is `zh-CN`; `en` is supported and persists in the existing `forma.interface-preferences.v1` profile. Unsupported locale values fall back to Chinese. Denied storage preserves the usable session setting and displays a session-only notice. There is no network sync or per-account language state.

`interface-messages.ts` contains 113 paired keys. English is statically required to have every Chinese key. `useInterfaceText()` in `interface-preference.ts` observes the existing external store; the previous `interfaceText` export remains available. Text is presentation only, never an operation name, permission, document/layer/page name or history identity.

This slice translates the settings shell/tabs, keyboard profile, nudge labels and validation, interface preferences, memory-tier controls, saving explanations, companion unavailability, and view-menu/navigation labels. `useAdaptivePanels()` updates the document `lang` attribute and restores the previous value when its root owner unmounts. React keys do not depend on locale. Transient messages retain message keys, not already translated values, so existing errors/statuses switch languages without resetting inputs.

Locale changes must not call `Editor.change`, `Editor.load`, save, reset preferences, commit/cancel pending input, navigate pages or flush a pending camera. Document object/ID/page/selection/view/revision/session, authored names, undo/redo and unsaved state remain unchanged. `ViewControls` pins the existing numeric unit explicitly rather than deriving semantic units from a translated label. Existing diagnostic codes and families are preserved.

The approved page-memory preference controls remain unchanged in behavior, including exact tier values, budgets, persistence, reset and limits. No partner/companion implementation is enabled. No backend, auth, roles, collaboration, MCP tools or remote services are added.

## Integration boundaries

- All source paths are based on immutable554, except `SettingsDialog.tsx`, whose precise per-file baseline is the already approved UI/cache cohort with memory-tier controls. The delivery change manifest records both hashes.
- `page-memory-preference.ts` and `kernel/page-memory-policy.ts` are upstream validation prerequisites, not new work in this patch.
- App/Home is owned by its separate cohort and is not edited here. Shared keys `settingsTitle`, `openSettings`, `fileMenu`, `localFiles`, `home`, `backToEditor`, `newDesign`, `importDesign`, `recentDesigns`, `trash`, `searchDesigns`, `homeEmpty`, `localOnly`, `working`, `close` are available for that cohort. Supplying a key does not establish that a screen uses it.
- Diagnostics panel content, caller-supplied workspace controls and shared NumberField generic tooltips/errors remain outside this slice. The language help explicitly discloses partial coverage.

## Remaining source inventory, not a completion percentage

`frontend/design-client/scripts/generate-i18n-inventory.mjs` uses the installed Rolldown parser to scan production frontend `.ts/.tsx/.js/.mjs` literals, JSX text/attributes and template fragments. It excludes tests, declaration files, comments and the locale catalog. `I18N_REMAINING_STRINGS_V1.json` records exact file SHA-256 values, line/column, text, kind and a canonical source-inventory digest. This slice scans 483 source files and finds 3,698 Han-script candidates in 208 files.

These are candidates, not 3,698 proven UI omissions: authored defaults, protocol errors, diagnostics and dev helpers are included. English-only static text, host/runtime strings and interpolation semantics are not detected. Never bulk-translate stored authored names, reference IDs, command names, test fixtures or diagnostic codes.

Priorities after this slice:

1. App file menu, persistence/conflict dialogs, workspace slots and Home integration. `App.tsx` currently has 194 candidates in this baseline.
2. Inspector and property panels: `Inspector.tsx` 204; `VariablesPanel.tsx` 112; `DesignTools.tsx` and `LayoutPanel.tsx` 105 each; `AnimationPanel.tsx` 92. Review semantics such as label-inferred numeric units and diagnostic families before translation.
3. Export, automation, shared fields and diagnostics. Preserve stable structured protocol/error codes even if human messages become localized.
4. Electron native menus are independently hardcoded, mostly English, in `frontend/design-desktop/src/main.mjs` starting around line 1084. They do not yet follow the renderer locale. That host file is outside the generated frontend-only inventory and this patch.

No whole-app, fully translated page flow, native-menu or international accessibility acceptance is claimed.

## Verification

See `testing/verification-settings-locale/README.md` for exact commands and limits. The final slice passed full TypeScript checking, 13 suites / 187 tests with zero skips, byte-identical regenerated inventory, and Vite production bundling against the verified existing WASM. Mounted tests cover both Chinese/English and browser/desktop settings branches with real Editor/WASM. Desktop file operations are declared test doubles, not physical persistence proof.

Initial local runs found and corrected test-harness issues (React DOM initialization order, diagnostics opt-in, and an existing shallow hook dispatcher needing the new subscription hook). An initial Vite attempt failed because the overlay entry HTML was a symlink outside the project root; materializing that unchanged entry resolved it. The inventory generator was adapted to the installed parser because TypeScript 7 no longer exposes the old AST API at its package root. Initial and corrected logs are retained. Existing Vite chunk-size and ineffective-dynamic-import warnings remain, not hidden.
