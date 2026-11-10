# Futureox Design local v1 development contract

Selection chrome uses the following values: selection, hover, and the marquee border are a solid 1px `#4597F7` fill on the CSS pixel grid, the marquee wash is `#DCE9F5`, and Option/Alt distance pills are `#E05634`. The workspace accent stays `#3459d4`. It does not change raster budgets or close 33/100ms or full G2/G5.

The font catalog lists macOS, Windows and Linux font directories and records weight, italic and variation axes on each face. Missing source fonts are replaced only after confirmation. The built-in Noto Sans SC variable face remains the CJK fallback. No font is downloaded. This does not change raster budgets or close 33/100ms or full G2/G5.

Pending coverage uses a white background and keeps the 400% pixel grid outside immutable images. Exact readiness remains separate. Automatic image residency now excludes retained interactions after measured mixed latency and higher nominal texture peaks; explicit `VITE_DESIGN_RESIDENT_IMAGE_REUSE=1` opts in and `0` opts out. The region/contained-effect capture and gradient-window experiments remain explicit opt-ins. Local rigid capture is fresh native rendering, not bitmap rotation. Full interaction and refinement gates remain open.

Camera continuity separates same-content resident preview, explicit pending-pixel coverage, browser projection of an accepted immutable image, and exact readiness. Placeholder and projected receipts never certify terminal/native completeness. Completed ImageBitmap handoff binds pixels and camera atomically on the window event loop; never CSS-transform a canvas still writable by the raster worker. Keep one accepted and one pending image charged under the existing display budget, with token-checked acceptance/discard and source GPU completion. Browser projection retains document/page/session/display/chrome ownership and original raster/export precision. Display slicing and oldest-prefix high-water waits retain resource fences. GUI pixels, DOM projection, submission ACK, initial loading and exact refinement remain separate evidence; full G2/G5 remain independent.

Stroke-mask reuse, paint templates and coverage-program identities remain isolated candidates. Restore QA wrappers before returning pooled test drivers, and assert that timed frames do not return QA pixels. Pixel parity and fewer calls do not establish a performance gain.

Ordinary SDR Gaussian direct/prefix execution selection is enabled, with `VITE_DESIGN_GAUSSIAN_AUTO=0` as its build-time fallback. Original kernels, six passes, RGBA32F storage, density, four coverage phases and scratch budgets remain. HDR and exact output stay on their original paths. RGBA16F did not meet the performance gate; regional/reduced Gaussian policies remain explicit opt-ins. Scoped Metal timings and pixels do not close full G2/G5 or the separately reproduced baseline queue-test failures.

This is maintained project guidance, not a claim that every release gate has passed. Target: local application v1.0.0. Package manifests and the source increment must be checked separately before calling an artifact a 1.0.0 release.

The sRGB and font-metric path tags canvas and export samples instead of leaving RGB untagged. Schema 21 stores per-run letter spacing and line height. It does not change unmanaged compositing, make Display P3 the default PNG, or close 33/100ms or full G2/G5. The path is [COLOR_SPACE_SRGB_PATH.md](COLOR_SPACE_SRGB_PATH.md).

## Architecture and product boundary

Exact work reduction supplies separate default-on mixed-solid and bounded gradient-fusion paths, each disabled by its own explicit `0` flag. Constant coverage remains opt-in (`VITE_DESIGN_CONSTANT_COVERAGE=1`) until its separate performance gate passes. These do not enable the existing experimental painter/filter stack. Rust-authored bounded group plans and private actual-upload proofs remain mandatory. Gradient fusion preserves stored-paint rounding, the original normal-over writable ring and zero-weight neighbour behavior; HDR, nonfinite fields, unsupported clips and insufficient opportunities retain the original path. Diagnostics distinguish draw counts, measured rectangle area, cache rejection reasons and unmeasured work. Scoped hardware/real-file improvements are not full G2/G5 acceptance.

