# Forma desktop (Electron + React + Rust)

This package is the local host for the **existing** `../design-client` React editor and
`design-studio/crates/design-kernel` Rust/WASM engine. It does not create a second editor.
The Rust `futureox-design-desktop-backend` sidecar owns `.fd` validation, atomic file
writes, SHA-256 conflict detection, recovery, the local SQLite document/version store,
system-font discovery and a separate single-user directory catalog.
Its Tokio control loop communicates over bounded stdio;
no PostgreSQL, Redis, HTTP listener or cloud account is needed for the offline desktop.

As of 2026-10-14, one `futureox-design-kernel` owns the design model, geometry,
layout, text, history and rendering. Sketch archive preservation is a format
adapter inside that crate, not another product editor. Both web and Electron use
the same “导入 Sketch / FIG / SVG / PDF” command and editable canvas. Sketch
compatibility export is available in the shared file menu; retain `.fd` for the
full authored document. Missing embedded fonts and other conversion limits are
reported explicitly. The original Sketch input is read-only.

The shared React UI is local-first. Web persistence uses IndexedDB; Electron uses
the Rust SQLite workspace. Legacy native archive bridge contracts documented below
remain internal compatibility tooling; their former separate editor/inspection
menu entries are no longer displayed.

## Develop and test

Prerequisites: the repository's Rust toolchain and `wasm32-unknown-unknown` target,
`wasm-bindgen-cli` **0.2.130**, Bun **1.4.0+**, Node **24+**, and supported OS display libraries.
Electron is pinned to **44.7.0** and the official packager to **20.3.0**.

Each package owns its lockfile; there is no workspace-level install. From `frontend/`:

```sh
cd design-client && bun install --frozen-lockfile && cd ../design-desktop
bun install --frozen-lockfile
bun run install:runtime
bun run dev
```

`install:runtime` runs Electron's official checked binary installer (the pinned package
provides `install.js`; a dependency-only install is not evidence the binary exists).
`dev` rebuilds the real WASM kernel, typechecks React, builds the renderer and Rust
sidecar, then starts Electron. It serves bundled files via `design-app://app/`, not a
localhost Vite server. For existing build caches, set `CARGO_TARGET_DIR` before building;
`WASM_BINDGEN` may point to the exact installed binding-generator executable.

Native builds default to `release` (Thin LTO and one codegen unit). `bun run dev` passes
`--fast` instead, which selects the `desktop-dev` Cargo profile (opt-level 1, no LTO,
16 codegen units, incremental): much faster compiles at adequate runtime speed for daily
editing. Use `node scripts/build.mjs --debug` explicitly for a debug native build, and
`--release` for anything you package. The backend, GPU utility, and design agent
are built in one Cargo invocation. The agent is installed at
`dist/bin/futureox-design-agent` and the host loads that file (`resources/bin`
when packaged). `DESIGN_AGENT_BIN` still overrides it. Generated WASM remains a
release build.

```sh
bun run build:host
bun run test
bun run build
bun run start
bun run test:smoke
```

The smoke test needs a working display and Chromium sandbox. It waits for the actual
WASM-backed editor and a completed CPU canvas frame, asserts the narrow bridge and
renderer isolation, queries Rust health, reports the frame's backend/time and saves
`desktop-smoke.png` in the isolated app user-data directory. Never
add `--no-sandbox`, disable the setuid sandbox, or weaken OS isolation to make CI pass.
A container that denies Chromium's required IPC/display facilities is a blocked GUI
check, not a successful desktop launch. Host unit tests do not substitute for GUI QA.

### Optional GPU working-set ceiling

For an existing build, launch from the repository's `frontend/design-desktop` directory:

```sh
CORE_GPU_WORKING_BUDGET_MIB=4096 npm start
```

This host-only setting accepts a decimal integer from 256 through 4096 MiB.
Omitting it or setting it to `auto` selects 2048 MiB on Apple silicon Macs
with at least 16 GiB of unified memory and 4 GiB available at startup. The
other configurations use the 1024 MiB WebGPU default. An explicit value
takes precedence. Invalid values fail with a clear launch error. Documents,
renderer settings and MCP cannot set this option.

4096 MiB is an optional **4 GiB admission ceiling**, not a preallocation or a cap on
the application's total GPU/process memory. It changes no single-texture/buffer
device limit or separate cache budget. Actual allocation, memory-pressure handling
and device failure still follow the existing renderer rules. The main process
validates the value and forwards a frozen optional preload policy field; there is
no additional settings UI.

