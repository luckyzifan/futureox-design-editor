# Futureox Design local v1 development contract

This is maintained project guidance, not a claim that every release gate has passed. Target: local application v1.0.0. Package manifests and the source increment must be checked separately before calling an artifact a 1.0.0 release.

## Architecture and product boundary

The [2026-10-28 exact work-reduction increment](../testing/verification-render-work-reduction-20261028/README.md) supplies separate default-on mixed-solid and bounded gradient-fusion paths, each disabled by its own explicit `0` flag. Constant coverage remains opt-in (`VITE_DESIGN_CONSTANT_COVERAGE=1`) because warm latency did not meet the frozen 5% target, despite exact pixels and reduced cold work. These do not enable the existing experimental painter/filter stack. Rust-authored bounded group plans and private actual-upload proofs remain mandatory. Gradient fusion preserves stored-paint rounding, the original normal-over writable ring and zero-weight neighbour behavior; HDR, nonfinite fields, unsupported clips and insufficient opportunities retain the original path. Diagnostics distinguish draw counts, measured rectangle area, cache rejection reasons and unmeasured work. Scoped hardware/real-file improvements are not full G2/G5 acceptance.

- Web and Electron reuse the same frontend, authored model, components, layout, typography, selection/edit semantics and history boundaries. Electron can provide native local acceleration, files, SQLite and scoped host dialogs; it must not become a second design product with divergent semantics.
- UI commands handle drafts, gestures and modal decisions. MCP translates discovered operations. Both reach the existing editor/domain implementation; automation stages a candidate and commits through Editor.change. Rust owns authoritative admission, layout and render semantics; TypeScript validation improves early diagnostics, not native authority.
- Keep local-first SQLite/Tokio and browser IndexedDB adapters. No new cloud accounts, collaboration service, arbitrary filesystem/network operations, or self-built AI workflow/model orchestrator. A client may inspect → edit → inspect using the published bounded operations; the server executes operations only.
- There is no obligation to preserve obsolete, unreleased application implementations. This does not license dropping current authored data, bypassing validation, or conflating independent version axes: app semver, FD binary format (currently 2), document schema (currently 1–20), automation capabilities (currently 1), FD extension contract (1), storage schema and editor/session/storage revisions.

## Forward extensibility without fictitious support

The optional document field is fdCompatibility with contractVersion: 1, requiredCapabilities: [], and extensions: a namespace-to-JSON map. Current code supports no required capabilities: any nonempty required list rejects. Add support only with a real implementation and paired native/frontend tests.

Optional opaque payloads remain inert and round-trip through native FD, editor history and local storage. Namespace syntax is lowercase reverse-domain/name, at most 128 ASCII bytes; at most 64 namespaces. Limits are depth 32, 100,000 JSON values and portable resource cost 1 MiB (128 overhead + 32 per JSON value + UTF-8 string/key bytes), separate from document wire limits. Do not normalize floats/nulls or rewrite scene arrays to satisfy a metadata budget. Reject malformed JSON values and unsafe keys before expensive serialization.

Whole-document open/save preserves the envelope. Append/import cannot safely remap opaque embedded IDs, so current append rejects nonempty optional payloads before modifying the destination. External FIG/Sketch/SVG fidelity remains independently limited; preserving FD metadata does not establish external-format or pixel equivalence.

Trusted host code may register synchronous operations, validators and pure deterministic expansion functions. Files cannot register code, select modules, fetch resources or authorize operations. This is not a sandbox for hostile same-process JavaScript. Extension discovery is implementation metadata, never a permission grant.

## Permission and commit boundaries

Read [local operation permissions](LOCAL_OPERATION_PERMISSIONS_V1.md) before changing grants. Trusted host policy binds exact document/session, explicit method names and read/write authority. Omitted policy retains trusted local authority; an explicit empty policy denies all. This optional seam does not automatically apply a page/node ACL or restrict every UI route. Native bridge opt-in and workspace/settings grants remain separate boundaries.