Four-attachment coverage remains strict opt-in (`VITE_DESIGN_PACKED_COVERAGE=1`). It writes four fresh, private RGBA8 coverage targets in one pass only for certified display programs; cache hits and all unsupported scenes retain the original single-phase path. Sample-only coverage itself defaults on with an explicit `0` fallback. It must remain opt-in until its whole-editor acceptance gates pass.

- Web and Electron reuse the same frontend, authored model, components, layout, typography, selection/edit semantics and history boundaries. Electron can provide native local acceleration, files, SQLite and scoped host dialogs; it must not become a second design product with divergent semantics.
- UI commands handle drafts, gestures and modal decisions. MCP translates discovered operations. Both reach the existing editor/domain implementation; automation stages a candidate and commits through Editor.change. Rust owns authoritative admission, layout and render semantics; TypeScript validation improves early diagnostics, not native authority.
- Keep local-first SQLite/Tokio and browser IndexedDB adapters. No new cloud accounts, collaboration service, arbitrary filesystem/network operations, or self-built AI workflow/model orchestrator. A client may inspect → edit → inspect using the published bounded operations; the server executes operations only.
- There is no obligation to preserve obsolete, unreleased application implementations. This does not license dropping current authored data, bypassing validation, or conflating independent version axes: app semver, FD binary format (currently 2), document schema, automation capabilities (currently 1), FD extension contract (1), storage schema and editor/session/storage revisions.
- Figma file identity, hidden canvases, shared styles, and component sets use the existing document, page, design-system, and component fields. `designSystem.sketchContainers.figDocument` is an inert receipt (source id, color profile, internal page ids, non-executable variable payload). It is not re-emitted as a Sketch document container. Unsupported color profiles, grid styles and variable bindings must be reported rather than guessed.

## AI-native production canvas direction (2026-11-03)

The long-term ceiling is an AI-native production canvas: people and agents turn ideas into editable, executable, verifiable and exportable products. AI generates structured candidates; the canvas owns structure, preview, validation, editing and delivery. This section is product direction, not a claim that these capabilities have shipped. Existing rendering correctness and interaction gates remain the first priority and must not be deferred for these features.

Product sequence:

1. Prove one vertical Code Layer slice for a real frontend component.
2. Add design-system constraints, review and governance around that working slice.
3. Add other materials only after their independent runtime and export loops work. Do not attempt full 3ds Max or Final Cut clones.

Code Layer contract:

- Ordinary design layers retain the existing GPU renderer. Code Layers run real React or Vue code in an isolated iframe; never recreate general HTML/CSS layout inside the 2D GPU renderer. Each Code Layer stores only framework, source/component identity, editable props and source revision. A live DOM is not a second document model.
- Bind source/AST nodes, editable schema and preview elements through stable `codeId` values, never DOM indices. Selection, text/style/layout edits and AI edits all become bounded source/AST changes through the existing `Editor.change` and Rust admission path. Do not mutate only the runtime DOM, because it cannot provide undo, persistence or reliable hot reload.
- Preserve native framework semantics. React and Vue share the canvas operation protocol, not a fictitious universal runtime or lossless JSX↔SFC conversion. Framework-specific state and behavior remain native source; visual editing starts with a constrained component/CSS subset.
- AI and manual edits share the same source, revision and undo timeline. AI changes are isolated diffs bound to an expected source revision/hash, validated and built before atomic publication. Reject stale results. A build failure preserves the last working preview and source. Each AI action has one undo entry; each user gesture has one undo entry.
- Hot-update the preview for ordinary component/style changes. Rebuild the iframe only when entry/global runtime requirements change; do not restart the whole application for AI edits. Restore camera and valid selection after publication, and clear selection for deleted elements.
- Preview code is sandboxed by default: no Node, filesystem, network or Electron authority. Capabilities require explicit scoped grants and controlled message passing. Undo covers source and declared props, not arbitrary asynchronous runtime state.
- Do not promise arbitrary JavaScript/CSS round trips, arbitrary npm execution or a prompt-only generator. AI operates through the same inspect → isolated edit → validate → preview → commit loop rather than a new orchestrator or mutation engine.

