# Font-fixture portability: independent addendum

This addendum preserves and supplements the earlier Canvas/font review. It does not replace the earlier frozen report or pretend its test-source hashes remain current after fixture migration.

## Result

Final independent acceptance passes **13 external portability cases**, **42 Vitest tests in four suites with zero skips**, and TypeScript. The captured generator, helper, test sources and WASM hashes stayed unchanged during this run. The test counts overlap earlier font checks and must not be added to them as unique coverage.

No product/UI code was changed by this reviewer. No generated font files are retained in this evidence directory or allowed in the delivered source ZIP.

## Required baseline and toolchain

- Baseline font: `frontend/design-client/public/fonts/NotoSansSC.ttf`
- Size: `17772300` bytes
- SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- License remains `frontend/design-client/public/fonts/OFL.txt` in the baseline checkout.
- Python **>=3.10**, matching installed fontTools metadata `Requires-Python: >=3.10`.
- Explicit dependency: **fonttools==4.61.1**, pinned in `testing/font-fixtures-requirements.txt`.
- Actual independent runtime: Python 3.12.14 on Linux.

The helper never installs/downloads dependencies. A missing interpreter, missing/wrong fontTools version, wrong baseline source, or corrupted cache fails the test with an actionable error. Existing cached bytes do not conceal missing dependencies.

The baseline font is already present in the user's Git baseline; it is not an additional font copy to include in the increment. Reproduction command from a prepared checkout:

    PYTHONHASHSEED=0 python3 testing/generate-font-fixtures.py --cache-root /tmp/my-font-fixture-review

For the Node helper, interpreter selection is: explicit `options.python`, then `PYTHON`, then `python3` on Unix or `python` on Windows. An explicit executable path containing spaces was successfully invoked without shell splitting. Linux default and environment/option precedence were executed; win32 default dispatch was simulated by changing `process.platform` and invoking the selected real Python command on Linux. This is not actual Windows validation.

## Independent checks

1. Isolated minimal checkout had no `testing/verification-font-batch` directory. Generation and the actual Node helper succeeded using only the generator, helper and exact baseline font.
2. Two separate fresh caches, including different `PYTHONHASHSEED` values, produced identical pinned bytes/manifests.
3. Cache hit revalidated bytes and did not rewrite cached contents or mtimes.
4. Concurrent generators published one complete directory, with no leftover private staging directories.
5. Missing dependency and incorrect pinned version failed even with an otherwise valid cache.
6. Missing source and same-size source SHA mismatch failed before cache creation.
7. Cache SHA mismatch failed without silently replacing the corrupted bytes.
8. A cache root inside the source checkout was rejected.
9. Actual Python parser found exactly the specified codepoints, every mapping resolved to a non-.notdef glyph, and source-created/modified timestamps were retained.
10. Final WASM parser/shaper accepted both generated faces; ABC used Latin and 中文 used the explicit CJK fallback, all with nonzero glyph IDs.
11. Source font, license, helper/generator and all historical fixture contents retained exact before/after hashes.
12. Missing interpreter failed instead of falling back or skipping.
13. ASCII subprocess output successfully transported the exact Unicode subset manifest after correction.

## Issues found and corrected

### FP-1: successful generation failed under ASCII stdout

The generator originally printed JSON with `ensure_ascii=False`; its CJK glyphSubset caused `UnicodeEncodeError` with `PYTHONIOENCODING=ascii`. This was a concrete reproducible portability bug in subprocess output, independent of font generation.

The owner changed only transport output to `ensure_ascii=True`. JSON parsing recovers the same Unicode values, while persisted manifest bytes remain explicitly UTF-8. `ascii-stdout-before.log` preserves the original failure; `final/ascii-stdout-transport.log` and the final regression suite prove the fix.

### FP-2: new test confused typographic and legacy family names

The first parsed-font check required exact `Noto Sans SC`, but the bundled/historical/generated font's name ID1 is `Noto Sans SC Thin`; name ID16 is `Noto Sans SC`. The kernel reports ID1. The owner corrected the exact assertion to the preserved actual identity and kept real parser/shaping checks. The first failure is preserved as `final/vitest.log`; the final run passes all 42 checks.

## Stable bytes and historical equivalence

- Latin: 23,028 bytes, SHA-256 `32924279319ac4b9bd7c2a11512be33a0f77985c54a3b97ffd4f37fa15abdceb`
- CJK: 7,000 bytes, SHA-256 `d364933e29d565ae7422d38abccd6965244246a917d31e1c1c531054a77fab8e`

`final/historical-byte-equivalence.json` independently compares the generated and historical subset fonts. The only different SFNT table is `head`; only `modified` and derived `checkSumAdjustment` differ inside it. Every other table is byte-identical. The hash change therefore reflects deterministic timestamps rather than changed glyph content, names, shaping data or coverage.

## Canonical evidence and exact final sources

- `final/acceptance-vitest.log` / `.json`: 42 passed, zero failures/skips
- `final/acceptance-typecheck.log`: empty success, exit 0
- `final/acceptance-inputs.json` / `acceptance-outputs.json`: identical final input identities
- `final/results.json`: all 13 independent cases passed
- `final/inputs.json` / `outputs.json`: source/historical fixture non-mutation
- `final/parsed-font-coverage.json`: exact cmap/glyph/timestamp checks
- `final/historical-byte-equivalence.json`: old/new table comparison
- `final/generated-manifest.json`: names, sizes, subsets and output hashes, with no font bytes
- `final/independent_portability.py`: independent harness; generated font outputs were temporary and removed
- `final/node-helper-review.log`: actual helper dispatch checks; Windows-runtime limitation explicitly recorded

Generator SHA-256: `0ed75834842e663f7c1c240d63277c8889b8549923227bbd163bf698b72bc79b`

Helper SHA-256: `fd43180dfc6eea128a2849048226160ff9b41fdbcd42023f8b81a93bd9fb1509`

WASM SHA-256 for the 42-test acceptance: `2c50f87de40b6e2ecc456eb053706d4e2c3c058da82aafffd1b191eddd8b039a`

Full source hashes are in `final/acceptance-inputs.json`. Actual Windows/macOS execution and the root task's final full-tree/package aggregate remain outside this scoped addendum.