Validate schemas and all batch wrapper/leaf permissions before mutation callbacks. Expansion is trusted pure planning, not a side-effect mechanism. Stage in isolation and preserve atomic failure, locked nodes, references, layout, component overrides and one native undo entry. Recheck document/session/revision, authorization, busy state and pending input immediately before publication and after asynchronous host decisions. Never derive authority from FD metadata or request arguments.

## Local storage and readable history

- SQLite workspace/catalog pools use one connection each. Desktop runtime bounds admission to eight business requests and the trusted document transfer byte budget. Ordinary workspace mutations retain one FIFO worker; large source-file work has a separate single-worker lane, limited to two admitted long requests. Four blocking slots leave room for stdio/parsing alongside the two business workers. Blocking file preflight/parsing belongs in bounded blocking work; SQLx SQLite executes on connection workers. Direct library callers must bound their own concurrency. Queue/start receipts separate waiting from execution deadlines without implying a commit.
- Workspace WAL and synchronous=FULL, with BEGIN IMMEDIATE, atomically publish head, snapshot, resources/references and durable mutation receipt. Storage expected revision is separate from editor expectedRevision. BUSY/LOCKED and pool acquisition timeout report WORKSPACE_BUSY; no blind retry with changed content or a new mutation identity after uncertainty.
- Queued cancellation can prevent execution; cancellation after commit cannot promise rollback. EOF drains admitted work. A missing response can mean a successful durable write: reconcile or retry the exact identity/content.
- Saved history offers read-only snapshot preview and human-readable adjacent-revision differences: additions, removals, moves/order/transform, text and style changes. Show bounded paths and values, omit binary font/image payloads, and do not call a textual diff a visual comparison.
- Restore appends a new durable revision under the viewed storage-head CAS. It does not delete history or turn editor undo into disk rollback. Protect dirty edits, active input and new editing during asynchronous restore; report a durable restore that could not safely be adopted in the canvas. Browser retention is currently 50 revisions, not unlimited; UI diff rows are bounded at 500.

## Performance, rendering and interaction acceptance

The [2026-10-25 rendering pipeline increment](../testing/verification-render-pipeline-20261025/README.md) adds bounded subtree fragments, transport-independent exact source identities and cooperative preparation cancellation. These do not authorize approximate hashes, expanded memory budgets, cancellation of ordered mutations, or early release of in-flight resources. Preserve its per-backend cancellation and opt-in large-filter boundaries; scoped hardware pixel equality remains separate from whole-editor motion acceptance.

Performance work must preserve authored semantics, typography, transforms, clipping, material/effect output, HDR/float data, undo/redo and query results. Optimize from actual CPU profiles and named hot paths, not synthetic scheduling estimates. Keep baseline/candidate workloads, source/build hashes, timing units, warm-up, sample counts, run order, profiler overhead and correctness comparisons. A single sequential sampler-on run cannot support a general speedup claim. V8 symbols are real JS symbols; stripped WASM function indexes are not resolved Rust stacks.

CPU fallback must use the existing exact-frame handoff and handle missing adapters/device loss without reusing a GPU-transferred canvas as a CPU canvas. Cancellation or invalid input is not a rendering failure to hide. SDR presentation must visibly disclose retained HDR/float document data; HDR exports and data preservation do not prove HDR display output.

The desktop screen tier may use the existing four correlated samples at physical
screen density (`figmaSubpixel`) independently of export supersampling. Keep
`desktopFullMath` enabled: screen sampling alone does not authorize effect
omission, single-plane coverage, document float quantization or changed layout.
Explicit readback/reference, pixel preview, HDR and exports keep their requested
precision. Display quality is a separate cache identity, not an exact-output
certificate. Compare screen appearance and temporal stability on device; compare
same-tier cache/transport changes and exact exports strictly. Native image
arithmetic, if enabled, is a separately admitted finite-image display operator;
it must retain private upload-resource/range proofs, preserve the exact fallback,
and must not replace unrelated blend, coverage or filter arithmetic.

