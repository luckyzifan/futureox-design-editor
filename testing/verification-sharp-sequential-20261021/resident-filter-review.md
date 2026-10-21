# Resident filter lifetime: v1 actual Electron review

This report analyzes existing completed runs. It does not launch an app or
generate a new GPU reference. `summarize-resident-filter.py` produces the
curated `resident-filter-summary.json` from their results, diagnostics and PNGs.
The source has since received the v2 fits-request maintenance change; the
measurements below are v1 evidence, not validation of that later change.

Each diagnostic line is recursively expanded through `batch`, deduplicated by
`session/source/seq`, and filtered to the stage's recorded `wallStart..wallEnd`.
Counts exclude setup, other actions and export. Queue wait is host-observed
completion time, not GPU-exclusive compute time. Aggregate request results
are not added again to terminal tile counters.

## 117

Each cell is **action-to-settled duration / fence count / cumulative queue wait**,
in milliseconds. Durations include the harness's original operation and settle
contract; they are not physical input-to-photon measurements.

| Stage | Default current | Cache checkpoint | Resident filter v1 |
| --- | --- | --- | --- |
| 100% zoom | 1022.7 / 18 / 351.5 | 851.4 / 8 / 220.8 | 929.5 / 8 / 294.8 |
| 100% pan | 1109.6 / 14 / 241.2 | 1017.4 / 15 / 331.9 | 951.2 / 11 / 209.1 |
| First 3200% zoom | 1342.1 / 64 / 878.9 | 1329.4 / 62 / 853.3 | 1304.5 / 33 / 790.0 |
| 3200% pan | 1115.5 / 14 / 439.9 | 1113.3 / 20 / 569.9 | 1314.0 / 10 / 647.7 |
| Nested pointer drag | 1157.0 / 18 / 419.6 | Not run | 443.7 / 3 / 80.9 |
| Undo edit | 789.3 / 10 / 280.1 | Not run | 759.9 / 10 / 301.1 |

First-3200% fence attribution:

| Reason | Default count / wait ms | Cache checkpoint | Resident v1 |
| --- | --- | --- | --- |
| Prefix scratch | 20 / 306.4 | 20 / 321.4 | 0 / 0 |
| Image table scratch | 21 / 467.0 | 21 / 447.8 | 0 / 0 |
| Admission | 22 / 105.3 | 20 / 84.0 | 27 / 575.8 |
| Periodic | 0 / 0 | 0 / 0 | 5 / 213.8 |
| Cancellation | 1 / 0.2 | 1 / 0.1 | 1 / 0.4 |

V1 removes the two dedicated lifetime fence reasons, but waits move to
admission and periodic boundaries. Total first-3200% wait falls by 88.9 ms;
the measured stage falls by 37.6 ms (about 2.8%). High-zoom pan regresses by
198.5 ms with 207.8 ms more cumulative wait. This is not a successful overall
high-zoom performance acceptance.

The completed high-zoom request still builds 20 image tables and uses the
same exact interpolation and filter math. The diagnostics record 20 prefix
counter samples in the default first-3200% window and five in v1; their map
waits total 2.2 ms and 0.7 ms respectively. No deferred-counter metric is
present in these logs, so a driver deferred count cannot be reconstructed.

The nested pointer drag improves strongly in this single run, with the same
authored final transform and complete-document undo. This does not establish
repeatability, a frame-rate guarantee or complete elimination of preview lag.

## FIG

| Stage | Default current | Cache checkpoint | Resident filter v1 |
| --- | --- | --- | --- |
| 100% zoom | 644.6 / 15 / 183.9 | 509.2 / 5 / 90.1 | 514.3 / 5 / 102.3 |
| 100% pan | 1105.7 / 20 / 274.9 | 944.2 / 1 / 43.2 | 932.6 / 1 / 42.2 |
| First 3200% zoom | 444.6 / 7 / 29.6 | 440.0 / 7 / 46.1 | 451.4 / 6 / 30.7 |
| 3200% pan | 1029.8 / 2 / 24.7 | 918.5 / 1 / 3.5 | 901.2 / 1 / 11.9 |
| Property X edit | 3418.2 / 4 / 74.8 | Not run | 3420.3 / 1 / 75.3 |
| Undo edit | 1848.8 / 4 / 89.0 | Not run | 1649.1 / 1 / 56.3 |

FIG has no prefix or image-table fence in these stages. V1's first high-zoom
wait is essentially unchanged; fewer admission waits at low zoom are visible.
The property-edit wall duration remains around 3.42 s and is not solved by
these resource-lifetime changes. The CPU flame work must be assessed separately.

## Pixel, export and history checks

For each document, all 12 resident-v1 settled canvas PNGs were compared with
their matching default stage. Every comparison first checks the source
fixture SHA, camera X/Y/zoom, DPR, viewport dimensions, capture mode and PNG
dimensions. All were equal; all **24 comparisons have zero differing RGBA
pixels**. The seven shared cache-checkpoint navigation PNGs per document also
have zero differing pixels. No crop, rescale, pixel masking or tolerance was
used. The actual canvas is captured by the existing compositor-buffer path.

Both resident-v1 runs also report a complete authored edit followed by exact
restoration of the full document hash through undo, with the original source
file preserved. Each document's actual exported selection PNG at **1×, 2× and
3×** has a file SHA identical to the corresponding default exported file.
The helper recomputes both files' hashes instead of trusting report strings.
The cache-checkpoint runs did not run these extended/edit/export actions and
are recorded as unavailable for those checks.

These are settled snapshots and selected-object exports. They do not certify
every intermediate zoom/drag frame, whole-document export, physical frame rate
or absence of transient white blocks. The separate visual-motion audit and
raw GPU comparison remain necessary.
