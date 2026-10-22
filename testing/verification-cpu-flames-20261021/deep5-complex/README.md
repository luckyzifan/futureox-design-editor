# Deep5 actual complex-motion CPU flamegraphs, 2026-10-22

Open [the interactive flamegraph index](flamegraphs.html) or one of the four
standalone SVGs below. These are actual CDP samples from the immutable Deep5
Electron 117/FIG six-cycle motion audits. The complete diagnostic run still
fails sharp-navigation acceptance for both documents; see the
[application audit](../../verification-complex-navigation-20261021/DEEP4-DEEP5-APP-20261022.md).

| Recorded isolate | Profile window ms | Active sampled ms | Idle ms | Program/unassigned ms | Flamegraph |
| --- | ---: | ---: | ---: | ---: | --- |
| 117 renderer | 27,517.081 | 7,171.331 | 17,315.777 | 3,029.120 | [SVG](117-continuous-wheel-renderer.svg) |
| 117 render worker | 27,517.142 | 5,409.283 | 21,933.809 | 173.093 | [SVG](117-continuous-wheel-render-worker.svg) |
| FIG renderer | 23,609.981 | 9,128.676 | 10,443.289 | 4,036.594 | [SVG](fig-continuous-wheel-renderer.svg) |
| FIG render worker | 23,610.601 | 4,774.303 | 18,735.085 | 100.844 | [SVG](fig-continuous-wheel-render-worker.svg) |

## Identity and method

The four original raw profiles were not rewritten. Their nonnegative
`timeDeltas` were checked, and profile hashes match [summary.json](summary.json).
Run aliases are symbolic links to the original ignored raw-run directories.
No timestamp shifting, resampling or repaired negative weights were applied.

Both runs captured the same **42 runtime artifacts**: 40 JavaScript/source-map
files plus one WASM and one CSS artifact. Every copied artifact in the ignored
`deep5-flame-runtime` tree was checked against both captured manifests. The
analyzer additionally lists the **16 JavaScript/source-map artifacts it used**
for symbolication; those hashes were checked too. Source-map positions refer
to this captured build, not subsequent checkout edits. The common runtime
manifest SHA-256 is
`0de28a2f723afe7c7ae5c39d43606534d3862e5b0a42711e28c6a5c2e9788e63`.

The audits explicitly recorded `profile: true` and a non-interrupted native
trace boundary. The unrelated extended-profiling flag was false; provenance
is the actual motion CDP capture. Recorded target metadata identifies the
render-worker isolate. Weights use `samples[i] × timeDeltas[i]/1000` in
milliseconds. Inclusive rankings count an identical frame at most once per
sample to avoid recursive double counting. SVG width normalizes active
samples, while idle/program time stays explicit in the summary. These are
calling-stack flamegraphs, not timelines.

## What the sampled stacks show

In the 117 worker, useful paths include `drawBundle` (716.559 ms inclusive),
`streamIsolatedFilter` (635.068 ms inclusive), `paintOver` (487.028 ms inclusive)
and image-table planning (67.364 ms self). Image-range certification sampled
59.996 ms self. Its Deep2 value of 609.914 ms used a different trace window and
anchor workload; the ratio must not be presented as a controlled 90% speedup.

The 117 worker also spent 471.975 ms self in diagnostic `sanitizeFields`,
317.878 ms in `self.onmessage` and 236.199 ms in GC. These recorded diagnostic
costs are real CPU work but are not evidence of a GPU rendering optimization.

For the FIG renderer, React scheduling/commit stacks are prominent:
`performWorkOnRoot` is 5803.501 ms inclusive; `ProgressiveSurfaceImpl` is
503.108 ms self and GC is 514.942 ms self. Screenshot/readback instrumentation
also appears (`getImageData` 326.570 ms and `toDataURL` 287.948 ms self). Those
costs belong to this instrumented visual audit. They must not be counted as
clean production input latency.

The FIG worker shows presentation/composition and diagnostics, including
`draw` (1771.918 ms inclusive), `compositeDrawPlan` (351.874 ms self) and
`sanitizeFields` (569.797 ms self). Actual sample-only lifetime execution was
confirmed for managed 117, while this unmanaged FIG was excluded by that
build's gate. CPU stack width alone cannot establish shader execution.

The 117 worker and FIG renderer flamegraphs were visually inspected as part of
the diagnostic review. No GPU/profile run was repeated to produce this README.
Only captured CPU isolates are sampled: preparation/native processes and GPU
execution remain separate evidence. WASM indexes remain literal; no Rust
symbols were invented. Do not add main/worker profile windows as wall latency,
convert epoch trace boundaries into CDP monotonic sample clocks by guessing,
or label idle/program time as GPU-only waiting. Submission ACKs and sampled
omission checks do not prove every frame was sharp or establish physical FPS.