## Native render loop (design-render serve mode)

`bun run build` also compiles `futureox-design-gpu`'s `design-render` binary, stages it
at `dist/bin/design-render` with the CJK text font at `dist/fonts/NotoSansSC.ttf`
(copied from `../design-client/public/fonts/`), and packaging carries both as extra
resources (`resources/bin/`, `resources/fonts/`). The main process
(`src/native-render.mjs`, the `.mjs` port of the design-client
`kernel/electron/native-render-*` modules — the Electron main has no TS loader) spawns
it in `--serve` JSON-lines mode and exposes `native-render:load/frame/stats/stop` over
IPC; the preload surfaces them as `coreDesktop.nativeRender` plus
`coreDesktop.nativeRenderStats()` (latest E6 four-bucket GPU memory breakdown JSON, or
null before the first native frame). The backend is Metal on macOS and `auto`
elsewhere; `--core-cpu-only` forces the CPU tiled host. This is an opt-in diagnostic
probe (`localStorage forma-render-backend=native` or `VITE_DESIGN_NATIVE=1` runs
`window.__nativeRenderProbe()` from `kernel/native-render-session.ts`), not the ordinary
canvas presentation path. The SDR canvas uses Electron's local WebGPU device for
both raster work and resident presentation, retaining exact desktop arithmetic;
it does not send frame pixels through the sidecar. A missing utility binary is not fatal: the IPC handlers
report `{ ok: false }` and the editor stays on the worker path.

Isolated shared-renderer checks can be built and opened without a remote debugger:

```sh
node scripts/build-render-checks.mjs /absolute/private/check-bundle
node node_modules/electron/cli.js . --desktop-isolated-profile \
  --desktop-render-check=interaction \
  --desktop-render-check-root=/absolute/private/check-bundle \
  --desktop-render-check-fixture=/absolute/private/sample.fd \
  '--desktop-render-check-query=continuous&dependent&glass&fixedPoses&midOracle&oracle&pixels'
```

Other entries are `zoom`, `alignment`, `seams`, `order`, `optical`, and `reference`.
The tool prints its private result directory. These pages have no ordinary editor
IPC authority. Test windows disable occlusion throttling, while normal window policy
is unchanged; counter-instrumented measurements are not input-to-photon or production
FPS. Serve the same bundle for Web checks with
`node ../design-client/scripts/serve-render-checks.mjs <bundle> <fixture> <private-output>`;
the server owns a loopback ephemeral port. Real import/edit/save journeys still use
the normal application and are recorded separately from these controlled scenes.

The explicit `--desktop-smoke` flag also works on a packaged executable. It always
uses a new temporary profile, enforces the CPU-only policy, records a completed
frame and screenshot, and exits its own test window. Ordinary launches do not
enable this mode.

For a manual native GUI journey on a development checkout, run
`./node_modules/.bin/electron . --desktop-gui-test` from this directory. The flag
creates a fresh temporary `userData` profile; add `--core-cpu-only` to test the
strict CPU path. Open a `.fd` file through the native picker, then press
`Cmd/Ctrl+Shift+9` to save `desktop-gui-test.png` in that isolated profile. The
test-only screenshot command appears only when this flag is passed, including
when validating a native development bundle. Ordinary starts omit it.
The [2026-10-10 macOS GUI record](../../testing/review/design-desktop-macos-gui-2026-10-10/README.md)
contains a real save/open/edit/close journey and its screenshot.

## Current CPU-only and catalog scope

For an explicitly authorized CPU-only launch on a supported host, pass
`--core-cpu-only` to Electron (for example `electron . --core-cpu-only`). The plain
`start` script does not add that flag. Main applies the launch policy before ready,
disables hardware acceleration plus GPU/software-rasterizer paths, and pins the
policy through preload and the render worker. Local render preferences cannot
relax it. PNG export remains CPU-only. This source contract and pure policy tests
are not proof of a native launch; the 2026-10-09 cloud cohort ran no Electron,
browser or GPU-related checks, including software-GPU substitutes.

