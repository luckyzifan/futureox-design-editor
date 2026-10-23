# e411 import increment: integration preparation

This is a preparation record, not a shipped package or a test pass.

## Precise baseline

Bare Git commit `e411af08f7b3e901f83415932c05d50515a00cdd` already incorporates prior delivered increments. Do not instruct users to reapply old 518-based ZIP chains onto this main.

The detached validation worktree uses 3,204 Git-verified tracked inputs, including complete frontend and design-studio inputs. The other 1,149 tracked paths are explicitly marked skip-worktree. It is a sparse validation tree, not a full checkout. 3,201 frozen original files are hardlinked for reads; overlays always unlink and copy independently. Three updated main inputs total 53,809 bytes. Every reused original is rehashed after overlay.

Generated baseline WASM/bindings and installed Node dependencies are separately linked inputs, not Git source proof. They cannot certify new Rust input policy. Any replacement generated artifact must remove the link and create an independent output before writing.

## Supported rebuild after applying source changes

From `frontend/design-desktop`, run:

    bun run build --fast

This official e411 command does not skip Rust. It builds portable WASM through `build:kernel` (`build-web.py` defaults to release), typechecks and builds Vite, then builds all three native crates with the `desktop-dev` profile and installs the new backend/render/prepare binaries. The source manifest recursively fingerprints `design-studio/crates/design-kernel/src`, including both modified policy files; the build compares source inputs before and after. Stop the old app and launch the successfully rebuilt output. Running only Vite or copying frontend source does not update native import enforcement.

`--fast` chooses the native `desktop-dev` profile; it is not a promise to skip source-dependent compilation. Existing Cargo artifacts may be incrementally reused only under Cargo's actual source dependency checking.

## Evidence categories

Report independently: frontend input-admission boundary stubs; real callback/ownership traces; Rust module boundary tests; complete source-matched WASM import; full native desktop backend; real 117 import; GUI/hardware GPU. A File.size=1GiB stub is not 1GiB allocation, parsing, saving or rendering. Preserve archive expansion, ratios, entries, pixel and output safety limits. No new database migration in this change; code rollback does not downgrade existing database schema.

## Resource gate

No heavy gate has run from this tree. Planned frontend suite is the existing 36-suite combination plus seven new import suites (43 total), followed by separate zoom/overlay and Node gates. No historical green result is a current combination result.

A clean policy-only WASM functional build can reuse verified existing Rust dependencies but must rebuild the final crate from clean e411 plus the two policy files. Prior observed low-optimization build is opt0/ltooff/cgu256, approximately 1.49GiB sampled process-group RSS with raw53MB/generated44MB outputs. It is not an optimized performance build. Agreed start floor624MiB, early stop416MiB and absolute400MiB disk floor apply. Current free space is below that start gate; do not launch or reuse CPU ROI experiment output instead.