Later material directions use separate engines rather than forcing the 2D renderer to become every runtime:

- Parametric 3D uses an editable feature graph of bounded operations and parameters, not an AI-authored black-box mesh. Add an independent 3D viewport, derived mesh ownership and GLB export before considering broader DCC features.
- Video uses a timeline/media engine with hardware decode, an audio master clock, A/V sync, proxy/frame caches and deterministic export. The static design compositor alone is not a video engine.

The first Code Layer acceptance slice must complete: AI generates one real React component → actual browser preview → direct text/layout/style edit → AI continuation → hot update → undo/redo → save/reopen → export runnable code. Verify AST diffs, actual browser layout/interactions, expected-revision conflicts, deleted selection, failed builds, sandbox denials and independent exported execution. A Vue adapter must pass the equivalent SFC gates. These checks do not establish arbitrary application support and do not relax G0–G8 or the current rendering acceptance targets.

## Forward extensibility without fictitious support

The optional document field is fdCompatibility with contractVersion: 1, requiredCapabilities: [], and extensions: a namespace-to-JSON map. Current code supports no required capabilities: any nonempty required list rejects. Add support only with a real implementation and paired native/frontend tests.

Optional opaque payloads remain inert and round-trip through native FD, editor history and local storage. Namespace syntax is lowercase reverse-domain/name, at most 128 ASCII bytes; at most 64 namespaces. Limits are depth 32, 100,000 JSON values and portable resource cost 1 MiB (128 overhead + 32 per JSON value + UTF-8 string/key bytes), separate from document wire limits. Do not normalize floats/nulls or rewrite scene arrays to satisfy a metadata budget. Reject malformed JSON values and unsafe keys before expensive serialization.

FD format 2 keeps serde_json's number variant: unsigned integer, signed integer, or finite f64 bits, including signed zero. Integer-valued floats stay floats. `i64::MIN` uses unsigned zigzag bits so debug builds do not overflow. Older writers may already have stored an integer-valued float as an integer; readers still accept both tags. `encode_authored_json` / `decode_authored_json` (the `binfmt_*` and `forma_*` entry points) validate the typed document and then keep the authored value: ignored fields, explicit nulls, and `fdCompatibility` payloads. Files still cannot register handlers. The editor's `json-stringify-v1` codec remains `JSON.stringify`, which canonicalizes signed zero before that JSON is encoded.

Whole-document open/save preserves the envelope. Append/import cannot safely remap opaque embedded IDs, so current append rejects nonempty optional payloads before modifying the destination. External FIG/Sketch/SVG fidelity remains independently limited; preserving FD metadata does not establish external-format or pixel equivalence.

Trusted host code may register synchronous operations, validators and pure deterministic expansion functions. Files cannot register code, select modules, fetch resources or authorize operations. This is not a sandbox for hostile same-process JavaScript. Extension discovery is implementation metadata, never a permission grant.

## Permission and commit boundaries

Read [local operation permissions](LOCAL_OPERATION_PERMISSIONS_V1.md) before changing grants. Trusted host policy binds exact document/session, explicit method names and read/write authority. Omitted policy retains trusted local authority; an explicit empty policy denies all. This optional seam does not automatically apply a page/node ACL or restrict every UI route. Native bridge opt-in and workspace/settings grants remain separate boundaries.

Validate schemas and all batch wrapper/leaf permissions before mutation callbacks. Expansion is trusted pure planning, not a side-effect mechanism. Stage in isolation and preserve atomic failure, locked nodes, references, layout, component overrides and one native undo entry. Recheck document/session/revision, authorization, busy state and pending input immediately before publication and after asynchronous host decisions. Never derive authority from FD metadata or request arguments.

## Local storage and readable history

编辑自动保存到独立工作副本，导入原文件始终不改写。普通桌面工作区和大型源文件编辑都在输入/手势提交后自动持久化；切换/关闭等待当前回执，失败保留编辑，不要求手动保存或放弃修改。导出是独立动作，不能选择输入原件或指向它的链接。

