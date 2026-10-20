# 2026-10-20 linear image axis CPU change

This is a targeted native correctness record for the CPU hotspot identified in
[the actual Electron profile](../verification-real-electron-flames-20261020/README.md).
It is not a fresh Electron latency measurement or GPU/pixel acceptance.

## Change and invariants

`image_sampling_axes_placed` now certifies only its requested sample plane.
Each returned field and the renderer's representation flag belong to that
sample. A different phase can independently fall back to the dense field.
The two endpoint evaluations also supply the output cell and fraction, avoiding
the former output evaluation after all five phases were checked.

For a successful compact field the source-level evaluation count changes from
`11 × (width + height)` to `2 × (width + height)`, an 81.8% reduction. This is
derived from the loops, not a measured speedup. Cover/contain placement
constants are calculated once per axis. Without a paint transform, only the
requested row of the inverse is evaluated. With a paint transform, the
original full point chain is retained, including signed-zero multiplication
and nonfinite intermediate behavior.

No coefficients are rounded or composed differently. Exact cell bits,
fraction bits, contain's below/inside/above class, all original bounds, and
the dense fallback remain. The output still uses independent rows tagged
with `W = -1`; there is no public signature or wire change.

## Verification

Run from `design-studio`:

```sh
cargo test -p futureox-design-kernel --test image_linear_axes
cargo test -p futureox-design-kernel --lib prepared_linear_axes_match_original_point_chain_at_float_boundaries
```

Both commands passed: 6 integration tests and 1 targeted unit test, using
the checked-in Rust 1.96.1 toolchain and the unoptimized test profile.
The integration suite ran in 2.04 seconds; this is test execution time, not
a performance benchmark. Compilation emitted the existing unused
`over_rgba8_blend` warning.

Coverage includes:

- Dense field comparison of every accepted sample's cells/fractions as f32
  bits, with cover/contain/stretch, reflections, paint transforms, mip levels,
  atlas offsets and all five phases.
- A phase-sensitive fixture where the centre phase changes integer cell
  ownership and falls back, while all four subpixel phases remain compact and
  bit-identical to the dense field.
- Authored 360-degree trigonometric residuals at scale 128, 3480 × 64 strips,
  five strip origins and all five phases, with at least 20 compact cases
  actually compared against every dense pixel.
- One-texel contain geometry with two invalid endpoints surrounding valid
  interior samples; it still falls back.
- 17,280 axis comparisons against the unchanged `linear_point` chain, spanning
  adjacent binary64 values, signed zero, large coordinates, large/small
  dimensions, overflow and diagonal paint transforms.

The first new phase-sensitive test used a `1e-9` shear; that also crossed an
f32 fraction rounding boundary in a subpixel phase and correctly fell back.
Its assertion that all subpixel phases must be compact therefore failed.
The fixture was corrected to `1e-10`, which still crosses the centre's integer
cell boundary and keeps the other phases stable. The corrected suite passed.
The four pre-existing integration tests also passed before adding these cases.

## Source identity

SHA-256 after the final documentation-only comment update:

```text
2cf01577ffaeeb7f9143935ba167c101a8741798efc01b72ba034d787d7a475a  design-studio/crates/design-kernel/src/paint.rs
614fdb5f2f17b0055da83d229ca364bad2ba44def77f122bb7ad94b8e9e21a04  design-studio/crates/design-kernel/tests/image_linear_axes.rs
```

WASM, Electron, actual GPU resource lifetimes and combined renderer changes
were not built or tested by this targeted run. Regenerate WASM before testing
the native-crossing frontend path, then measure the same 117/FIG workloads
under the [development contract](../../docs/DEVELOPMENT_CONTRACT_V1.md).
