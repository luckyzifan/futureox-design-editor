# Independent review evidence publication

This directory is an additive, sanitized evidence bundle for the next Design batch. The independent review material retains each original source/runtime boundary. The root coordinator subsequently added the accepted coordinated CPU run in AGGREGATE.md and aggregate-results.json, with exact runtime/freeze evidence. Final archive approval remains separate; historical slice results must not be substituted for the coordinated run.

## What the evidence establishes

- MCP/export: three independently reproduced defects were corrected and retested. The review reports 215 passed tests across its specified suites, including real Sidecar/SQLite stdio durability. This is one review's overlapping run set, not an additional 215 tests to add to a root aggregate. Its runtime was the historical e002c8fe… artifact.
- Sketch color: final interop source cf961d82… and color tests 621c10b5… passed 34 normal-Cargo tests and 10 independent native probes. The non-solid-stroke admission matrix contains 40 rejection cases, not 80. Residual-gap probes pass when they reproduce an existing limitation; they do not establish corrected product behavior for those gaps.
- Canvas/font: final focused acceptance is 99 passed, 1 skipped, plus 16 Node ownership checks and a successful typecheck. The 8 independent regressions overlap the 99 and must not be added again. These final focused checks used a stable provisional-release WASM 7763b301…, not the root's subsequently selected final desktop-dev runtime. The pre-existing direct Editor.addPage/live Canvas transaction reproducer remains explicitly skipped.
- Native FRB1: final desktop suite 33 passed, independent boundary suite 14 passed, client byte tests 2 passed, and the production Rust codec's 5 tests passed both standalone and in the integrated target. The two 5-test executions are the same test cases, not ten distinct tests. Real OS stdio subprocesses were used; sockets, Electron IPC, GPU and GUI were not. Historical benchmark results remain tied to their historical decoder. The new decoder's benchmark has its own exact source hashes and discloses concurrent Cargo-build contention.
- SVG: authoritative initial CPU/WASM probes are tied to e002c8fe…. A later transitional batch changed WASM identity from 7763b301… to faf8c90a… during the observation window; that batch is retained but is not counted in the verdict and is not attributable to a single final artifact. Consult the SVG report and manifest for exact suite/probe counts and pre-existing compatibility gaps.
- Startup, import/background and broad color reports are diagnosis-time evidence. Their use of “current” refers to the source/runtime snapshot recorded in that report. Later source changes do not retroactively turn their results into final-build validation.

## Corrections, negative evidence and restrictions

Canvas timing percentages for original candidate 84d00200… must not be relabeled as measurements of corrected Canvas f04c992f…. The corrected trace rerun proves counts and semantic hashes; no new speedup is claimed under concurrent build load.

Original failure logs, baseline comparisons, deliberate ownership failures and the old native negative-control OOM/false-success evidence are retained. A failure caused by infrastructure/OOM is not a clean corruption-detection pass. Read the corrected native negative-control result and its exit-37/timeout controls separately.

This publication does not claim browser CSP enforcement, browser input-to-display timing, GPU/display/pixel equivalence, native GUI confirmation, Electron IPC equivalence, physical-device behavior, native application color rendering, or complete import fidelity. Actual stdio CPU/native checks are distinguished from unrun OS socket checks. Missing original private samples remain missing; old real-117/optional external FIG/Sketch skips are not converted to passes. No restricted path was retried for this publication.

## Integrity and preservation

- publication.sha256 is the exact recursive membership/hash inventory, except that it does not list itself. Its own SHA-256 is supplied separately for root approval.
- provenance.json records every original external file hash, the published-copy hash, the path substitution, the original/restored name and exclusions. Existing reviewer hash manifests describe their original evidence bytes; they are not hashes of the sanitized copies.
- prior-evidence-preservation.json compares all 463 prior c11 ZIP verification payloads, including six legacy PNGs, byte-for-byte and by executable mode. It also checks the 824 existing verification entries captured when this additive task began. No older verification file is rewritten by this publication.
- raw-test-counts.json preserves literal counters with source line references. It intentionally has no sum. Multiple phases, expected failures, overlapping suites and different runtimes must stay separate.
- Full synthetic document payload values are omitted only where explicitly recorded in provenance; reproducible source views and original hashes remain. No executable binaries, rlibs/rmeta, images, fonts, databases or credentials are included.

## Portable source views

Independent tests, configs and historical source snapshots are dormant *.source.txt files. They are not automatically discovered by the product test runner and their presence is not proof of execution. Run restore-review-sources.py only to reconstruct copies into a new external directory. It never applies patches, modifies product files, installs dependencies or executes tests. It verifies every copied publication hash first.

Example, after assigning the variables to real paths:

```sh
python3 "$BUNDLE/restore-review-sources.py" --repo "$DESIGN_REPO" --out "$REVIEW_RESTORE" --build-root "$BUILD_ROOT" --link-node-modules
```