保存与恢复约束补充：独立 Sketch 工作副本用 v2 检查点保存原格式不能直接表达的精确编组矩阵，旧版本须拒绝不能理解的检查点，完整源绘制与重开应用相同矩阵。位图存储域与新会话身份分别验证并随窗口/会话撤销。非刚性矩阵不能无损导出为 Sketch 时明确拒绝导出，不能以保存成功掩盖格式损失。渲染调度不得把历史已完成相机当作当前清晰覆盖；局部旋转每次输入重验后续背景读取范围，取消过时捕获保留已完成像素和资源 fence。实际 CPU、GUI、像素和剩余停顿分别报告，完整 G2/G5 仍未关闭。

增量保存与准备约束：大源保存使用已有完整不可变差量，变化字段仍由原生源事务权威验收；私有不可变浏览器快照免重复克隆，可变输入保留克隆。组件位姿证明默认开启并保留 `0` 回退，拒绝时继续原布局/组件路径。缩出驻留预览不替代当前精修，总览预热最多两块一批且不增加 GPU owner 或预算。33/100ms 和完整 G2/G5 未关闭。

- SQLite workspace/catalog pools use one connection each. Desktop runtime bounds admission to eight business requests and the trusted document transfer byte budget. Ordinary workspace mutations retain one FIFO worker; large source-file work has a separate single-worker lane, limited to two admitted long requests. Four blocking slots leave room for stdio/parsing alongside the two business workers. Blocking file preflight/parsing belongs in bounded blocking work; SQLx SQLite executes on connection workers. Production `workspace.*`, `automation.*`, and `catalog.list` turns run on one dedicated FIFO thread that drives those futures, so a SQLite wait does not occupy a Tokio blocking slot. Electron frames and decodes workspace document payloads of at least 32 KiB on a Node worker; smaller payloads stay inline. Direct library callers must bound their own concurrency. Queue/start receipts separate waiting from execution deadlines without implying a commit.
- Workspace WAL and synchronous=FULL, with BEGIN IMMEDIATE, atomically publish head, snapshot, resources/references and durable mutation receipt. Storage expected revision is separate from editor expectedRevision. BUSY/LOCKED and pool acquisition timeout report WORKSPACE_BUSY; no blind retry with changed content or a new mutation identity after uncertainty.
- Queued cancellation can prevent execution; cancellation after commit cannot promise rollback. EOF drains admitted work. A missing response can mean a successful durable write: reconcile or retry the exact identity/content.
- Saved history offers read-only snapshot preview and human-readable adjacent-revision differences: additions, removals, moves/order/transform, text and style changes. Show bounded paths and values, omit binary font/image payloads, and do not call a textual diff a visual comparison.
- Restore appends a new durable revision under the viewed storage-head CAS. It does not delete history or turn editor undo into disk rollback. Protect dirty edits, active input and new editing during asynchronous restore; report a durable restore that could not safely be adopted in the canvas. Browser retention is currently 50 revisions, not unlimited; UI diff rows are bounded at 500.

## Performance, rendering and interaction acceptance

The SDR canvas blur policy is a narrow exception to canvas bit equality: SDR WebGPU rational tent/Gaussian box/scalar shadow reductions and motion/zoom sampling reductions use bounded native float arithmetic. Original coefficients, coordinates, sample counts, support, four coverage phases, intermediate surfaces and budgets remain. Extended-range/nonfinite input retains exact results; explicit readback/export, HDR, software profiles and unsupported physical windows remain exact. Large shadow admission still requires the original private upload proof. `VITE_DESIGN_CANVAS_BLUR_FLOAT=0` restores prior display arithmetic. Numeric integer 0/1 blur enable values are handled locally without changing other boolean fields. This does not authorize global desktopFullMath=false or downsampling; independent fidelity and complete interaction acceptance remain separate.

