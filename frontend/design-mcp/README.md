# Futureox Design MCP

Local, dependency-free Node.js 22+ stdio adapter for the live editor's shared operation API. It owns no document store or independent mutation/history implementation. Production calls go through the explicitly enabled desktop bridge to `frontend/design-client/src/automation/` and the mounted `Editor`.

## Run / Codex configuration

1. Open the intended document in the desktop app and explicitly enable its AI bridge with read or write scope.
2. Copy the current connection details. Set `FUTUREOX_DESIGN_SOCKET` to `endpoint`, `FUTUREOX_DESIGN_SESSION` to `sessionId`, and `FUTUREOX_DESIGN_BRIDGE_TOKEN` to the ephemeral `token` in the launching process environment. Do not put token values in arguments, repository files, logs or committed configuration.
3. Run on the same machine and OS user as the desktop app:

```sh
node /absolute/path/futureox-desgin/frontend/design-mcp/src/cli.mjs
```

`--socket PATH` and `--session ID` can replace their environment variables. There is intentionally no `--token` argument. Help and diagnostics go to stderr; stdout contains only newline-delimited MCP JSON-RPC.

The CLI is a separate source package: the Electron package does not automatically bundle this sibling directory or Node. Supply its real absolute path and a Node 22+ runtime on the desktop machine.