The output must not exist and must be outside the checkout. The optional node_modules links point only to the checkout's already installed client dependencies. The helper reports missing prerequisites and unresolved historical placeholders in RESTORATION-STATUS.json. That output is a local restoration status, not acceptance evidence.

The normal independent TypeScript tests require the complete checkout and its existing Node dependencies, generated JavaScript/WASM and fonts. Explicit omitted prerequisites include frontend/design-client/public/fonts/NotoSansSC.ttf, testing/verification-font-batch/fixtures/noto-latin.ttf, the existing real FIG fixture testing/fixtures/design/figma-materials-native-2026-10-08.fig, and generated design_kernel_bg.wasm. SVG baseline comparison also requires the three existing import-svg/import-svg-viewport/svg-presentation.before.ts files under testing/verification-svg-compatibility. Consult source manifests for the recorded identities; a different binary requires a new, separately recorded result.

MCP SQLite tests require BUILD_ROOT/cargo-target/debug/futureox-design-desktop-backend. Native process tests require BUILD_ROOT/cargo-target/debug/design-render. Native codec/benchmark checks additionally require rebuilding the repository's rust-codec-fixture.rs fixture; its executable is intentionally absent. Sketch independent-after.rs requires a fresh matching futureox_design_kernel rlib and serde_json rlib; normal Cargo can regenerate them. Historical rustc command files retain dependency filenames as evidence, but are not guaranteed to match a different local toolchain's artifacts. Do not copy a newer binary into a historical result and keep the old attribution.

After restoration, examples of focused commands are:

```sh
cd "$REVIEW_RESTORE/review-canvas-font"
node "$DESIGN_REPO/frontend/design-client/node_modules/vitest/vitest.mjs" run --config vitest.config.ts
cd "$REVIEW_RESTORE/review-mcp-export"
node "$DESIGN_REPO/frontend/design-client/node_modules/vitest/vitest.mjs" run --config vitest.config.ts
node --test lifecycle.test.mjs
node --test --test-concurrency=1 "$REVIEW_RESTORE/review-native-transport/independent-boundaries.test.mjs"
```

These commands are examples, not commands executed by the publication step. Historical *.before files, patches and the superseded negative-control.before.mjs are forensic snapshots; relative imports in copied before snapshots can require reconstructing their original isolated module tree. The helper does not claim to rebuild that historical tree or apply those patches. Use the final independent tests above for current-source checks. Do not use the known permissive historical negative-control runner as a release gate.

Paths use __DESIGN_REPO__, __REVIEW_ROOT__, __BUILD_ROOT__, __PRIOR_ZIP__, __WORKSPACE_ROOT__ and __AGENT_HOME__ placeholders with explicit meanings in provenance.json. No machine-local workspace path is needed to interpret the published evidence.

The root-added aggregate files use <REPO> for the checkout, <BATCH> for the external current-batch evidence directory, <PRIOR_BATCH> for earlier external evidence and <TOOLS> for the external build/toolchain directory. These are attribution placeholders, not literal shell paths. aggregate-publication-provenance.json separately binds the 26 root-copied original files to their sanitized hashes; AGGREGATE.md and aggregate-results.json are root-authored summaries.

## Regenerating omitted font fixtures for independent source views

The source-only font portability correction adds testing/generate-font-fixtures.py, testing/font-fixtures-requirements.txt and testing/FONT_TEST_FIXTURES.md. The generator uses the existing baseline NotoSansSC.ttf (SHA-256 a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da) and requires Python >= 3.10 with fonttools==4.61.1 installed explicitly. It creates verified deterministic subsets in an external temporary cache; no fonts need to be added to the source ZIP. See the source-only generator documentation for installation and generation instructions.

For the two historical external font-review views only, pass the generated directory explicitly:

```sh
python3 "$BUNDLE/restore-review-sources.py" --repo "$DESIGN_REPO" --out "$REVIEW_RESTORE" --build-root "$BUILD_ROOT" --link-node-modules --font-fixture-dir "$GENERATED_FONT_DIRECTORY"
```

This validates the generated manifest, exact two filenames and file hashes, then redirects only the known readFileSync literal in independent-font.test.tsx and ownership-negative-control.test.tsx within the new external restored copies. It copies no font bytes, changes no published source view, performs no installation and executes no test. Without this option, the historical source views retain their original fixture paths and will require those explicitly omitted historical assets.

Generated fixture hashes are 32924279319ac4b9bd7c2a11512be33a0f77985c54a3b97ffd4f37fa15abdceb (Latin) and d364933e29d565ae7422d38abccd6965244246a917d31e1c1c531054a77fab8e (CJK). These differ from the original timestamped review fixtures. Treat any rerun using them as a new source/runtime/fixture combination; do not transfer the old log's pass result or original font identity to it. RESTORATION-STATUS.json records every restored source hash and the new fixture attribution.
