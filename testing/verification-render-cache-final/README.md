# Render/cache optimization evidence

This is the additive evidence publication for the batch after delivered archive
`02241e7467435d4e47a79041d0fccfea234c52d1b3a3b0e46eaa8f781ff1bafb`.
The required Git base is `71d32153e6f55b3723c99708b4c4c49ac7342e67`.
Prior delivered files, evidence, release support and source snapshots are not edited.

**Owner evidence and the root CPU aggregate are complete.** Root accepted the CPU
aggregate and the independent auditor confirmed its before/after identity comparison.
Final archive construction/verification and publication approval remain separate.
`AGGREGATE_RESULTS.json` records the final selected suites and separate native runs;
`FOCUSED_RESULTS.json` preserves owner-checkpoint counts. `SOURCE_IDENTITY.json`
reconciles exact owner/reviewer source hashes. No GPU/GUI acceptance is implied.

## Evidence layout

- `aggregate/`: selected runner logs/results, compact official Vitest counts, fresh
  backend 90-pass/1-ignore evidence, root acceptance and independent freeze comparison.
- `independent-review/relocated/`: fresh external-directory 7-test and 196-check
  reproductions, using explicit repository and executable paths.

- `image-hydration/`: default render-worker optional hydration, actual CPU pixel/packet
  equality, production renderer upload selection at a recorded device boundary, source
  hashes, raw ABBA samples and negative controls.
- `scene-reuse/`: mounted production Canvas/Editor CPU traces, ordered scene/index
  equality, raw baseline/candidate ABBA samples, controls and exact source identities.
- `workspace-observe/`: real SQLite/stdin/stdout correctness, canonical hash/work
  counts, full backend suite and raw ABBA child-process CPU/stdio wall samples.
- `independent-review/`: independent cancellation, color-priority, ownership and
  randomized SQLite protocol checks. Expected-failure baseline controls are explicitly
  distinguished from candidate passes.
- `COPY_PROVENANCE.json`: exact source/copy SHA-256, byte counts and declared text-only
  path normalization. Executable sources and source snapshots remain byte-exact.
- `supplemental-root-relative.sha256`: separately approved exact repository-relative
  inputs required by shipped tests and benchmark runners. Surrounding evidence folders
  are not implicitly included.
- `publication.sha256`: exact recursive manifest including aggregate and relocation
  evidence. Its proposed digest requires independent root approval.

## Boundaries that must survive publication

Image tests use real portable WASM decoding/CPU pixels and actual production worker
and renderer cache code. GPU devices and image persistence are doubles. ABBA hydration
uses a structured-clone in-memory store with real persistent SHA-key computation, so
it is not a real IndexedDB/disk, GPU, frame-rate or input-to-display measurement. The
64 MiB returned-payload work/residency accounting is not an IndexedDB clone/peak-memory
cap, and in-flight IndexedDB/crypto work is not aborted. Complete compilation and
synchronous full-quality fallback remain required when optional hydration is absent.

Canvas timing uses mounted production Canvas and real Editor/WASM with a mock DOM
and renderer boundary. It measures CPU-path elapsed time, not OS process CPU, browser
or GPU display latency. Two ABBA samples per variant are descriptive. Necessary new
snapshot work remains; camera/hover/selection zero-work cases were already baseline
behavior. Ownership is bounded to current/displayed snapshots and a scalar refine
record, not a process-memory ceiling. Existing global font-environment behavior is
not redesigned.

Workspace timing uses real SQLite and independent baseline/candidate processes through
stdio, dev opt-level=0/debug=0. Every poll still executes the full ordered SELECT and
entry equality. Linux process CPU ticks exclude harness/external-writer CPU; wall
samples include pipes and Python JSON parsing. Release/desktop-dev, UI, GPU and whole
application speedups are not established. The 4 MiB retained snapshot accounting is
not a process/transient/concurrent-memory ceiling. Schema remains 5.

A coordinated low-load window among these tasks is not guaranteed exclusive-host
execution. Raw slow/outlying samples are retained. Counts from different frameworks
are reported separately, not added into a misleading assertion total.

See `REPRODUCE.md` for dependencies, source-only fixture preparation and explicit
commands. No restore or preparation script automatically runs product tests.

## Provenance and sanitized text

Owner JSON manifests continue to identify the exact original tested source/report
bytes. Where a report/log is a path-normalized view, its copied SHA-256 differs;
`COPY_PROVENANCE.json` records both identities and every prefix/count changed.
Numeric timing samples, expected/actual values, test names, pass/fail counts and
source hashes are not rewritten. `${REPO}`, `${EVIDENCE_SOURCE}` and `${PRIOR_RELEASE}`
in non-executable text describe original machine locations, not runnable shell
variables unless the reproduction instructions explicitly define them.

Byte-exact independent review sources intentionally retain their original absolute
module identifiers as provenance. The shipped Vite alias maps that single declared
prefix to `REVIEW_REPOSITORY`; no product source import is changed. Source snapshots
are code/text only. Original build artifacts, original databases, intermediate
failed fixture-development logs and machine-local toolchain setup remain outside
this compact publication. Relevant expected-failure controls and dependency-lint
blockers are included with their actual status.
