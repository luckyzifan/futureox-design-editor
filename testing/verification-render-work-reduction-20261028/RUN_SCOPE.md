# Rendering work reduction — 2026-10-28

This increment implements the requested mixed solid runs, independently certified
constant coverage, regional composition/gradient fusion, and work diagnostics.
The baseline is the existing dirty workspace, recorded in `baseline.json`; `before/`
contains unchanged renderer sources. User documents and running windows are not
test fixtures to mutate.

## Fixed acceptance

- Same-tier RGBA32F outputs: every finite component and signed-zero bit must match
  the frozen ordinary path. Keep all four correlated samples, original paint and
  blend order, HDR/export semantics, resource limits and completion ownership.
- Negative cases must reject the fast path before publishing an incomplete frame:
  unsupported paint/blend/clip, fractional lattice, nonfinite/overflow, cancellation,
  budget exhaustion and invalid/expired GPU resources.
- Work reduction: the affected fixtures must execute the production fast path and
  reduce actual draws or processed pixel area. CPU mocks establish routing only.
- Hardware comparison uses one local Apple Metal adapter, sequential runs, warm-up,
  alternating control/candidate runs, and no concurrent builds. Record absolute
  times, draws, pixels and peak bytes. A 5% median improvement is the retention
  target for each measured workload; no whole-editor FPS claim follows from it.
- Existing experimental flags remain off unless a test explicitly exercises their
  old candidate. New candidates stay opt-in until their independent hardware and
  affected application checks pass. Do not enable the whole old experimental stack.
- Full G2/G5, cross-platform and physical scanout are separate from this scoped
  increment. Failed/ignored/not-run results remain explicit.

## Order

1. Freeze inputs and run affected baseline checks.
2. Implement numeric diagnostics and each independently bounded optimization.
3. Rebuild WASM after Rust changes, run meaningful targeted/lifecycle regressions.
4. Run actual hardware bit comparisons and measured work reductions.
5. Verify the combined default build/real fixtures where feasible, document exact
   remaining boundaries, source hashes and rollback inputs.
