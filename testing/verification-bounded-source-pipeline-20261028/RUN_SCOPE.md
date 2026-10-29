# Bounded native-source pipeline — 2026-10-28

Implement the user-authorized overlap of at most one CPU preparation job and one
GPU raster owner. GPU denotes a renderer task, not a physical GPU/core count.
Reuse PrepareAhead and the existing ordered preparation/GPU queues; change only
source viewport batching and required ownership checks. No quality, arithmetic,
color, image mip policy, effect, budget, storage, history or export relaxation.

Baseline: isolated working-tree snapshot in baseline.json, not HEAD alone. The
first snapshot observed concurrent unrelated source edits and was re-synchronized.
Existing generated artifacts and V43 differ from these inputs; rebuild matching
WASM/native products before hardware comparison. Build/test work is bounded and
must stop before performance runs. User-owned app windows/documents remain intact.

Pre-existing baseline issue: App supplies nativeSource/onNativeSourceStatus/
onOpenSourcePoint but Canvas lacks these props. Record the baseline type error;
investigate actual entry wiring before claiming product integration. Initial missing
untracked JSON fixture copies are a worktree setup failure, not a product failure.

## Frozen scoped acceptance

- Fixture: read-only local topology Sketch and 117 Sketch; hashes recorded before
  import. Synthetic cases may verify lifecycle but are not real-file speed claims.
- Same source, camera, viewport, DPR, runtime, precision and cache-state protocol
  for A/B. Baseline and candidate share the exact rebuilt native/WASM/GPU code.
- One uncounted warm-up per variant, then alternating A/B/B/A/A/B (3 measured runs
  per variant) per fixed view. Keep every failure/slow sample. No sampler during
  timed runs; diagnostic detail is identical. Report startup/load separately.
- Performance retention target: median viewport-to-ready improves at least 5%
  for the target CPU/GPU-overlap workload; report other workloads separately.
  First-visible median and cancellation-to-new-view median must not regress more
  than 10% (report noise/uncertainty; no unsupported physical latency claim).
- Correctness: identical final same-tier RGBA8 content pixels on every fixed view;
  same authored content, exact/export/HDR policy and unchanged budgets. GPU
  completion/readback and presentation ACK are not physical scanout evidence.
- At most one renderSource batch in flight, at most two tiles per batch and one
  speculative prepare. Each received tile can present immediately. Cancel/late
  replies, remount/source replacement and missing replies must preserve ownership.
- Tests: target component/controller and real worker preparation/cancellation
  regressions, typecheck (baseline failures listed separately), actual Metal GPU
  readback and visible GUI inspection, ordinary edit/undo/redo/save/export smoke
  on an isolated profile. Full G2/G5 and cross-platform remain NOT_RUN unless run.
- Do not adopt a measured regression as an optimization. If target fails, retain
  the candidate/evidence separately and report the result rather than change the
  frozen threshold or silently increase parallelism.