Codex example using the [official MCP configuration options](https://developers.openai.com/codex/mcp):

```toml
[mcp_servers.futureox_design]
command = "node"
args = ["/absolute/path/futureox-desgin/frontend/design-mcp/src/cli.mjs"]
env_vars = ["FUTUREOX_DESIGN_SOCKET", "FUTUREOX_DESIGN_SESSION", "FUTUREOX_DESIGN_BRIDGE_TOKEN"]
startup_timeout_sec = 15
tool_timeout_sec = 70
```

Start Codex with the current session variables already present. This example forwards values; it does not persist them. Re-enabling, app/document/session changes or revocation invalidate old details. No automatic reconnect targets a different editor. Desktop GUI and real Codex interoperability still require on-device acceptance testing.

## Explicit protocol compatibility

The adapter implements two explicit stdio modes. Legacy mode keeps the **2025-11-25** handshake: `initialize`, then `notifications/initialized`, followed by ordinary requests. Its negotiated version remains `2025-11-25`; clients unable to support it should disconnect.

The added modern mode uses the **2026-07-28** identifier from `src/modern-protocol.mjs`. Each request carries `params._meta["io.modelcontextprotocol/protocolVersion"]: "2026-07-28"` and an object at `params._meta["io.modelcontextprotocol/clientCapabilities"]`; metadata is validated per request and never grants access. `server/discover` is a backend-free discovery route. Modern mode does not use `initialize` or `ping`, and a stdio connection cannot mix the two eras. Modern results add `resultType: "complete"` and server metadata; catalog/resource responses use `ttlMs: 0` and `cacheScope: "private"`. The implementation and its tests are not a claim of universal current-client compatibility or official certification.

Both modes implement `tools/list`, `tools/call`, `resources/list`, `resources/read`, empty `resources/templates/list`, `prompts/list`, `prompts/get`, `notifications/cancelled`, EOF and signal shutdown. Tools/results use JSON Schema 2020-12-compatible schema metadata from the real registry; the shared API validates the actual published schema vocabulary and native model. Modern export links are explicit resource handles and are omitted from `resources/list`; legacy mode retains its export listing. Both retain the same bounded process-local cache and terminal revocation boundary.

Not advertised: HTTP, remote access, resource subscriptions, list-change notifications, sampling, elicitation, tasks, arbitrary code execution or a server-side AI model. Catalogs are bounded and returned whole; invented catalog cursors are rejected. Actual node/context query pagination belongs to the shared API with its revision-bound cursors.

No third-party SDK or install step is required. The existing repository `.mjs` / `node:test` convention is used. There is no dependency lockfile to drift and no official SDK-conformance-certification claim.

Official references reviewed: [base protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts), [version status](https://modelcontextprotocol.io/specification/versioning).

## Real operation contract

Tools derive only from authenticated `capabilities.methods`: `{name,description,inputSchema,mutates}`. `node.update` maps to `design_node_update`; dots/hyphens normalize to underscores and collisions fail closed. Unsupported Figma-style aliases are never advertised.

Example arguments for `design_node_update`:

```json
{"params":{"ids":["node-uuid"],"patch":{"name":"Updated"}},"documentId":"observed-document-uuid","session":3,"expectedRevision":12}
```

All three fences are mandatory for writes. Reads default to the handshake's document/session and can supply explicit fences. No write silently acquires a newer revision. The real core handles schema/model validation, atomic batches, `Editor.change`, interaction guards and native undo/redo. Read-only scope filters writes here and at the host.

The injectable backend interface is `listTools(context)` and `callTool(name,args,context)`, where context contains `signal` and `requestId`. `OperationBackend` adapts shared API capabilities plus `execute(AutomationRequest)`. `SocketDesignBackend` connects this to the desktop. Test stream injection is not a production fake backend.

Bridge v1 wire, owned by `frontend/design-desktop/src/automation-bridge.mjs`:

```text
{id,method:"capabilities",params:{protocolVersion:1,sessionId,token}}
{id,result:{protocolVersion:1,sessionId,scope,capabilities,documentId,session,revision}}
{id,method:"execute",params:{id?,method,params?,documentId,session,expectedRevision?}}
{id,result:AutomationResponse} OR {id,error:{code,message}}
{method:"cancel",params:{requestId}}
```

Unix: absolute current-user-owned socket mode 0600, real private directory mode 0700, no symlink traversal. Windows: `\\.\pipe\futureox-design-*` plus the same ephemeral token. No TCP, discovery file, durable credential or shell command. Token values are redacted from bridge errors.

## Bounded inspect / generate / fine-edit workflow

The client model runs the workflow; the server only executes supported operations. The two prompts (`design_generation`, `design_to_code`) suggest a finite client-side budget, for example three cycles:

1. Inspect capabilities, document, selection, context, styles/components and current revision.
2. Create a schema-aware, bounded native `batch.apply` with current fences. One successful batch is one undo step.
3. Inspect `context.get` and `design.check`; use `preview.capture` only if advertised. Checks are structural/heuristic and are not GPU pixel or aesthetic validation.
4. Apply only the justified fine edit, refresh state and inspect again. Stop on satisfaction, budget exhaustion, repeated failures, unavailable capabilities or a user decision.
5. Export and report real warnings. HTML/CSS is approximate; native JSON / binary `.fd` preserves the design model.

The adapter does not enforce or execute model iterations. No prompt authorizes unrelated edits, external asset fetching, publishing, shell/eval or an autonomous background AI loop.

## Small edits with expected values and retry receipts

The live registry now advertises `design_node_patch`, `design_layout_patch`,
`design_paint_patch`, `design_text_styleRange`, `design_text_replaceRange` and `design_batch_preflight`.
Use partial named leaves instead of reconstructing whole nodes or paint stacks.
Node/layout/paint patches support optional expected leaf values; text ranges use
half-open UTF-16 offsets at complete grapheme boundaries. `text.styleRange` accepts
optional expectedText; `text.replaceRange` requires it to equal the selected substring.
Replacement supports insertion (`start === end`) and deletion (`text: ""`) without
relocating edits among repeated substrings. Inserted text inherits the run at start
(right-biased at boundaries), the preceding run only at EOF, or layer defaults in gaps.
It preserves outside rich styles and rejects new cross-edge grapheme joins; select
the whole adjacent grapheme explicitly instead. The resulting text is limited to
100,000 UTF-16 units and 4,096 runs. Identical replacement preserves run segmentation
and creates no undo entry. Existing document/session/revision fences remain mandatory.
Existing variable binding and component override operations remain the source of truth.

`batch.preflight` only stages the five new edit methods plus variable.bind/unbind.
Its output explicitly says `validation: "authored-only"`,
`derivedResolution: "deferred"` and `authoritativeCommitValidationRequired: true`.
It never activates fonts, invokes layout, commits history or consumes a receipt.
Derived positions and component materialization are resolved only by the real commit.

`batch.apply` accepts an optional ASCII `mutationId`. Within the same API document
session, retry identical parameters and original fences with that same key after
an uncertain response; a successful retry returns `receipt.replayed: true` without
another commit, even if the user has since undone it. Changed arguments conflict;
foreign documents/sessions remain rejected. Receipts are bounded and session-local,
not durable across process restart or bridge recreation. Authored edit and batch.apply responses
include a bounded JSON-pointer before/after summary that omits image/font payloads.

See [granular editing contract and examples](../../docs/GRANULAR_MCP_EDITING.zh-CN.md)
for precise coverage, limits and unsupported fields. This is not a claim of Figma
leaf-level component inheritance or pixel equivalence.

## Structured results / actual artifacts

Small read/query results retain the actual shared operation envelope. Each default `tools/call` response is capped at **256 KiB**, including text and structured output; large queries return `result_too_large` and must be narrowed or paginated. This limit is distinct from the 32 MiB explicit file-transfer frame limit.

Export tools are **resource-first**: `structuredContent.result` contains metadata, `resourceOnly: true`, and `resources: [{field, encoding, uri, mimeType, bytes}]`. HTML, CSS, SVG/native JSON content, native FD/Sketch base64 and nonempty code asset manifests are omitted from inline tool output. Large export metadata has its own `$metadata` JSON resource. The direct shared operation API is unchanged.

`resources/read` is an explicit client file-saving action and returns the exact original text or binary blob. A saving client reconstructs `text` fields from `contents[0].text`, `base64` fields from `.blob`, `json` fields by parsing `.text`, and `data-url` fields from the MIME type plus blob; `$metadata` JSON merges the remaining export metadata. Save each export before requesting another large export, which can evict it. For AI inspection use bounded `context.get` / node queries rather than reading font/base64 files into model context.

`futureox-design://automation/capabilities` exposes real schemas and limits. Resources are actual generated HTML, CSS, SVG, native JSON, native `.fd` or `.sketch` files, plus asset/metadata manifests. Files remain inert; the adapter does not execute HTML/SVG. Small actual PNG/JPEG/WebP previews may be MCP images; larger previews use exact blob resources. There is no re-rendering, resizing or placeholder screenshot.

The session-only export cache holds 16 artifacts / 32 MiB stored text or base64. Each resource must fit the cache and 32 MiB response frame with envelope reserve. All files for one export are admitted atomically. If they cannot fit, the tool returns `artifact_unavailable` with a narrow/split instruction; it never silently drops bytes or falls back to inline file payloads. Oldest entries are evicted, and MCP disconnect clears everything. For a backend with a host-owned terminal signal, terminal disconnect or grant revocation also synchronously clears its associated server cache; `resources/list` and `resources/read` then return `-32000` (authorization session ended), not an empty success. An unknown or evicted URI in a live session returns `-32002`. A new authorized backend/server never restores an old cache. This cache is an export snapshot, never a design source of truth.

Limits: 256 KiB default tool output; 32 MiB explicit file-transfer frames; 8 MiB ordinary requests. Larger input is admitted only for advertised font/native-document/Sketch imports, explicit clipboard paste operations, their supported direct atomic batches, or the standalone `workspace.importCopy` host operation. Host import-copy accepts native JSON/FD and compatibility Sketch/FIG with its own framing reserve; it is not a batch operation. There are 8 active requests, 1 heavyweight input, 48 MiB pending input, 40 MiB stdout queue, 256-character IDs, a 65,536-request session budget and 512 tools. Legacy request IDs cannot be reused; modern IDs cannot overlap an outstanding request. Shared operation limits still apply to queries, previews and exports.

Adapter timeout is 60 seconds; the desktop may impose a shorter deadline. Cancellation propagates and suppresses the MCP reply, but cannot undo a committed mutation. Inspect revision/history before retrying after timeout/disconnect. Work that ignores cancellation occupies its bounded slot until settlement/session close. Backpressure can close a session rather than grow memory indefinitely.

## Verification

```sh
cd frontend/design-mcp
npm run check
npm test                 # protocol/client/subprocess tests; no listener
npm run test:integration # real temporary Unix sockets + spawned stdio CLI
npm run test:modern      # production modern-protocol dispatch with test backends
npm run test:modern:official # requires MCP_OFFICIAL_SDK_ROOT; actual SDK/stdio, fixture backend
cd ../design-client
node_modules/.bin/vitest run src/automation/mcp-e2e.test.ts
```

Real-Editor tests use existing WASM/font setup: native node creation, layout/text fine-editing, checks, HTML/CSS/SVG/resources, JSON, true `.fd` and Sketch resource roundtrips, full 17.77 MB font export isolation, stale-write/rollback/undo boundaries and 3,000-node paginated queries. No GPU renderer is launched. Some sandboxes reject Unix `listen` with `EPERM`; injected streams are not a substitute for OS-level socket verification. Live desktop opt-in/clipboard, Windows/macOS sockets, real preview capture and actual Codex acceptance require on-device verification.

The ordinary integration suite creates real temporary Unix sockets and a stdio CLI subprocess against a deterministic bridge fixture; it does not launch Electron or a real Editor/SQLite backend. Official-SDK stdio tests are separate and skip when `MCP_OFFICIAL_SDK_ROOT` is absent; a skip is not acceptance. See the [functional merge record](../../testing/verification-functional-merge-20261021/README.md) for current local runs and the imported historical results.

### Reproduce the original example

The optional example authors complete synthetic login/dashboard pages through real MCP requests, imports the repository's actual Noto Sans SC font, checks/fine-edits the design, and explicitly reads resources to save HTML/CSS/SVG plus native JSON/FD. Tool responses stay below 256 KiB; file bytes are read only by the packager. It uses existing frontend dependencies and writes only to the explicitly supplied output directory:

```sh
cd frontend/design-client
FUTUREOX_MCP_EXAMPLE_DIR=/absolute/output/directory node_modules/.bin/vitest run --config ../design-mcp/examples/vitest.config.mjs
```

This example is separate from the adapter/source distribution. `raw-api.html` and `export.css` preserve exact code-export output. The example packager extracts the actual embedded font with its unchanged SIL OFL license and adds an explicit `@font-face` plus a self-only font CSP to `index.html`/`styles.css`. This font packaging is sample glue: `code.export` itself does not export font binaries. The static pages have no authentication or live data behavior. The manifest records measured timings, export warnings and the absence of GPU/browser acceptance testing.

### Product CPU preview feedback

`design_preview_capture` now exposes document/page/root IDs, session/revision,
world bounds, exact pixel dimensions, requested scale, byte count and CPU renderer
provenance. Its default page is the active page. Supply the observed revision to
avoid capturing a newer edit; active-page navigation during an implicit-page
capture is rejected. Captures are cancelled on session change, cancellation or
deadline, and return explicit renderer/budget failures without substitute images.

The capture is a real product **CPU raster export of design content**. It is not an
application-window screenshot and does not assert equality with the displayed GPU
canvas. The requested resolution is never silently reduced. Pixel/side limits and
the 8 MiB base64-inclusive transport limit are disclosed in live capabilities.

Every preview has an immutable image resource. Small previews also appear once as
native MCP image content; large previews remain full resolution in `resources/read`.
Clients should display that image to the model for visual feedback, not paste raw
base64 into text. If a client cannot display images/resources, report that visual
inspection is blocked. Context or geometry checks alone are not a visual review.
While the authorization session remains live, old resources retain the original revision until eviction. They also expire on MCP disconnect or the associated backend's terminal disconnect/revocation.

The permitted CPU regression, actual agent-selected visual refinement and native
acceptance checklist are documented in
`testing/verification-visual-feedback/README.md`. Browser, Electron, OS transport
and GPU presentation were not exercised by that CPU-only harness. The manual
read-only native helper is `examples/capture-native-preview.mjs`; its default help
path does not access credentials or start native work. Run its explicit `--run`
mode only in an authorized desktop environment with an already-enabled bridge.


### Export snapshot lifetime and revocation

A successful export authorizes the returned immutable snapshot; resource reads never fetch a later document revision. The server-side cache is bounded by both the MCP session and, when supplied by the trusted backend, its authorization/connection lifetime. The current socket backend is terminal after any `fail()` path and never automatically reconnects or chooses a new editor. Bridge disable, document/session replacement and desktop closure destroy that socket and therefore expire its cached exports once that terminal event is observed. No new authentication system, per-URI credentials, network service or reconnect authority is introduced. Backends without this optional lifetime signal retain their existing MCP-session-only lifecycle.

Revocation prevents subsequent cache reads and late results from repopulating it. Both modes recheck the backend's terminal authorization signal immediately before writing successful `tools/list`, `tools/call`, `resources/list` and `resources/read` frames; a still-queued success becomes an ended-session error. Modern mode also checks the request owner and cancellation at final write. Bytes already handed to stdout, delivered to the caller or independently saved cannot be recalled. The stdio MCP session remains available to return an explicit ended-session error. Re-enable requires a new authorized backend/server; old resource URIs do not carry over. Cancellation or lost responses still cannot undo an accepted mutation, so inspect/reconcile state rather than retry blindly.
