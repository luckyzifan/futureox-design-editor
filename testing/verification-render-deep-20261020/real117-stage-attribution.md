# Real 117 serial stage attribution — 2026-10-21

The probe uses the saved real 117 compiled node and imported document. It does
not change production code. Apple Metal (`metal-3`) completed the run without
browser or device errors. No timestamp queries were enabled.

| Stage | Regions | Measured runs | Median sum of isolated completion waits | Median encoding total | Draws per repeat |
| --- | ---: | ---: | ---: | ---: | ---: |
| Four samples: original interval masks + fused image resolve | 61 | 183 | 406.8 ms | 11.2 ms | 488 |
| Horizontal exact tent | 61 | 183 | 332.4 ms | 9.9 ms | 484 |
| Vertical exact tent | 18 | 54 | 151.9 ms | 2.3 ms | 144 |

Each region had one warmup and three measured runs. The source is the actual
736×414 managed image. The source support is 3484×3484, the output is 1032×1032,
and the device blur radius is 1224.3035888671875. Production strip alignment is
58 rows / columns, including the original shorter final strips.

Every measured stage used exactly one submission and allocated no new texture.
The real driver's uniform upload was drained before starting its completion
measurement. Readback/hashing, prefix counter copies and mappings, and the
original mode-0 assembly copies ran outside stage timings. The measured metric
is CPU wall time from submission through queue completion, not isolated hardware
shader execution time.

The horizontal prefix path accepted 13,936 channel-lines per repeat and declined
zero. Vertical accepted 4,128 and declined zero. Thus scalar prefix fallback did
not explain the cost in this crop. All four actually uploaded coordinate fields
matched the current WASM metadata hashes. Eighteen sampled warmup/final-repeat
raw-float hashes matched across source, horizontal and vertical outputs. The
assembled final float SHA-256 was
`c873b9851d802401397726abe59c790206112900839022a3dcf3b1a883c81b71`.

The source stage is the largest in this serial workload; horizontal filtering
is close enough that a source-only optimization cannot explain away all work.
The stage totals must not be multiplied by the viewport tile count to predict
editor latency: this probe deliberately fences each stage of each strip,
breaking production pipelining. It also excludes ancestor destination planes
and ordinary memory-pressure maintenance. Its measured texture peak was
86.29 MiB, below the complete editor's working peak. Other applications sharing
the physical GPU were not controlled.

Evidence is in `real117-stages-20261021/`: `fixture-summary.json`,
`gpu-result.json`, `results.json`, input hashes before/after, and progress records.
All recorded input hashes remained unchanged during the run. The preliminary
`--prepare-only` run performed CPU validation only and succeeded.

Reproduce from `frontend/design-client` after restoring the two local fixture
JSON files (or supplying their paths via `DESIGN_117_SCENE` and
`DESIGN_117_DOCUMENT`):

```sh
bun scripts/benchmark-real-117-stages.ts --prepare-only
DESIGN_TEST_OUTPUT=/tmp/futureox-real117-stages-fresh bun scripts/benchmark-real-117-stages.ts
```

The output directory must be absent or empty. `DESIGN_GPU_STAGE_REPEATS` accepts
1–5 (default 3). `VITE_DESIGN_GPU_TIMINGS=1` is rejected. Only one GPU experiment
ran during the authorized window. Preparation also passed `node --check`; no
whole-project build or production edits were performed.

Probe SHA-256:
`f2deeb5274ebfc063079f6ae1eaedd258a05d74ea1e544d0e3fd942614888c32`.