The Rust sidecar stores projects, selected roots and bounded direct-child file
metadata in `userData/catalog-v1.sqlite3`. It does not store document content or
restore filesystem authority from rows. Each process requires native directory
reselection; React receives opaque session handles and display metadata. The
catalog supports at most 32 registered roots, 512 files/root and 2,048 visited
entries/scan, and reports truncation. Host session grants are separately limited
to 16. Invalid/corrupt/future catalog databases are preserved; catalog calls fail
explicitly while ordinary file-dialog and recovery operations remain available.
See the [backend runtime/catalog contract](../../design-studio/crates/design-desktop-backend/README.md).

The 2026-10-09 Linux cohort was limited to backend 39 cases, the exact Node host
allowlist of 46 cases, real sidecar stdio 5 cases, pure CPU policy 11 cases, and
isolated catalog component 6 cases. These cohorts are reported separately; the
GPU-preference case was excluded in that cohort. The later 2026-10-10 macOS ARM64
record adds actual Electron GUI interaction, native file dialogs, a local Rust
sidecar and a WebGPU render of the saved document; it does not imply Windows/Linux
GUI acceptance or full Figma feature parity. Previous package hashes and broader
totals remain dated historical evidence in
the [architecture record](../../docs/architecture/design-desktop.md).

## Native development bundle

The macOS local variant has the distinct `Forma Local` application name and bundle ID.
Use a fresh build tag when any earlier application bundle is running:

```sh
node scripts/build.mjs --release
node scripts/package.mjs --local --build-tag=mac-20261010-final
node scripts/verify-package.mjs --local --build-tag=mac-20261010-final
```

The output is under `release/local/<build-tag>/`. Never overwrite a running Mach-O
bundle. The package verifier checks frozen build inputs, packaged WASM/host/sidecar
identity and real-child file, SQLite, revision and portable-file round trips.
The [local validation matrix](../../docs/architecture/design-macos-local-validation.md)
separates automated contracts, real backend browser journeys and native Mac GUI steps.

```sh
bun run package:native
# Recheck an existing bundle without compiling:
bun run verify:package
```

If the official Electron ZIP is already installed locally and the checksum download
is unavailable, set `ELECTRON_ZIP_DIR` to the directory containing the matching
`electron-v<version>-<platform>-<arch>.zip`. The package script verifies that ZIP
against Electron's installed `checksums.json` before using it. The 2026-10-10
macOS arm64 development bundle passed the package verification gate (13/13
packaged preload/real-child cases); details and hashes are in the
[GUI record](../../testing/review/design-desktop-macos-gui-2026-10-10/README.md).

Output: `release/Forma-<host-platform>-<host-arch>/`. The renderer/main/preload are in
`resources/app.asar`; the matching native Rust sidecar is in `resources/sidecar/`.
Packaging only targets the current machine so a Linux executable cannot be passed off
as a Windows or macOS build. These are **unsigned development bundles**, not signed
installers or production releases. Windows packaging, signing/notarization,
font/IME/accessibility/GPU matrices, release fuses and update distribution require
their own platform release validation. No signing credentials or publishing are used here.

The package command now fails unless the maintained verification gate passes:
A before/after build-input hash record rejects source changes during or after a build.
ASAR main/preload/renderer inventory and hashes must match build inputs, the packaged
native sidecar must match the built executable, and packaged WASM must match the
client's public WASM. Tests load the extracted packaged preload/bridge, exercise
the real Rust executable through save/conflict/recovery/restart, and verify bounded
termination of owned subprocesses. Results, source/toolchain/artifact hashes and
test output are written to `release/package-verification.json` and
`release/package-verification.log`. These identify this run; they do not establish
byte-reproducible builds or prove native GUI interaction.

CI separates dependency-free host contracts, the real-WASM React desktop lifecycle
with a mocked native bridge (`design-client: test:desktop-lifecycle`), and a macOS
native build/package plus normally sandboxed Electron readiness smoke. Readiness
smoke is not native save/open/close/recovery journey acceptance. The workflow is
wired for a supported runner; an unexecuted CI lane is not a passing platform result.

## Local file and security contract

- Main process dialogs select `.fd` destinations; the renderer receives opaque
  capabilities and file display names, never arbitrary filesystem access.
- Local files are checked against the Rust model. Document payloads are bounded to
  **a trusted startup memory allowance**, stdio frames to **64 MiB**, and pending RPC requests to eight. Larger admitted documents use ordered 1 MiB multipart chunks, not larger frames. See [document capacity](../../docs/DOCUMENT_CAPACITY_V1.md).