Nested pose reuse must retain the original painter order and all background
dependencies. A stored prefix owns immutable sample planes and restores writable
copies. Its storage remains in the working-memory ledger. Cumulative pose windows
are anchored to the initial capture, including repeated absolute poses on release;
the last recompiled node is not a stable origin. Input acknowledgements must refer
to the rendered snapshot and owner, never merely the latest received sequence.

VITE_DESIGN_DYNAMIC_UNIFORMS and VITE_DESIGN_KERNEL_CACHE remain default-off (enabled only by the explicit value 1) pending a separate actual-device gate. Their implementation gates are in frontend/design-client/src/kernel/gpu/webgpu.ts and renderer.ts respectively. Before enabling, verify pixel parity on difficult materials, real memory/resource lifetime, device loss/cancellation, interaction smoothness and supported platforms. CPU mocks or source contracts cannot discharge this gate. Ordinary established GPU rendering is a separate path, not disabled by this requirement.

The regional painter, capture-read, native-navigation and byte-alpha prefix
candidates (`VITE_DESIGN_EXACT_CLAMP_PREFIX`, `VITE_DESIGN_PAINTER_CAPTURE_READS`,
`VITE_DESIGN_NATIVE_NAVIGATION`, `VITE_DESIGN_BYTE_TENT_PREFIX`) are separate strict
opt-ins, pending whole-editor acceptance. Native dependency bounds must retain
the original backdrop capture origin, dimensions, clamp and every sampled
neighbour, including zero-weight nonfinite neighbours. A compact physical color
window must retain its complete logical target domain for later siblings.
Four coverage phases may share a mask only after proving their actual discrete
coverage equal against the frame's private uploaded program; similar span
metadata is insufficient. Finite individual HDR paints do not prove finite
accumulated output. Byte-alpha integer prefix does not authorize general RGBA
filters, fractional-radius substitution or a higher legacy shader guard.
Keep a rejected queue completion distinct from resource retirement. See the
[2026-10-22 diagnostic and gate record](../testing/verification-complex-navigation-20261021/DEEP-GPU-20261022.md).

`VITE_DESIGN_DISPLAY_TENT_RADIUS=1` additionally requires
`VITE_DESIGN_EXACT_CLAMP_PREFIX=1`. It is a separate default-off SDR display
approximation: explicitly scoped normal blur/backdrop axes may round radii
1..2048 to f32 only when the original native tap halo cannot grow. Both
kernel packets and the GPU filter contract must use that selected radius.
The worker must overwrite document/request intent, isolate every cache policy,
and report actual changed axes. Readback, export, HDR, software, other backends,
glass, gradient blur, byte shadows and unknown callers retain the original
radius. This flag does not extend the legacy whole-filter 512 guard or fix the
unsupported nested-interaction fallback. See
[display-radius evidence](../testing/verification-complex-navigation-20261021/DISPLAY-TENT-RADIUS-20261022.md).

An explicit desktop launch may choose `CORE_GPU_WORKING_BUDGET_MIB=256..4096`.
Missing configuration or `auto` preserves the existing automatic policy. The
host validates and freezes this optional working-set admission ceiling through
preload, the client and its worker; documents and per-frame options cannot set
it. Four GiB uses safe Number arithmetic, does not preallocate memory, and is
not an application-wide memory cap or a claim about available VRAM. Device
resource limits and the other cache/residency budgets remain independent.
Budget comparisons must use the same build and workload; a larger ceiling or
more completed frames does not establish lower input latency or sharp zoom.
See the [desktop launch configuration](../frontend/design-desktop/README.md).

Published-snapshot topology can be shared by camera-independent controls; mutable
edit drafts must still calculate fresh parent relationships. Resident preview
reuse requires the same document/revision, page/session, render contract, sample
camera/density and live GPU ownership. A sufficiently dense complete resident can
avoid a redundant coarse navigation capture, but cannot certify final native
sampling phase. Report actual revisit hits separately from newly fixed reuse;
existing exact native tiles already survive idle time within their LRU budget.
See the [actual CPU flamegraphs](../testing/verification-cpu-flames-20261021/README.md).