The rendering pipeline adds bounded subtree fragments, transport-independent exact source identities and cooperative preparation cancellation. These do not authorize approximate hashes, expanded memory budgets, cancellation of ordered mutations, or early release of in-flight resources. Preserve its per-backend cancellation and opt-in large-filter boundaries; scoped hardware pixel equality remains separate from whole-editor motion acceptance.

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
Keep a rejected queue completion distinct from resource retirement.

`VITE_DESIGN_DISPLAY_TENT_RADIUS=1` additionally requires
`VITE_DESIGN_EXACT_CLAMP_PREFIX=1`. It is a separate default-off SDR display
approximation: explicitly scoped normal blur/backdrop axes may round radii
1..2048 to f32 only when the original native tap halo cannot grow. Both
kernel packets and the GPU filter contract must use that selected radius.
The worker must overwrite document/request intent, isolate every cache policy,
and report actual changed axes. Readback, export, HDR, software, other backends,
glass, gradient blur, byte shadows and unknown callers retain the original
radius. This flag does not extend the legacy whole-filter 512 guard or fix the
unsupported nested-interaction fallback.

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

Exact prefix scratch and logically retired image tables may remain queue-ordered
between resident screen submissions. A submission acknowledgement cannot authorize
their destruction: retain their source ownership and full byte ledger until an
actual completion boundary covers the retired snapshot. Preserve pressure,
readback, cancellation, device-loss and periodic backpressure paths. Diagnostic
counter readbacks may be deferred to existing completion boundaries; their
sample counts are not complete per-frame totals. Raw-float lifetime proof and actual motion checks are separate gates.
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

Each source increment must include the repository-local skill, maintained Markdown contracts, changed implementation/tests and reproducible evidence. Do not ship tokens, local connection details, invented endpoints or private assistant context. See [MCP operation guide](MCP_OPERATION_GUIDE_V1.md) and [release acceptance](LOCAL_RELEASE_ACCEPTANCE.zh-CN.md).

Resource-aware capacity replaces the accumulated native
32 MiB document and fixed 20k-node/100-page quotas with a trusted pinned memory
policy; desktop transport frames and untrusted archive/MCP protections remain
bounded independently. See [capacity policy and remaining physical ceilings](capacity/DOCUMENT_CAPACITY_2026-10-22.md).
This is not an unlimited-memory, streaming-document-model or whole-app acceptance
claim. Rebuild all native/WASM participants and verify real import/edit/save/reopen
before citing its capacity behavior.

Resident image-table submission separates same-device capture submission from bounded table retirement without enabling resident-prefix reuse. Keep its three-batch/64 MiB soft deferral threshold, unchanged total budget, source pins and synchronous scratch-ledger collection. Transient scratch and possible geometry replacement retain completion boundaries. Submission ACK is not physical display or faster GPU arithmetic. Diagnostic fields are defined in the [trace dictionary](IMAGE_TABLE_RETIREMENT_DIAGNOSTICS_20261022.md).

The schema-16 vector geometry refactor separates f64 render curves from the bounded point-editing network inside the existing Node model. See [source worksets](LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md). Source conversion, shared-model admission, actual rendering and compatibility export retain separate evidence gates; the source-capacity pass is not a whole-page GPU pass.

The source preparation pipeline retains strict opt-in gates for `VITE_DESIGN_EXACT_WHOLE_TENT_2048`, `VITE_DESIGN_MANAGED_MODE12_ENTRY` and `VITE_DESIGN_EMPTY_SCENE_COMPOSE`. The new dependency registry drains its own requested descriptor group; it is not a global device-idle proof. Shared coefficient loaders change even when optional paths are disabled.

The bounded canvas-shadow path uses an independently bounded SDR canvas-shadow operator. Native coefficients retain exact normalization and a 64 KiB serialized cap; the old `tent` API still rejects radii above 2048. A private coefficient proof bound to its uploaded GPU resource permits the scoped larger operator, with actual texture/byte admission unchanged and all writes revoking authority. Fractional offsets retain the original f32 sampling phase, and stroked sources retain fill/children/stroke order and alignment. Global experimental gates remain opt-in.

## Sketch text, layout and local libraries