- Saving uses the last observed hash and rejects external changes. Save As obtains a
  new destination baseline; when adding an extension changes the selected destination,
  an existing normalized target needs its own explicit replacement confirmation.
- One window is used. New/Open/Recover/Close go through the renderer's unsaved-work
  decision; close requests carry unique IDs and acknowledge stale replies. A stalled
  renderer gets an explicit native Keep open / Close without saving fallback, bound to
  its originating request and window so a delayed answer cannot settle a later close.
- Recovery is under Electron's per-user `userData/recovery-v1` directory, at most 16
  snapshots with Rust-enforced quotas. Recover opens an unsaved copy; the original
  snapshot remains intact until the renderer explicitly confirms successful adoption
  and later save/discard. A full store still allows restoring/saving a snapshot.
  If damaged snapshots coexist with usable ones, every recovery choice displays a
  preservation warning; the damaged files are never silently removed.
- Existing PNG/SVG/JSON/component-library exports use renderer-owned Blob downloads,
  exact originating-window checks, known extensions, a native Save dialog and a 64 MiB
  bound. Remote downloads and navigation are denied.
- Node integration is off; context isolation, sandbox and web security are on. IPC
  checks the exact owning webContents, main frame and app URL. Permissions, popups,
  subframe navigation, webviews and network fetches are denied. CSP allows same-origin
  scripts and WASM compilation; inline styles remain necessary for the existing React
  styles. Custom-protocol resource resolution rejects symlink/path escapes.
- Backend loss preserves the canvas and reports file/recovery failure. Writes are never
  automatically retried after timeout. Shutdown waits for termination, escalating an
  unresponsive owned child to SIGKILL after one second, with a bounded reap wait.

## Sources

