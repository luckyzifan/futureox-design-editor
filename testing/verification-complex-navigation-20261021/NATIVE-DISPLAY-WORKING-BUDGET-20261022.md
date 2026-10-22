# Native display working-set admission candidate, 2026-10-22

This separate candidate lets admitted SDR display work use the renderer's
existing native working-set policy. It does not change sampling, four coverage
phases, material/filter arithmetic, halo bounds, raster dimensions, texture
formats, editing, undo or export. It does not change GUI tile/history budgets
or preallocate memory.

The previous budget decision admitted the native policy only for
`driver.captureDisplay && !scene.coherentSamples`. Consequently a managed
four-phase display scene and its bitmap-assembly work used the ordinary
256 MiB policy even when they served the same display. Actual asset-pressure
investigations remain separate evidence; this policy correction alone proves
neither cache retention nor lower latency.

## Admission boundary

The new alternative requires all of the following actual host/render inputs:

- Strict launch flag `VITE_DESIGN_NATIVE_NAVIGATION === '1'`.
- Actual driver name `webgpu`, `managed === true`, and `hdr === false`.
- Actual `GpuRenderer.render` arguments `readback === false` and
  `present === true`.
- No software raster mode; absent/false is accepted and unknown values reject.

Scene declarations such as `displayTentRadius`, `displayImageSource` or
`nativeInteraction` do not grant the alternative. A purported
`captureDisplay` value cannot enable the new coherent branch. The real render
entry owns output intent; documents/request scene metadata do not replace its
readback/presentation arguments. Unknown callers and non-display outputs do not
gain admission. Pure display resolve/presentation metadata does not turn an
already-admitted display back into the 256 MiB tier.

The established noncoherent capture branch is preserved independently,
including its previous transport exceptions. Thus the tests distinguish
unchanged legacy behavior from the new branch; they do not silently tighten
old readback cases while adding a display policy.

## Existing limits remain authoritative

Without an explicit configured limit, the existing native strategy starts at
512 MiB, scales its allowance from the actual target size and existing optical
headroom policy, and remains bounded by its 1 GiB ceiling. This is an admission
policy, not a query or promise of free VRAM. Existing byte allocation checks,
device resource limits, native 16M-pixel/coordinate guards, pressure eviction
and exact fallback/error handling remain in force.

The trusted explicit `CORE_GPU_WORKING_BUDGET_MIB=256..4096` override remains
first priority, using Number arithmetic. In particular explicit 256 stays
256 MiB, and explicit 4096 remains 4,294,967,296 bytes without unsigned wrap.
No code selects 4 GiB automatically. Interaction/GUI residency has its original
independent allowance, even when bitmap work changes its working-set tier.

## CPU verification and identity

```sh
node node_modules/vitest/vitest.mjs run src/kernel/gpu/working-set-budget.test.ts
```

From `frontend/design-client`, **22 tests passed**. The integration controls
execute the real render entry through its budget calculation and stop at a
preparation sentinel before any allocation or GPU encoding. They cover
coherent resident/bitmap consistency, pure display resolve/presentation,
actual target-size growth, strict flag/boolean gates, flag-off scene hints,
readback/export transport, HDR, software, other/unknown drivers, unchanged
noncoherent capture behavior, and explicit 256/512/1024/4096 overrides. They
also assert no allocation and no changed interaction-cache allowance.

Frozen source SHA-256 values at this CPU checkpoint:

| Source | SHA-256 |
| --- | --- |
| `renderer.ts` (combined source) | `92434e63e7bb44e32d3a024d3f5c06993e66a2e2f8a5d0886854a6f5c8ea0326` |
| `working-set-budget.ts` | `4972b1d40c97057dcb3fdf6703e0acc0706dbf3f1ec2d5ddcfcbc17940ab99d1` |
| `working-set-budget.test.ts` | `51d9e38e5dd90e8355e3161f171955f74358f1e605bdd3d2fa896022087f011f` |

`git diff --check` passed. No new GPU, Electron, build or performance run is
credited to this CPU checkpoint. The next actual-device comparison must keep
auto, explicit 512 and explicit 256 results separate, record the executed
working policy and source/build identities, and verify actual image uploads,
pressure eviction, pixels, sharpness, white-block behavior and complex input
latency. A larger admitted working set is not a successful experience gate.
