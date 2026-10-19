# Reproduce from the required Git base plus the source ZIP

## Inputs and preparation

Start with Git base `71d32153e6f55b3723c99708b4c4c49ac7342e67`, apply the root-reviewed
cumulative source ZIP using its checker/apply instructions, and verify both exact
publication manifests. This folder is not an independent product checkout.

Declare an absolute `REPO` for that checkout and a **new** external `OUT` directory.
Do not direct new logs at this publication or prior evidence folders. Do not reuse
unverified native/WASM artifacts from another checkout. Tests intentionally fail or
remain not-run when required generated runtime inputs are absent.

Required tools are the project's locked JavaScript dependencies, Node with
`node:module` registerHooks/stripTypeScriptTypes support (the recorded frontend runs
used Node 24.19.0), Rust/Cargo and the wasm32-unknown-unknown target, wasm-bindgen
matching pinned 0.2.128, and Python >=3.10 with fontTools==4.61.1. The Python stdio
harnesses use the standard library. Cargo.lock and frontend/design-client/bun.lock
are the dependency authorities. Dependency installation is a separate explicit step;
none of the evidence scripts install packages or fetch repositories.

Generate the portable WASM/JavaScript bindings from the delivered source with
`python3 "$REPO/design-studio/scripts/build-web.py"` and the documented toolchain.
Native sidecars are separately built from their stated source/profile. No compiled
WASM/native artifacts are embedded in this evidence publication. Record newly built
artifact hashes; byte identity across a different toolchain is not assumed. The
original measured WASM identity is recorded in the owner manifests.

