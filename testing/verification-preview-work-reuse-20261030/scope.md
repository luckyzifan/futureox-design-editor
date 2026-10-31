# Frozen scope and checks

Baseline: current working tree, including pre-existing interaction navigation and scene-borrow changes (baseline.json).

Defects: PREVIEW-1 simultaneous unused preview plans; PREVIEW-2 camera-driven bitmap copying; PLAN-1 repeated structural bounds/topology on camera changes. Related G2/G3/G4/G6/G7.

CPU regression oracles: unchanged layer ordering, exact numeric bounds/parent matrices versus preimage; no plan/capture calls for unused paths; no bitmap use after camera/DPR/presentation mismatch; revoked scene borrows and mutable callers always re-evaluate. Frozen synthetic 300/3000/20000 vector cases measure production planner only, not real117/GUI. Single sequential benchmark, no concurrent heavy build. Capture quiet window: 150 ms; scene cache: one plan per renderer, valid published borrow required.

Environment: macOS local Node/Vitest, production TS with portable WASM where existing tests load it; capture/worker doubles explicitly mock. No Rust/shader/arithmetic/budget changes. Existing experimental navigation flag stays opt-in until separate GUI evidence.

Stop/cancel: owner disposal, revoked publication, page/session/selection/document change invalidate pending or cached work; preserve existing gesture abort and late-response guards. Full G2/G5 and hardware/real117 acceptance are NOT_RUN unless recorded separately.
