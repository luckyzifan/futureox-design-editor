# Exact shared image bilinear weights

**Parked, not active in production.** The implementation, tests and GPU probe
are preserved in [shared-weights-candidate.patch](shared-weights-candidate.patch).
An integrated run showed a cold-load regression; compilation/run-order effects
were not isolated sufficiently to accept this candidate. The GPU comparison
itself passed 33,344 components, which does not establish a latency improvement.

This candidate is limited to the WebGPU `imageCoordinateSource` adapter. It adds `image-bilinear-weights.ts`; the shared `sampling.wgsl`, its scalar `bsBilinear`, and its vector `bsBilinear4` remain unchanged and independently callable.

## Exact arithmetic boundary

For admitted fractions `u = U / 2^ku` and `v = V / 2^kv`, with `ku,kv <= 31`, the candidate builds these four unsigned 64-bit weights once:

```text
w00 = (2^ku - U) * (2^kv - V)
w10 = U * (2^kv - V)
w01 = (2^ku - U) * V
w11 = U * V
```

They sum exactly to `2^(ku+kv)` and are at most 62 bits. Each needed color channel retains its own original exponent minimum/maximum, span gates, signed mantissa products, a/b/c/d accumulation order, four-limb accumulator and final nearest-even rounding. No intermediate floating reduction or approximate weight is introduced.

Invalid weights and all four corner combinations delegate to the original vector sampler. Channels with a nonfinite neighbor or a constant normalized value delegate to the original scalar sampler. This preserves nonfinite-neighbor priority even for zero interpolation weights, invalid-weight NaN payload selection, signed-zero canonicalization and constant-color behavior. No shared plan is built when every channel takes an original early return.

A fraction denominator beyond 31, unsupported exponent span, or any unsuccessful bounded result delegates to the original sampler, retaining its bounded → windowed → 19-limb fallback sequence. The original program-limit arguments remain intact.

`displayArithmeticSource` has one optional adapter branch: when the new helper exists, it delegates that helper to `bsBilinear4`. The display specialization has already replaced that original entry with its native mix, so the candidate does not accidentally force exact sampling onto the established display-math path.

## Validation completed by this agent

```sh
cd frontend/design-client
node node_modules/vitest/vitest.mjs run src/kernel/gpu/image-bilinear-weights.test.ts --maxWorkers=1
npm run typecheck
bun scripts/check-image-bilinear-weights.ts --prepare-only
```

- CPU: 17 tests passed, no failures/skips, 0.807 s.
- TypeScript: passed.
- Probe preparation: succeeded without launching a browser or GPU.
- Prepared cases: 8,336, comprising 8,107 existing independent corpus rows, 199 mixed-RGBA cases assembled from independent rows sharing the same weights, and 30 explicit boundary cases.
- Prepared shader SHA-256: `49f09c3a76e33400ac8976c58525e6b8d2dd208883e2a98c848e7060ca86c1a8`.
- Fixture SHA-256: `1d177df9959669266ab345cd6b1a1424a2ca39060d39a5a60413e4e65b710f2c`.

The CPU harness executes the candidate WGSL control flow with exact BigInt primitives and independent rational rounding. It checks full 64-bit weight products, denominator limits, sum invariants, per-channel early returns, NaN/Infinity priority, constant alpha, exponent-span gates, cancellation, original corpus expectations and preservation of the display adapter. This is not native WGSL execution.

## Serial actual-GPU entry point

```sh
bun scripts/check-image-bilinear-weights.ts
```

An optional `DESIGN_TEST_OUTPUT` selects a new empty evidence directory. The existing `runProof` harness records source hashes and rejects changed inputs. In each compute invocation, identical neighbors and weights are passed to unchanged `bsBilinear4` and the candidate helper. Both four-channel results are stored as raw u32 bits and checked against each other and the independent expectations. The output separately counts reference/oracle, candidate/oracle and candidate/reference mismatches.

The parent agent subsequently ran the actual probe on Apple `metal-3`. Its [recorded result](gpu-shared-weights/results.json) contains 8,336 cases / 33,344 RGBA components, with zero reference/oracle, candidate/oracle or candidate/reference mismatches and no recorded errors. Shader and fixture hashes match the prepared values above.

This agent did not run a GPU probe or build. The GPU result was produced by the parent and inspected read-only here. It establishes the tested helper-level device bit parity; integrated image-coordinate/fusion behavior and latency improvement still require the parent's matched Electron measurements.

## Performance limits

When all four channels reach the nonzero positive-weight path, source-level fraction decompositions decrease from eight to two and 32-bit wide-multiply helper calls from 48 to 36. With constant alpha and three active color channels, the multiply count changes from 36 to 28. These are arithmetic counts, not measured GPU instructions or speedups. Early-return predicates, retained weight registers and value passing add costs; unsupported paths may repeat the original fraction work. The candidate must pass actual device parity and matched timing before any performance claim.

## Frozen source identity

Paths are relative to `frontend/design-client`, except the final shared shader.

| File | SHA-256 |
| --- | --- |
| `src/kernel/gpu/image-bilinear-weights.ts` | `2b6c759cf4b78c0fa82305d212bfc5259d361f01a1db2be2873b1dbc062fa855` |
| `src/kernel/gpu/image-bilinear-weights.test.ts` | `9b4c673ab3161da3177958aaba6a7391d38d361c778196c02dead878157a340f` |
| `src/kernel/gpu/image-coordinate-source.ts` | `738583541c278b21ba3f98c3a03f15b947a2a016ef4ad47d2ab967a35200cee9` |
| `src/kernel/gpu/display-arithmetic.ts` | `2e965c59053e1c101acd07c3875ca7a1499903a03e2ba733bc4eb7487821a97e` |
| `scripts/check-image-bilinear-weights.ts` | `9a1bb75e7410ac364a559c2cb562f4baeb7456d5d3429e776952b5b1642dc364` |
| `design-studio/crates/design-kernel/shaders/sampling.wgsl` (unchanged) | `db81805562ebc3853f9e30f3dc0512c3a5cfa4cb4378db7baa52d12e9b941bde` |
