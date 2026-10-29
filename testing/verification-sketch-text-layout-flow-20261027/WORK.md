# 2026-10-27 continuation — in progress

Authorization: continue Sketch/core text/layout/prototype/local library and pixel parity, preserving current precision and features. Reusing attached sketch-canvas-support worktree. Main baseline.json has 2611 hashes AND baseline-source exact bytes. 8 files synced from newer main, old versions saved in pre-sync. No integration yet. No agents spawned.

Implemented candidate (not yet fully verified):
- schema20 TextStyle.verticalAlign; TextRun.paragraph with alignment, absolute min/max line-height, spacing, indent. Rust layout, caret/path height-key, Inspector paragraph section, operation descriptors, schema upgrades.
- Canonical native paragraphStyle fixes old exporter field textStyleBasicParagraphStyle which Sketch preserved but ignored for rendering (native comparison kept). Native text-model receipt only restores existing authored semantics when native projection matches exactly; edited native fields are authoritative.
- Hotspot maps to existing paintless rectangle + raw native class receipt. Shared player click/back/maintainScrollPosition; schema20 directional navigate/back slide styles. Overlay/complex Smart Layout remain open.
- Verified installed SketchAPI_dom.js: Fixed0/Fit1/Fill2/Relative3, pin Min1/Max4/All5. Candidate maps supported explicit fixed/hug/fill & edge pins, leaves unknown/Relative/flexItem raw and reported. No guessed Inferred mapping.
- Explicit .sketch library file refresh via existing owned import worker and Editor change. Stable archive document ID, deterministic publication page, version/digest; adopt embedded foreign symbols by symbolID + remoteToLocalIDMap, preserve template keys/overrides. No names or cloud/network matching.

Verification status:
- Current TS typecheck previously passed; latest including new tests pending.
- First interop47 pass1fail1ignored: remaining failure was old expected3 rich text runs vs exact receipt restores original2, test updated to assert authored ranges.
- Text new tests initially failed font not loaded; fixed test font. Then expected third natural line height30 vs actual28.96; switched expectation to actual font metrics (source semantics fixed, no threshold relaxation). Re-run pending.
- Native initial4 text boards had wrong paragraph key; switched canonical and separately retained native-key experiment. Full native-input now prepared by make-native-fixtures.py.
- WASM desktop-dev build running, must complete before frontend actual-kernel tests/GUI.
- No full G2/G5 or pixel parity claim. Native glyph raster differences remain.

Files for UI/tests: native-input.sketch, foreign-consumer.sketch, library-v1.sketch, library-v2.sketch under this folder. Native reference PNGs native-final/. Rust generator design-studio/crates/design-kernel/examples/sketch_text_flow_fixture.rs. Worktree fixture testing/fixtures/design/sketch-text-layout-flow.sketch is copied native-input; new src/sketch-followup.test.ts uses library fixtures in worktree same evidence folder.

Outstanding: finish actual tests, fix regressions, calibrated native/portable + reexport comparisons, actual GUI including library override update and text, main hash-guard integration, combined build/source identity, docs/skills. Main concurrent edits MUST be preserved. Keep source files read-only.


Final: integrated30 unique files; main build3 passed, 2262 inputs matched, main31 Rust +97 actual WASM tests passed, interop48 passed,111/117 each passed. Main production GUI saved/reopened FD, observed paragraph/vertical values, library red Local label, layout resize/undo, prototype navigation/back,800→200 and native wheel pan. Final artifact/status is verification.json. Remaining scope is explicit in README. No agents, PR, goal, automation or archive.
