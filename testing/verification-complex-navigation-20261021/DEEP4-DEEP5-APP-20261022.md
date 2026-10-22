# Deep4 / Deep5 complex Electron audit, 2026-10-22

**Both documents still fail the sharp-navigation gate in both builds.** These
are complete owned-session diagnostic runs, not successful rendering acceptance.
Each run exercised six cycles, 366 real wheel inputs and 960 pan inputs, with
content-bound screenshots and actual main/worker CPU sampling. Detailed
diagnostics, capture overhead, sampled cameras and differing profile windows
prevent treating these as a controlled latency comparison.

The anonymous [Deep4 summary](deep4-app-summary.json) and
[Deep5 summary](deep5-app-summary.json) bind exact fixture, authored-snapshot,
harness, build, runtime and result hashes. Raw reports, screenshots, pixel
buffers, user/node identifiers and image sources remain outside these summaries.

| Run | Submission ACKs | Sharpness violation records | Available references | Sampled omission | High-zoom content references exercised |
| --- | ---: | ---: | ---: | --- | ---: |
| Deep4 117 | 1,752 | 5,164 | 9/16 | unavailable: 7 reference errors | 4/4 |
| Deep4 FIG | 2,063 | 6,101 | 16/16 | pass, zero suspicious components | 7/7 |
| Deep5 117 | 1,835 | 5,402 | 16/16 | pass, zero suspicious components | 7/7 |
| Deep5 FIG | 1,804 | 5,316 | 16/16 | pass, zero suspicious components | 7/7 |

Violation records can overlap for one ACK: missing/fresh quality,
undersampling/upscale and input lag have separate checks. The counts are not
distinct missing frames. All reported omission checks retain
`allIntermediateFramesVerified: false`; zero sampled white/transparent regions
does not prove every intermediate frame was complete or sharp.

## Preserved failure and repaired reference execution

The original Deep4 117 evidence remains failed: seven post-motion fine
references encountered an invalid CommandBuffer. Only nine references were
available, so zero suspicious components among those nine cannot pass the full
omission gate. Those raw failures were preserved.

After the resource-boundary repair, Deep5 actually completed all 16 independent
post-motion references for both documents, with zero reference errors, zero
missing-texture samples and zero suspicious omission components. Its content
coverage controls exercised all seven high-zoom references for each document.
This is an actual repaired reference-execution gate, not a mock or removal of
the failed cases. It still leaves the sharpness gate failed. File and stored
authored snapshots were preserved; these motion audits did not separately
execute editing, undo or export actions.

## Navigation work, admission and incomplete sharp delivery

Deep4 emitted 188 native area-guard errors for 117 and 56 for FIG. Deep5 emitted
no primary area/byte-budget errors for either document. However recovered
internal failures are different from escaped errors: each Deep5 file retains
one recovered surface-budget failure in a later cancellation record. The
production record does not expose every recursive minimum-region refusal.
It would be incorrect to infer that all 64-pixel regions always admitted.

In Deep5 117, 86 live-preview requests made 782 compilation calls and 732
completed hydration calls; one published a complete result and 85 cancelled.
Hydration completion is not proof of completed GPU pixels. The atomic regional
assembler correctly withholds partial frames, but this can leave old complete
pixels visible while work becomes obsolete. The separate running-lease and
direct-large-regional-entry candidates were not part of this captured build.

One early whole request at physical zoom 35.628546359224416 incurred a prefix
budget retry and recovery. Its largest admission-labelled wait was 6155.2 ms,
approximately trace +1347.7 to +7502.9 ms; regional compilation began only near
+7519.9 ms. That request's total was 7024.8 ms and it finally cancelled. The
wait occurred inside the motion trace, but belonged to an older whole-camera
request's queued work and failed-encoder recovery. It is neither the latency
of an individual drag input nor exclusive GPU time for a named shader.

For the Deep5 117 gate's first 1,750 motion ACKs, only 74 carried fresh quality
measurements; nine had full sharp coverage and 60 measured an upscale. All 21
fresh high-zoom measurements still upscaled retained pixels and none had full
sharp/native-phase coverage. No ACK reported a missing texture handle. This
distinction explains why a complete visible old frame and responsive camera
ACKs can coexist with a failed sharpness gate.

The observed Deep5 input-to-submission ACK p95 was 28.4 ms for 117 and 28.3 ms
for FIG. These often acknowledge retained/reprojected pixels. They are not
input-to-new-sharp-frame latency, completion fences, scanout or physical FPS,
and are not a claimed speedup over Deep4.

## Actual sample-only execution and CPU evidence

The post-trace primary display driver's **lifetime** counters for 117 recorded
19,385 sample-only coverage passes, 423,428,820 pixel visits and 331 eligible
scenes. The last frame's counters were zero; reading only that frame would
incorrectly conclude that the candidate never ran. Lifetime values also
include startup work and do not measure only active motion.

FIG recorded zero eligible scenes and zero lifetime sample-only passes because
the captured candidate required managed color, while this FIG used the
unmanaged path. This is a scope exclusion, not a shader failure or evidence of
speedup. A later byte-format expansion needs its own GPU and application gates.

The [Deep5 CPU flamegraphs](../verification-cpu-flames-20261021/deep5-complex/README.md)
show actual sampled stacks. The 117 worker's image-range certification self
time is 59.996 ms in this recorded window. Deep2's 609.914 ms came from a
different window/anchor workload; their ratio is not a controlled 90% speedup.
Idle/unassigned CPU time and aggregate GPU completion waits do not identify
exclusive GPU hotspots. Low-latency sharp zoom/pan, cache revisits and complete
edit/undo/export behavior remain open acceptance gates.