- [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron stable releases](https://releases.electronjs.org/?channel=stable)
- [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron custom protocols](https://www.electronjs.org/docs/latest/api/protocol)

See [`../../docs/architecture/design-desktop.md`](../../docs/architecture/design-desktop.md)
for the repository architecture and recorded verification boundaries.

### 2026-10-10 first navigation batch (historical)

The live canvas now presents completed frames through two alternating buffers,
committing pixels and camera transform together. A rendered margin covers small
pans without raster work. Native Cmd/Ctrl +/−/0 and the View menu control the
canvas camera; Electron page zoom stays at 1. Modified wheel zoom preserves the
world point under the cursor.

GPU preview density is calibrated from current-frame texture use, including SDR
scenes that need float effects. After bounded density reductions, complex previews
use bounded tiles and assemble a complete frame before presentation. Export remains
on its existing path. This is a memory fallback, not a persistent Figma-style tile
cache; complex HDR previews can be visibly softer and slower.

Run `bun run test:canvas-motion` in `frontend/design-client` for the real
React/WASM/Metal regression (17-layer sample, frame/overlay alignment, front-buffer
resize guard, cursor zoom anchor, SDR/HDR tile pixel comparison). The local macOS
run and native Electron screenshots are recorded in
[canvas follow-up evidence](../../testing/review/design-desktop-macos-gui-2026-10-10/canvas-motion/README.md).

### Exact live preview restored (2026-10-10)

The approximate preview experiment has been withdrawn. Live tiles use the same
existing deterministic shader arithmetic, sampling fields and rational filters as
reference rendering. The document's raster profile is preserved. No low-resolution
overview/intermediate level, forced `figmaSubpixel`, density budget or delayed
Retina refinement is used. Rendering requests the current device pixel density;
resource limits report an error instead of silently reducing quality. Cached prior
pixels may remain visible while an exact replacement is pending.

The 106 material/driver comparisons passed with zero byte and float-bit differences.
This is a scoped internal comparison, not complete Figma equivalence. See the
[restoration record](../../testing/review/design-desktop-macos-gui-2026-10-10/exact-preview/README.md).

`bun run package:exact` creates **Forma Exact** in `release/exact/`, preserving open
Forma and Forma Preview bundles and their unsaved documents. This is an unsigned
local verification bundle. `node scripts/verify-package.mjs --exact` verifies it.

### Exact HDR and pending input follow-up (2026-10-11)

The independently tagged local bundle `mac-20261011-precision-03` passed packaged
CPU interaction, production GPU/HDR interaction, Rust/SQLite readback and startup
smoke checks. Two actual drawing pointer events were received while a 200%, DPR 2
HDR frame was pending after a real inspector edit. No artificial render delay was
used. The final 56 HDR tiles retained physical pixel density.

The fixed HDR benchmark now completes its 200% frame in 23.456 seconds
(22.783 seconds with a warm backend), without budget retries or quality reductions.
This is still far from interactive performance. Current external Figma glass
reference pixels also remain mismatched; internal exactness does not establish
complete Figma parity. See the [native test evidence and reproduction commands](../../testing/review/design-desktop-macos-gui-2026-10-10/precision-electron-2026-10-11/README.md).

## 2026-10-11 canvas, panels and import/export follow-up

See the [current parity matrix and exact-preview evidence](../../testing/review/design-desktop-parity-2026-10-11/README.md). Source inventories, actual browser workflows, GPU pixel checks and packaged Electron checks have distinct scopes. Complete Figma functionality and UI pixel equality remain unproven; format gaps and the remaining external glass pixel are recorded explicitly.

## Legacy native archive admission and bounded read-only preview

The former “检查 Sketch 原生文件” menu is retired. Its internal no-argument
preload method opens a trusted native dialog; only the host sends the selected
path to `sketch.inspect`. The Rust sidecar applies a 64 MiB bounded read and the
shared design kernel's native ZIP/tree adapter validation. The renderer receives
a scoped kernel/schema/document/epoch identity, page/layer counts and a bounded
first-page display list, never
filesystem paths, archive bytes, Forma save handles or a converted Figma document.
Unknown contracts and stale responses fail closed. Cancelling the inspection
leaves the existing canvas and its pending saves unchanged.

The temporary native session compiles only the first page into the shared v7 GPU
scene (at most 2 MiB); host and renderer validate identity, revision zero, epoch,
finite arrays and area-program indices. The separate canvas reuses the existing
WebGPU renderer without converting to a Figma document. Page name and 512×384
viewport at origin (0,0), document scale 1:1 are explicit; this is not a fit-to-page
or whole-file preview. Unsupported content rejects the page instead of omitting
it. GPU policy/adapter/device failure is shown as unavailable. Closing the dialog
invalidates pending work and releases its device/bitmap/canvas resources.

Full-document `editable` and `renderable` remain false; the separate `preview`
status only means that a bounded scene was compiled, not that GPU drawing passed.
The inspection UI does not expose editing or durable save. `.fd` admission and
saving remain unchanged. CPU bridge/transport tests are available in the isolated
`testing/standalone/sketch-inspection` harness and desktop test directory.
Actual desktop WebGPU presentation remains pending hardware verification.


### Legacy native archive editing session

The former “打开独立 Sketch 编辑会话…” dialog is retired from the product menu. Its retained adapter lists
native pages/layers (first 512 entries, truncation explicitly shown) and offers
rename, supported leaf frames, native instance text overrides, undo, redo,
owner-scoped status reconciliation and Save As to a new
`.sketch` file. No Figma document conversion or Forma save handle is involved.
The frozen preload exposes only these named methods; file paths come exclusively
from trusted native Open/Save dialogs. No generic renderer command IPC is exposed.

The backend owns one native Session and process-scoped source path. Commands
validate owner/schema/epoch/revision and return bounded native summaries plus
history counts. Pending UI actions disable repeated submissions. A failed edit
is not replayed: the UI reads status and pauses editing when identity/state cannot
be verified. The session page selector requests a bounded read-only preview from the held
native Session, including unsaved edits. Each snapshot is fenced by owner, epoch,
revision and page ID. Rename/undo/redo changes its key; save-only state does not.
It reuses the same shared WebGPU consumer as file inspection. Old results and late
failures are retired, and Unsupported content is explicit. The 512×384 origin
viewport remains 1:1, not fit-to-page. Separate file inspection still reads files.

Save As holds the session lock through native archive export and publication.
It refuses every existing target. The helper publishes a same-directory synced
temporary file with a no-clobber hard link, then confirms directory durability.
Only a confirmed outcome updates the saved revision. A published-but-unconfirmed
outcome reports a warning and retains dirty state. Process restart loses unsaved
memory; no durable session/recovery or overwrite-save capability is claimed.

Dirty close requires `discard:true` and native confirmation with Keep open as
default. Normal window close and unresponsive-renderer close use the same guard.
A cancelled dialog does not alter the native session or the existing Forma canvas.

Three targeted CPU cases exercise the real store (rename/undo/redo/new-file save
and native reload), injected host routing/confirmation, and pure UI pending/
identity/reconciliation state. These do not verify Electron presentation, native
OS dialogs, the full sidecar, complete TypeScript types, or GPU execution.


Live-session preview adds two focused CPU cases: real unsaved rename/undo snapshots
and actual-frame transport/request ownership. GPU display remains unverified.
Open/close response loss has two additional targeted lifecycle cases. Retried
opening reconciles the already-owned slot through read-only status. A closed
owner has a typed `active:false` tombstone; only that exact owner-bound status,
not a network error or generic “not found”, permits close recovery. An unknown
open remains visible as uncertain and cannot silently dismiss the retained slot.

### Native leaf position and size

The selected-layer panel queries the independent kernel's read-only frame
capability before enabling numeric inputs. `leafFrame` and `setLeafFrame` are
separate named bridge methods; no raw native JSON or generic command is accepted.
Coordinates are local to the native parent, not screen/global coordinates. X/Y
are finite within ±1e9 and width/height within 0.5–1e9. Only kernel-approved
rectangle/oval/shapePath/bitmap leaves are enabled; unsupported ancestry, locks,
layout and transforms are rejected by the shared kernel validator.

Apply uses the existing owner/revision, pending, failure/status reconciliation
and history flow. An uncommitted failure retains the input draft and does not
mark the document dirty. Successful edits, undo and redo update the live-session
preview through revision changes. Native normalized path data remains authoritative.
Saving remains Save As to a new file only. No GPU runtime validation is implied.

### Native instance text-override editing

`setTextOverride` is a fixed preload/host/backend bridge to the existing independent
Sketch `Session::apply(SetTextOverride)` command. The selected native layer ID is
the instance; the user supplies a direct-child ID path from its local Symbol master,
such as `GROUP_ID/TEXT_ID` or `NESTED_INSTANCE_ID/TEXT_ID`, without the
`_stringValue` suffix. This is a native identity path, never a filesystem path or
generic command. Paths have at most 64 components, with 128 UTF-8 bytes per ID.
Text retains whitespace, newlines and Unicode, bounded by the kernel's 100,000
UTF-16-unit limit. Empty replacement requires an explicit clear choice in the UI.

The existing owner/kernel/schema/epoch/revision, pending and history guards apply.
The native kernel resolves supported unswapped local nested paths and rejects
unsupported targets; the bridge does not flatten Symbol masters, resolve external
masters, add swap semantics or change master text/rich-text runs. An uncommitted
failure preserves the same-revision input; uncertain outcomes reconcile status
without mutation replay. Drafts reset on selection/owner/revision change and are
not saved until Apply. Current values/target discovery and a complete Symbol editor
are not implemented. Text/Symbol preview remains unsupported by the render adapter.

2026-10-12 focused verification: one real backend/kernel leaf test covers native
resolution, rejection atomicity, cancellation, owner/revision fences, UTF-16 limits,
undo/redo, explicit empty text, source preservation and new-file save/reload; two
Node tests exercise the real fixed preload/host route and UI controller/draft guards
with injected transport. TSX transpilation is syntax-only. No full TypeScript check,
current Electron/sidecar/WASM build, native GUI, real Sketch app roundtrip or GPU
acceptance is implied. ResizeLegacyContainer is still not exposed by this bridge.

### Bounded alpha-only linear-gradient transport

The desktop preview gate additionally accepts exactly the native adapter's
axis-aligned, normalized linear gradients with 2–16 finite, strictly increasing
unique stops. Every stop must resolve through the managed color table to the
same RGB; only alpha varies. Horizontal/vertical forward and reverse axes are
allowed. Other gradient kinds, diagonal/degenerate transforms, extra gradient
planes, constant-color shortcuts, images and effects remain rejected.

The existing shared fixed-gradient DTO is checked for precision bits, u16 word
shape, signed integer arithmetic budget and coefficient consistency with the
paint/node transforms. This is boundary validation, not a new renderer or shader.
A real Rust inspect fixture covers four axis directions plus 2/16-stop limits;
one CPU validator case also rejects malformed stops/colors/transforms/programs.
Actual desktop GPU gradient presentation remains unverified.