Font tests use only the baseline Git font
`frontend/design-client/public/fonts/NotoSansSC.ttf`, SHA-256
`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
`testing/generate-font-fixtures.py`, `testing/font-fixtures-requirements.txt` and
`frontend/design-client/src/font-test-fixtures.ts` generate pinned Latin/CJK subsets
into an OS temporary cache. Do not copy local TTFs, base64 font dumps or private
fixtures into the checkout. Image data is generated from source with the existing
PNG encoder. SQLite harnesses create isolated temporary databases and remove them.
No actual database is shipped.

## Frontend focused checks

Run from `$REPO/frontend/design-client`, after explicit dependency/runtime setup:

    node node_modules/typescript/bin/tsc --noEmit
    node node_modules/vitest/vitest.mjs run src/kernel/scene-image-hydration.test.ts src/kernel/render-worker-image-hydration.test.ts src/kernel/decoded-image-cache.test.ts src/kernel/image-mip-cache.test.ts src/kernel/image-mip-cache-storage.test.ts src/kernel/render-work-queue.test.ts --maxWorkers=1
    node node_modules/vitest/vitest.mjs run src/canvas-scene-snapshots.test.ts src/canvas-event-batching.test.tsx src/canvas-selection-cpu.test.tsx src/canvas-selection-workflows.test.tsx src/editor-lifecycle.test.tsx --maxWorkers=1
    node node_modules/vitest/vitest.mjs run --config vitest.scene-reuse.config.ts
    CANVAS_SCENE_BASELINE=1 node node_modules/vitest/vitest.mjs run --config vitest.scene-reuse.config.ts

The exact baseline Canvas stays at
`testing/verification-canvas-scene-reuse-20261019/baseline/Canvas.tsx`.
The Vite loader verifies its hash and loads it at the original module location, so
production relative imports are preserved. The unchanged image-warmup source excerpt
and its provenance manifest stay at
`testing/verification-image-hydration-20261019/baseline-image-cache.txt` and
`testing/verification-image-hydration-20261019/baseline.json`.
All these paths require the separate root-relative publication approval.

From `$REPO`, after coordinating a quiet CPU window:

    node testing/verification-image-hydration-20261019/benchmark.mjs > "$OUT/image-abba.json" 2> "$OUT/image-abba.stderr.log"
    python3 testing/verification-canvas-scene-reuse-20261019/run-abba.py "$OUT/scene-abba"

The scene runner creates its result directory; choose one that does not exist.
The image benchmark emits all recorded ABBA samples and does not use performance
thresholds to turn tests green.

## Independent frontend review and baseline negative

Copy only `independent-review/*.test.ts`, `vitest.config.mjs` and the Python harness
into a new `$OUT/independent-review` directory. The review source uses original import
identifiers deliberately: the byte-exact config maps their known repository prefix
through `REVIEW_REPOSITORY`. Do not globally replace paths or rewrite product imports.

From `$REPO/frontend/design-client`:

    REVIEW_REPOSITORY="$REPO" node node_modules/vitest/vitest.mjs run --config "$OUT/independent-review/vitest.config.mjs"

To reproduce the prior color-resume negative, first export the unchanged original
worker into a new external file, verify SHA-256
`536bba8636d30cf866cf1503534e0fe71982b8b1790a669fde12aba2740b6f17`, then select it explicitly:

    git -C "$REPO" show 71d32153e6f55b3723c99708b4c4c49ac7342e67:frontend/design-client/src/kernel/render-worker.ts > "$OUT/delivered-render-worker.ts"
    REVIEW_REPOSITORY="$REPO" RENDER_WORKER_REVIEW_SOURCE="$OUT/delivered-render-worker.ts" node node_modules/vitest/vitest.mjs run --config "$OUT/independent-review/vitest.config.mjs" worker-lane-color -t 'priority-yield resume'

The two opposite-color-resume cases are expected to fail against that baseline;
this is a negative control, not a passing candidate run. The same-color and canceled
return controls are reported separately in the review.

## Native observation checks and benchmark

Build candidate and baseline sidecars independently, with separate external Cargo
target directories, from source under the same toolchain/profile. The baseline
`workspace-observe/baseline/workspace.rs` is byte-exact delivered source, SHA-256
`ec0ed2958ae8ddb23d5807a544f94f6039d23602e9f03d5a9d151ff8e15f3e18`.
For the baseline build, place that file at
`design-studio/crates/design-desktop-backend/src/workspace.rs` in a **separate** source
copy. All other backend dependencies must match the source identities in this batch.
Never overwrite the candidate checkout to obtain baseline results. The baseline
source does not include the new observe-test module declaration.

Run Cargo outside either repository, using explicit `--manifest-path`, separate
`CARGO_TARGET_DIR`, `--locked --offline` and the standard dev profile (opt-level=0,
debug=0). Offline mode requires dependencies already installed. Missing dependencies
are a blocker, not permission for an undeclared download or fabricated pass.

    cargo build --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend --bin futureox-design-desktop-backend --locked --offline
    cargo test --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend --locked --offline
    cargo test --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend --locked --offline --lib observe_tests -- --nocapture
    cargo clippy --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend --all-targets --no-deps --locked --offline -- -D warnings

Set `BASELINE_BINARY` and `CANDIDATE_BINARY` to the resulting independently verified
executables. Copy `workspace-observe/verify_stdio.py` and `benchmark_stdio.py` together
to a new `$OUT/workspace-harness` directory, then run:

    python3 "$OUT/workspace-harness/verify_stdio.py" --baseline "$BASELINE_BINARY" --candidate "$CANDIDATE_BINARY" --output "$OUT/workspace-results"
    python3 "$OUT/workspace-harness/benchmark_stdio.py" --baseline "$BASELINE_BINARY" --candidate "$CANDIDATE_BINARY" --output "$OUT/workspace-results"
    REVIEW_BASELINE_EXECUTABLE="$BASELINE_BINARY" REVIEW_CANDIDATE_EXECUTABLE="$CANDIDATE_BINARY" python3 "$OUT/independent-review/verify_observe_randomized.py"

Create the new workspace-results directory first. The benchmark is Linux-specific
(`/proc/<pid>/stat`) and requires a coordinated quiet window. The review harness
writes logs/results and isolated temporary databases beside its copied source, which
is why it must run from the new external directory. No published DB/binary fixture
is required.

## Aggregate result

Owner-focused checks and reproducible commands do not substitute for the root's
final selected frontend/backend/contract checks against frozen source. The root
CPU aggregate and independent interval freeze comparison are now recorded in
AGGREGATE_RESULTS.json; final archive acceptance remains separate.

## Actual-worker pre-fix negative source restoration

The separate author negative log executes the real worker event path before the
color-resume correction, rather than only the independent extracted branch.
`image-hydration/baseline/render-worker-before-color-fix.ts` is that exact source,
SHA-256 `7a294621d6a8c02940537cc88104fe877368e7a23f546dd3248d4e8917d106f0`.
Its faulty resume span is byte-identical to the delivered baseline and is recorded
in `image-hydration/baseline-lane-resume.txt` with identity metadata.

To repeat this expected failure, use another independent source copy, declare its
absolute path as `NEGATIVE_REPO`, and verify the snapshot hash above. Manually copy
only this source snapshot to
`$NEGATIVE_REPO/frontend/design-client/src/kernel/render-worker.ts`.
Do not place it in the candidate checkout or rewrite its relative imports.
From that separate copy's frontend/design-client, explicitly run:

    node node_modules/vitest/vitest.mjs run src/kernel/render-worker-image-hydration.test.ts -t 'resumed canvas tiles invalidate real image textures'

Expect two failures and nine deliberately unselected tests. The copied final
candidate test, real WASM and other declared candidate sources are the prerequisites.
The restoration step itself does not run tests, install dependencies, rebuild
artifacts or touch the candidate checkout. Keep its new output separate from the
published negative log.

## Final selected aggregate and additional native checks

`aggregate/run-final.source.txt` records the exact original orchestration as a
non-executable source view. Its machine-local setup paths are historical provenance;
do not execute it unchanged. From the reconstructed source checkout, explicitly
prepare matching native inputs and use a new external output directory.

In addition to the backend build above, the aggregate needs same-source
`design-prepare` and `design-render`, plus the existing source-only CPU codec fixture.
Build the named Cargo binaries using the locked workspace and declared toolchain:

    cargo build --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --bin design-prepare --profile desktop-dev --locked --offline
    cargo build --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-gpu --bin design-render --locked --offline

The codec fixture source is already part of the preceding cumulative source payload:
`testing/verification-native-render-transport/rust-codec-fixture.rs`. It imports the
unchanged production `design-studio/crates/design-gpu/src/serve_protocol.rs` at its
original relative path. Compile it to a new external output path with the same
Rust toolchain and the exact serde_json/base64 rlibs from that verified locked Cargo
build; declare `CODEC_DEPS`, `SERDE_JSON_RLIB` and `BASE64_RLIB` accordingly:

    rustc --edition 2024 -O "$REPO/testing/verification-native-render-transport/rust-codec-fixture.rs" -L "dependency=$CODEC_DEPS" --extern "serde_json=$SERDE_JSON_RLIB" --extern "base64=$BASE64_RLIB" -o "$OUT/rust-codec-fixture"

Do not substitute an undeclared cached binary. The historical build-codec-fixture.sh
contains a machine-local toolchain setup path; the explicit command above preserves
source imports and writes no generated binary into the evidence directories.

Set `DESIGN_PREPARE_BINARY`, `CORE_DESKTOP_SIDECAR`,
`FUTUREOX_BACKEND_TEST_BINARY`, `DESIGN_RENDER_BINARY` and
`DESIGN_RENDER_CODEC_FIXTURE` to those verified same-source binaries. Set `BUN` to the
installed Bun executable, and `VITEST_MAX_WORKERS=2` to match this run. From `$REPO`:

    node testing/verify-local.mjs --profile all --suites runner-contracts,frontend-contracts,desktop-contracts,python-tools,typecheck,frontend-vitest,mcp-example,bun-unit,automation-storage,mcp-contracts,native-preparation,native-sidecar --output "$OUT/aggregate-run"
    node --test --test-timeout=120000 --test-reporter=tap frontend/design-desktop/test/runtime/native-render-codec-runtime.test.mjs frontend/design-desktop/test/runtime/native-render-runtime.test.mjs
    node --test --test-timeout=120000 --test-reporter=tap frontend/design-desktop/test/runtime/workspace-selection-runtime.test.mjs

From `$REPO/frontend/design-client`:

    node node_modules/vite/bin/vite.js build --outDir "$OUT/frontend-dist"

Capture exit codes and logs separately. The exact selected suite list intentionally
excludes rust-cpu and OS socket integration. The previous kernel result of 1,194
passed/1 ignored is retained source-identical evidence, not a new execution in this
aggregate. The fresh backend invocation is separately 90 passed/1 ignored. Twenty-five
shared Node/Vitest registrations are intentional; do not sum all counts into unique
coverage. The MCP synthetic example's one test and visible-node checks are not GPU
pixel, aesthetic or whole-workflow coverage. Generated sample documents/exports/fonts
remain external and are excluded from this source-only publication.
