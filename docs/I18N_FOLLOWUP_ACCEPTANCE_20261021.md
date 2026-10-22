# Electron property localization followup acceptance

This is a followup to the first delivered repair, not a claim that all product internationalization is complete. The older `I18N_ELECTRON_REPAIR_CHECKLIST_20261021.md` and its earlier inventory describe the first package; their source hashes/counts must not be presented as current followup coverage.

## Implemented scope

- Main property panels: Inspector, LayoutPanel, TextStylePanel, MultiSelectionInspector, AlignmentControls, NumberField and MixedNumberField.
- Embedded panels: FontManagementPanel, SystemFontPicker, MultiStylePanel, SelectionColorsPanel, ScaleInspector, ColorInput, ColorPickerPopover and DraftInput's generic validation message.
- Explicit Chinese/English presentation catalog: 418 source phrases. This is a catalog-entry count, not a percentage of the application translated.
- Numeric unit, diagnostic family and history label are explicitly separated from translated presentation. Existing parsing behavior, IDs, command callbacks, slot paths, undo labels and font/color authoring semantics remain intact.
- Font result messages use existing result counts. Font families, styles, PostScript names, resource IDs and search text are not translated. Unknown backend diagnostics remain verbatim.
- Color sessions retain their ownership/state machine. Locale changes remeasure the popup without rerunning initial autofocus or committing/cancelling. Existing color strings, HDR values and alpha semantics are not rewritten.
- Long numeric labels have full-name tooltips and a scoped shrink/ellipsis layout that reserves editable value space. This is a CSS/DOM contract, not physical pixel acceptance.

## Verification completed before final full-suite freeze

The single coordinated runner reported 423/423 associated tests passing and TypeScript checking exit 0 on 2026-10-21. Final full-suite acceptance remains a separate runner result.

- `property-locale-batch3.test.tsx`: 13 mounted cases. Covers dirty single/multi input identity and focus; zh/en unit parsing; authored names/text; invalid OpenType drafts; stable opacity diagnostic families; alignment button identity; image tile hints; locale changes during scrub with unchanged semantic history and one undo; full-label tooltips.
- `property-subpanels-locale-batch4.test.tsx`: 7 mounted cases. Covers document/native font search with unchanged authored metadata and no duplicate native reads; mixed-style opacity draft/units/history/undo; selection color; scale ratio and anchor identity; invalid color-session draft/focus/cancel; retained generic invalid-input validation.
- Baselines were verified before each product fix: initial batch-three 8 real failures and 2 compatibility passes; history/title followup actual history/title/CSS failures; batch-four all 7 failed on existing untranslated presentation/validation, without fixture/setup errors.
- Existing direct-function React tests exposed invalid hook harnesses. Necessary tests were adapted to mounted React or actual snapshot-aware existing harnesses while retaining width, fill, rich-text, geometry and undo assertions. Locale was not replaced with a constant mock.
- Color/font parser tests, related editor behavior and earlier locale/native gates remain distinct evidence; no native GUI or font installation was performed by these mounted tests.

## Remaining work and limits

- Professional tools and other application panels still contain untranslated presentation. Layout suggestion explanations and unknown backend diagnostics are examples outside this bounded followup.
- The current inventory is a candidate scan, including translated catalogs, diagnostic/history strings and authored defaults. It is not an untranslated-string total or translation-completion rate.
- Real Electron screenshots, physical layout at different DPI/window sizes, OS-generated controls and platform-native font permission flows have not been visually accepted here.
- No claim is made that every canvas operation or every user-visible string has been covered by these 20 locale cases. Broader operation and full-suite results must be read separately.
