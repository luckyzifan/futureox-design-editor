# Portable font fixture correction

The source-only font tests previously read generated TTFs under the historical font-batch evidence directory. Those copies are intentionally excluded from the source ZIP. Tests now use a deterministic, source-only generator and temporary-cache helper, with no dependency on the historical fixture tree.

## Result

- Final focused run: **40/40 tests, 3/3 suites passed**, including nine new portability regressions and all affected real Editor/WASM/React DOM font tests.
- TypeScript: `tsc --noEmit` exited **0**; its successful log is empty.
- All **32 historical font-batch evidence checksums** still pass. Old fixtures, provenance, logs, and reports were not changed.
- Existing 1,000-text tests still verify one Editor change, 1,000 node / 3,000 run visits, exact undo/reopen, and bounded 26-element management DOM. Current timings are CPU observations with concurrent work, not a controlled comparison or GPU/browser performance claim.

The generator requires Python >=3.10 and exact fontTools 4.61.1, based on installed distribution metadata. It uses only the bundled baseline Noto Sans SC font, preserves the original glyph subsets/options, and disables timestamp recalculation. Exact output hashes, cmap coverage, actual WASM face parsing, and explicit Latin-to-CJK fallback remain tested. See `../FONT_TEST_FIXTURES.md` for original generation options, source provenance, requirements, hashes, usage, cache publication and platform limits.

## Evidence

- `final-tests.log`, `final-results.json`: final green affected suites.
- `typecheck.log`: successful no-output TypeScript check; exit code recorded in `summary.json`.
- `environment.json`: actual Python/platform/fontTools version and Requires-Python metadata.
- `historical-evidence-check.log`: unchanged earlier evidence checksums.
- `source-sha256.json`: seven portability source/test/documentation files at this run.
- `tests.log`, `results.json`: retained initial **39 passed / 1 failed** run. The assertion used the typographic family `Noto Sans SC` while the real kernel reports the pinned legacy family `Noto Sans SC Thin`. The test was corrected to the exact real identity after verification, not weakened to a generic parse success.
- `font-name-provenance.json`: baseline, both historical subsets, and both new deterministic subsets have identical name IDs 1/2/4/6/16/17. This establishes the initial test failure was an incorrect expected name, not generator corruption.

Independent review separately found an ASCII pipe-encoding issue in the first generator version. The final stdout JSON escapes Unicode for transport, and a dedicated `PYTHONIOENCODING=ascii` regression passes while decoded CJK metadata and font hashes remain exact. The independent review preserves its original failure and final rerun evidence separately.

This is additive verification. It does not replace or rewrite earlier frozen evidence. No product/UI code changed for this packaging correction. Generated TTF bytes remain only in external temporary caches; they are not included here.