Schema 21 adds optional per-run `letterSpacing` (design pixels) and `lineHeight` (multiplier of that run's font size). Lines with no override keep the node line-height floor. Schema 20 adds paragraph-range metrics and vertical text alignment, plus explicit directional prototype navigation. Existing default text layout remains unchanged; native Sketch projections carry an exact-match text-model receipt, which is discarded when native text fields change. Local .sketch library refresh uses the existing owned worker, stable source identities, Editor transactions and Rust component resolution. Embedded foreign masters have graph roots, while native export emits them once in foreignSymbols. CoreText glyph raster parity, colored glyphs, tightening, full Smart Layout/Relative sizing and overlay animation/placement remain separate unfinished work.

源文件容量与全源单画板的当前实现及未完成边界见[全源单画布容量契约](SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)。内部工作粒度与可回收缓存不能作为源文档总量配额；此授权不改变精度、所有权、实际设备能力或验收证据要求。

## Bounded native-source preparation pipeline

NativeSourceSurface submits at most two tiles per batch, retaining one source raster request and the existing single speculative PrepareAhead job. Each completed tile may present immediately; cancellation considers unfinished tiles, and late/duplicate replies cannot replace the current owner or retire live textures. Sampling, effects, HDR/export, resource budgets and physical completion fences are unchanged.

图片采用不可变共享载荷，文档序列化与资源预算保持原语义；Sketch 文本私有身份必须与当前归档资源或原生字体描述匹配，外部 Symbol 保留原生 symbolID。三文件编辑/撤销/导出/重开与速度、物理呈现、跨渲染器保真分别验收，不据局部通过宣称全部目标完成。

## Native source demand compilation increment

Native source demand compilation creates private resolved render projections at the existing native compile entry. Selected records retain derived paths and IDs without another layout pass. Stripped authoring metadata and font declarations must never be saved, exported, edited or treated as document replacement; actual font resources remain in the compiler resource owner. Full source data remains resident for compatibility and unsupported operations.

A compiler candidate differs from general authored dependency acquisition. Only the reviewed legacy subpixel canvas contract closes producers against the actual scene extent before encoding transfer IDs. Stage-bound contributors do not automatically request an entire painter prefix. One extent replan is permitted; unresolved scopes fall back to full compilation. Preserve exact global margins/predicates and a monotonic wire-resource owner through projection changes, fallback, cancellation and mutation. New policies default to the complete path until reviewed.

## External-format and source-pan contract

Native schema fixtures, actual Sketch re-rendering, shared-model execution and portable raster parity are distinct evidence. Keep outline-mask styles authored and derive geometry-only materials during rendering, including descendants; source-owned and compatible archive saves retain separate guarantees. Optional rim work cannot delay required coverage or certify an incomplete view. Periodic cache identities subtract whole dither periods without changing raster cameras, fractional phases, GPU budgets or physical ownership.

## Official Sketch fixture adaptation

Official Sketch fixtures pin their upstream repositories and commits; exercise them through the production Rust/WASM round trip and shared-model admission. Export settings retain source-only metadata by index. TIFF/EPS and zero scale are preservation contracts, not executable export claims; JPG may use the existing JPEG writer. Scoped round trips do not establish complete Sketch semantics or native pixel parity.

## Local filter drag and exact source revisits

A proven foreground root with one supported self-filter can use its local output support; nested filters, shear and later backdrop consumers retain the prior path. The immutable native source replay cache shares the existing 64 MiB retention allowance, keeps at most 32 exact requests, preserves source/resource identity, and updates an older frame sequence before emission. It retains encoded data rather than another document or GPU owner. `CORE_SOURCE_REPLAY=0` restores compilation on revisits. Cache pressure may evict a revisit; cancellation, source/revision/policy and scope changes remain authoritative. Fresh static rendering, same-tier capture pixels, native packet fields and hardware float pixels are distinct checks. Use an independent reload oracle; retain failed comparisons rather than approving mismatched pixels. Whole-app 33/100 ms and G2/G5 remain unclosed.
