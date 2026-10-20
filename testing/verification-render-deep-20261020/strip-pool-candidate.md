# Parked strip-pool maintenance candidate

The candidate is not enabled or included in production source. Its complete,
replayable six-file change is preserved in `strip-pool-candidate.patch`.
The helper and its tests are included in the patch, rather than left active.
Horizontal filter reuse, column scheduling, and unrelated changes remain.

The actual Electron 117 comparison did not establish a useful improvement:

- First 3200% settling: 5.771 s, versus prior 5.830 s / 5.886 s runs.
- The candidate recorded 985 allocation-plan maintenance skips, but actual
  completion fences were 190, versus 189.
- Queue-completion wait was about 4.996 s, versus about 5.08 s.
- Reported texture peak increased from 263,160,640 to 267,806,176 bytes.

These are sequential local measurements, not a statistically established speedup.
The higher texture peak and unchanged fence count do not justify retaining this
candidate. Queue-completion waits must not be described as operator GPU timings.
The actual run artifacts remain in `strip-pool-117/`.

Before parking, the affected frontend suites passed 57 tests, desktop diagnostic
tests passed 19 tests, and TypeScript checking passed. These CPU checks did not
establish a performance benefit. Parking validation used `git apply --check` and
`git diff --check`; no new GPU experiment or build was started.

From the repository root, inspect or intentionally replay with:

```sh
git apply --stat testing/verification-render-deep-20261020/strip-pool-candidate.patch
git apply --check testing/verification-render-deep-20261020/strip-pool-candidate.patch
git apply testing/verification-render-deep-20261020/strip-pool-candidate.patch
```

Patch SHA-256:
`8b00f352e15f3830df49f24b630bd0793d7b36a7d71f86dbb38e6ebe28d8542b`.
