# Default-path pool maintenance review

Scope: read-only analysis of the existing `default-current-117` and
`default-current-fig` diagnostics, followed by one resource-lifetime change.
No image/filter/coverage arithmetic, export quality, editing or undo operation
was changed. The sequential-display candidate remains opt-in.

## Evidence before the change

The logs were recursively expanded from `batch` records and deduplicated by
`session/source/seq`. Each row below uses the recorded stage's `wallStart` and
`wallEnd`; it excludes setup and other stages. Fence time is host-observed
queue completion wait, not GPU-exclusive shader execution time. Tile counters
come from terminal `main/tile` records and are not added again from aggregate
request results.

| Default stage | All fences / wait ms | Pure pool maintenance / wait ms | Image-pressure maintenance / wait ms | Other dominant waits |
| --- | ---: | ---: | ---: | --- |
| 117, first 3200% | 64 / 878.9 | 4 / 28.7 | 2 / 38.1 | prefix scratch 20 / 306.4; image table 21 / 467.0 |
| 117, 100% zoom | 18 / 351.5 | 13 / 277.7 | 0 / 0 | periodic 4 / 72.6 |
| 117, 100% pan | 14 / 241.2 | 11 / 233.1 | 0 / 0 | cancellation 3 / 8.1 |
| 117, pointer drag | 18 / 419.6 | 7 / 208.9 | 8 / 144.8 | interaction 2 / 41.9 |
| FIG, first 3200% | 7 / 29.6 | 1 / 4.1 | 0 / 0 | periodic 6 / 25.5 |
| FIG, 100% zoom | 15 / 183.9 | 10 / 140.7 | 0 / 0 | periodic 5 / 43.2 |
| FIG, 100% pan | 20 / 274.9 | 16 / 240.2 | 0 / 0 | periodic 2 / 31.1 |

Pure pool rows require all of: `requiredBytes=0`, no allocation pressure,
`retiredKinds=1`, and working bytes at most 75% of that recorded frame's
budget. Image-pressure rows require bit 8 of `retiredKinds`; they can also
include pooled storage. The image-pressure rows are not admitted by the new
optimization.

The 117 first-3200% completed request produced 20 tiles, 20 exact image-table
builds and 15 horizontal-filter cache hits. Its material fields took 6.7 ms to
build, with 100 builds, no hits and 4,806,400 uploaded field bytes. The same
run's undo tiles reused 28 material fields with no rebuild or upload. The FIG
first-3200% stage had no image-table builds, no material-field builds and
145.4 ms of aggregate tile compilation. These results do not establish one
shared image-cache bottleneck for both documents.

The current diagnostics have no separate decoded-image hit/miss or source
upload counter. They do not prove repeated source decoding or upload.
`imageFor` does lazily re-upload a missing GPU source; the worker's separate
64 MiB decoded-image cache can still supply its immutable pixels. Active
image tables and pending table preparation already pin their actual source
texture. Exact tables are explicitly retired through an
`image-table-scratch` checkpoint, and frame finish waits before reading prefix
counters and releasing prefix scratch. Those mandatory lifetimes remain
unchanged by this patch.

## Change and safety boundary

The first patch kept ordinary free textures when maintenance had no allocation
request (`required=0`). The v2 follow-up also retains them when an explicit
allocation estimate fits the current frame budget. Both require no
evictable-image pressure, retired upload or reclaimable coordinate upload.
An already-free texture can be read and written again in the same command
queue without a CPU completion wait. This branch does not destroy a texture,
advance a completion epoch, allocate a replacement or claim pixels are ready.

The existing allocation gate remains authoritative. A real budget overrun,
a budget reduction below existing residency, image pressure and
upload/coordinate retirement preserve completion-before-destruction. The
fits-budget condition is now shared with the sequential candidate. Logically
retired image tables remain charged and pin their source; a successful
periodic finish or a genuinely needed pressure fence collects them.

## Validation

Initial targeted CPU transport/lifetime suites: **5 files, 117 tests passed**
(`reclaim-maintenance`, `renderer`, `stream-image-fields`,
`image-table-lifetime`, `nested-prefix-renderer`; Vitest 3.50 s).

Coverage includes ordinary and sequential queue-ordered reuse at
160/192/240/256 MiB, ordinary reuse without epoch metadata, incomplete
current-frame ownership, real allocation pressure, reduced-budget cleanup,
pending upload/coordinate and image retirement, and failed completion fences
preserving every resource owner. Existing batch-resource bounds remain
tested through explicit maintenance requests.

The v2 fits-request follow-up passed **5 files, 125 tests** (3.25 s):
`reclaim-maintenance`, `renderer`, `image-table-lifetime`, `whole-image-filter`
and `stream-image-fields`. It adds ordinary fits requests through the exact
budget boundary with active/retired tables and no epoch metadata, and real
pressure one byte beyond that boundary with successful and failed fences.
The 64-resource batch protection is still tested using actual upload retirement.

Native GPU comparison, whole-document edit/undo/export regression and actual
Electron A/B performance are still required after this source freeze. These
CPU tests do not certify native GPU pixel equivalence or elimination of
zoom-motion blur. The dominant 117 high-zoom prefix/table waits are not
removed by this patch.