Exact prefix scratch and logically retired image tables may remain queue-ordered
between resident screen submissions. A submission acknowledgement cannot authorize
their destruction: retain their source ownership and full byte ledger until an
actual completion boundary covers the retired snapshot. Preserve pressure,
readback, cancellation, device-loss and periodic backpressure paths. Diagnostic
counter readbacks may be deferred to existing completion boundaries; their
sample counts are not complete per-frame totals. The raw-float lifetime proof
and actual motion checks are separate gates, recorded in the
[resident rendering evidence](../testing/verification-sharp-sequential-20261021/README.md).
`VITE_DESIGN_RESIDENT_FILTER_SCRATCH` requires the explicit value `1` and stays
off by default: its actual GPU parity proof passed, but a later whole-117 run
moved waits into admission and increased first-zoom latency. Do not promote it
from the reduction in fence count alone.

History/sidebar, layer/property changes and canvas gestures require pending-input/dirty-state guards and real interaction regression coverage. Hook/jsdom tests establish event/state behavior only; actual browser/Electron layout, focus, pointer behavior and visual usability remain on-device acceptance items.

## Testing and delivery

Use the existing suites, with exact commands and source/build identity recorded:

- Rust kernel/backend: cargo test for the affected package from design-studio, respecting the checked-in toolchain and lockfile.
- Frontend: run typecheck and targeted Vitest suites from frontend/design-client. Rust changes require regenerated portable WASM before authoritative frontend/native-crossing tests.
- MCP adapter: frontend/design-mcp npm run check and npm test use protocol/client/stream tests. test:integration creates actual sockets and is a distinct, environment-dependent gate.
- Actual Editor/WASM tests cover admission, authored edits, expected conflicts, rollback, one undo/redo transaction, metadata retention and export/import boundaries. Real SQLite tests additionally cover transaction rollback, lock contention, idempotence and process/database reopening.
- Record failed initial runs and corrected reruns, skips and mocks accurately. Never sum overlapping suite counts. Browser IndexedDB doubles are not physical persistence evidence; SQLite close/reopen is not power-loss/firmware evidence.

At the 2026-10-20 development checkpoint, reported targeted tests cover FD native/WASM admission/history, permission dispatch, granular/bulk mutations, typed node inputs, history diff/restore and real SQLite. CPU profile comparisons are mixed; isolated optimization measurement and broader final integration may still be running. No GPU, browser/Electron GUI, real socket, or external AI-client acceptance is established by that checkpoint. Consult the delivered verification manifest for final exact results, not this prose as a substitute for logs.

The [2026-10-21 rendering record](../testing/verification-render-low-latency-20261021/README.md) adds actual Metal-device float comparisons and matched isolated Electron checks. Its narrower image/prefix paths preserve the existing arithmetic and memory bounds; experimental tighter coefficient admission remains default-off after mixed whole-app results. These measurements do not establish instant high-zoom clarity, low-latency dragging, cross-platform smoothness or physical 90/120 FPS. Keep that remaining acceptance separate from individual optimization gains.

Each source increment must include the repository-local skill, maintained Markdown contracts, changed implementation/tests and reproducible evidence. Do not ship tokens, local connection details, invented endpoints or private assistant context. See [MCP operation guide](MCP_OPERATION_GUIDE_V1.md) and [release acceptance](LOCAL_RELEASE_ACCEPTANCE.zh-CN.md).

The [2026-10-21 functional integration record](../testing/verification-functional-merge-20261021/README.md) records the cumulative package's exact affected hashes while preserving newer rendering files. Imported historical test results and current combined-source regression are separate evidence. Independent-copy import, actual browser Worker lifecycle, protocol fixtures, native SQLite, real sockets and desktop end-to-end behavior retain their own acceptance boundaries.

The [2026-10-22 Electron cumulative integration record](../testing/verification-electron-cumulative-20261022/README.md) records the later localization, input/focus, command and regression-source merge. Its older exact package baseline was merged with current main; existing rendering and editor ownership protections remain in place. No tests, typecheck, build or actual application acceptance were run for that integration at the user's request; historical package results remain separately attributed.

