# Portable real-font test fixtures

Font tests use the existing baseline `frontend/design-client/public/fonts/NotoSansSC.ttf`. No generated TTF copies belong in the source patch, and tests do not depend on `testing/verification-font-batch/fixtures`.

## Requirements and execution

- Python **>=3.10**, matching the `Requires-Python: >=3.10` metadata of the pinned `fonttools==4.61.1` distribution.
- `testing/font-fixtures-requirements.txt` pins that exact version. Provision it explicitly in the test environment if needed: `python3 -m pip install -r testing/font-fixtures-requirements.txt` from the repository root. The generator and helper never install or download anything.
- Preserve the baseline font and its existing `OFL.txt` / `source.json`. Missing, altered, or wrong-size source bytes are errors; another font is never substituted.

From the repository root, generate or verify the temporary cache:

```sh
PYTHONHASHSEED=0 python3 testing/generate-font-fixtures.py
# Optional isolated cache, outside the checkout:
PYTHONHASHSEED=0 python3 testing/generate-font-fixtures.py --cache-root /tmp/font-test-clean-cache
```

Stdout is ASCII-safe JSON containing an absolute `directory` and a manifest. On success the directory contains `manifest.json`, `noto-latin.ttf`, and `noto-cjk.ttf`. Unicode metadata parses identically even when the pipe encoding is ASCII. The manifest file itself is deterministic UTF-8.

The test-only Node helper, `frontend/design-client/src/font-test-fixtures.ts`, generates lazily. It selects an explicit `python` option first, then `PYTHON`, then `python` on Windows or `python3` elsewhere. `PYTHON` must name one executable (not a shell command with arguments). The helper bounds the subprocess to 60 seconds and 1 MiB output, sets `PYTHONHASHSEED=0`, and returns independent byte copies. The default cache is `core-font-test-fixtures` inside the OS temporary directory.

The generator uses private staging directories and an atomic directory rename. Parallel workers may generate duplicate work, but only a fully verified directory is published. Every invocation checks dependency version, source hash, generated manifest, sizes, hashes, and parsed cmap, including cache hits. Corrupt caches fail with the exact generated directory to remove before retrying; they are not silently repaired or skipped. No source files or historical evidence are written. The cache is rejected if it is inside the checkout.

Linux CPU execution is verified. Python/Node path and process APIs are cross-platform, and non-UTF-8 stdout is regression-tested; actual Windows/macOS execution is not claimed.

## Source and exact subset recipe

Source: `frontend/design-client/public/fonts/NotoSansSC.ttf`

- Bytes: `17772300`
- SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Existing provenance: `frontend/design-client/public/fonts/source.json`
- Existing license: `frontend/design-client/public/fonts/OFL.txt`, SIL Open Font License 1.1
- Existing provenance attributes the font to Google Fonts' Noto Sans SC variable font. Generation reads only the bundled bytes; it does not fetch that upstream URL.

The original historical fixtures were generated using fontTools **4.61.1**, with this exact recipe separately for each text string:

```py
from fontTools import subset
from fontTools.ttLib import TTFont
font = TTFont(source)
options = subset.Options()
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
worker = subset.Subsetter(options=options)
worker.populate(text=text)
worker.subset(font)
font.save(destination)
```

- Latin text: ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`
- CJK text: ` 中文测试继续文字`

Those historical TTF hashes include the generation wall-clock `head.modified` timestamp. The portable generator changes only `TTFont(..., recalcTimestamp=False)` to retain the source timestamp and make bytes reproducible. It keeps all original subset options, including default options not overridden above. Exact cmap sets, actual parsed faces, and Latin/CJK fallback shaping are verified. Existing historical fixtures and provenance remain unchanged; new hashes must not be misattributed to those earlier runs.

Deterministic generated outputs:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `noto-latin.ttf` | 23028 | `32924279319ac4b9bd7c2a11512be33a0f77985c54a3b97ffd4f37fa15abdceb` |
| `noto-cjk.ttf` | 7000 | `d364933e29d565ae7422d38abccd6965244246a917d31e1c1c531054a77fab8e` |

## Regressions

From `frontend/design-client`:

```sh
./node_modules/.bin/vitest run src/font-test-fixtures.test.ts src/font-management.test.ts src/FontManagementPanel.test.tsx --maxWorkers=2
```

The portability suite covers a minimal copied checkout with no historical fixture tree, isolated deterministic generations, concurrent publication, ASCII stdout, wrong/missing source, missing/wrong dependency even on a cache hit, failed subprocess/runtime, corrupt cached bytes, and real `font_faces_json` plus `VectorEngine` fallback shaping. The existing font-management suites still exercise real Editor/WASM/DOM edits, file bytes, one undo, reopen, inherited components, and 1,000-node work counts using these newly generated fonts.