The 2026-10-22 resource-aware capacity candidate replaces the accumulated native
32 MiB document and fixed 20k-node/100-page quotas with a trusted pinned memory
policy; desktop transport frames and untrusted archive/MCP protections remain
bounded independently. See [capacity policy and remaining physical ceilings](capacity/DOCUMENT_CAPACITY_2026-10-22.md).
This is not an unlimited-memory, streaming-document-model or whole-app acceptance
claim. Rebuild all native/WASM participants and verify real import/edit/save/reopen
before citing its capacity behavior.

The 2026-10-22 resident image-table candidate separates same-device capture submission from bounded table retirement without enabling resident-prefix reuse. Keep its three-batch/64 MiB soft deferral threshold, unchanged total budget, source pins and synchronous scratch-ledger collection. Transient scratch and possible geometry replacement retain completion boundaries. Submission ACK is not physical display or faster GPU arithmetic. See [the candidate verification record](../testing/verification-resident-image-retirement-20261022/README.md) and [trace dictionary](IMAGE_TABLE_RETIREMENT_DIAGNOSTICS_20261022.md); hardware/whole-editor acceptance remains open.

The schema-16 vector geometry refactor separates f64 render curves from the bounded point-editing network inside the existing Node model. See [source worksets](LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md). Source conversion, shared-model admission, actual rendering and compatibility export retain separate evidence gates; the source-capacity pass is not a whole-page GPU pass.

The 2026-10-23 source-chain integration retains strict opt-in gates for `VITE_DESIGN_EXACT_WHOLE_TENT_2048`, `VITE_DESIGN_MANAGED_MODE12_ENTRY` and `VITE_DESIGN_EMPTY_SCENE_COMPOSE`. The new dependency registry drains its own requested descriptor group; it is not a global device-idle proof. Shared coefficient loaders change even when optional paths are disabled. See [the scoped integration evidence](../testing/verification-increment-0741-1338-20261023/README.md); no hardware GPU, GUI or end-to-end performance claim is made by merging this candidate.

The 2026-10-26 topology repair adds an independently bounded SDR canvas-shadow operator. Native coefficients retain exact normalization and a 64 KiB serialized cap; the old `tent` API still rejects radii above 2048. A private coefficient proof bound to its uploaded GPU resource permits the scoped larger operator, with actual texture/byte admission unchanged and all writes revoking authority. Fractional offsets retain the original f32 sampling phase, and stroked sources retain fill/children/stroke order and alignment. Global experimental gates remain opt-in. See [the scoped hardware and GUI evidence](../testing/verification-topology-navigation-20261026/README.md); full rendering and interchange acceptance are separate.


## 2026-10-27 Sketch text, layout and local library continuation

Schema 20 adds paragraph-range metrics and vertical text alignment, plus explicit directional prototype navigation. Existing default text layout remains unchanged; native Sketch projections carry an exact-match text-model receipt, which is discarded when native text fields change. Local .sketch library refresh uses the existing owned worker, stable source identities, Editor transactions and Rust component resolution. Embedded foreign masters have graph roots, while native export emits them once in foreignSymbols. See [the scoped evidence](../testing/verification-sketch-text-layout-flow-20261027/README.md). CoreText glyph raster parity, colored glyphs, tightening, full Smart Layout/Relative sizing and overlay animation/placement remain separate unfinished work.


2026-10-27 用户明确授权调整源文件容量策略并要求全源单画板，当前实现与未完成边界见[全源单画布容量契约](SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)。内部工作粒度与可回收缓存不能作为源文档总量配额；此授权不改变精度、所有权、实际设备能力或验收证据要求。

## Bounded native-source preparation pipeline (2026-10-28)

NativeSourceSurface submits at most two tiles per batch, retaining one source raster request and the existing single speculative PrepareAhead job. Each completed tile may present immediately; cancellation considers unfinished tiles, and late/duplicate replies cannot replace the current owner or retire live textures. Sampling, effects, HDR/export, resource budgets and physical completion fences are unchanged. See [scoped measurements and integration limits](../testing/verification-bounded-source-pipeline-20261028/README.md); source controller overlap is not a claim that all GPU work or all application windows are globally serialized.
