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

Pinned to the released **MCP 2025-11-25** handshake-based revision. This does not claim current-protocol parity: the official versioning page listed 2026-07-28 as current when prepared. Initialize negotiates `2025-11-25`; clients unable to support it should disconnect.

Implemented: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, empty `resources/templates/list`, `prompts/list`, `prompts/get`, `notifications/cancelled`, EOF and signal shutdown. Tools/results use JSON Schema 2020-12-compatible schema metadata from the real registry; the shared API validates the actual published schema vocabulary and native model.

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

## Structured results / actual artifacts

Small read/query results retain the actual shared operation envelope. Each default `tools/call` response is capped at **256 KiB**, including text and structured output; large queries return `result_too_large` and must be narrowed or paginated. This limit is distinct from the 32 MiB explicit file-transfer frame limit.

Export tools are **resource-first**: `structuredContent.result` contains metadata, `resourceOnly: true`, and `resources: [{field, encoding, uri, mimeType, bytes}]`. HTML, CSS, SVG/native JSON content, native FD/Sketch base64 and nonempty code asset manifests are omitted from inline tool output. Large export metadata has its own `$metadata` JSON resource. The direct shared operation API is unchanged.

`resources/read` is an explicit client file-saving action and returns the exact original text or binary blob. A saving client reconstructs `text` fields from `contents[0].text`, `base64` fields from `.blob`, `json` fields by parsing `.text`, and `data-url` fields from the MIME type plus blob; `$metadata` JSON merges the remaining export metadata. Save each export before requesting another large export, which can evict it. For AI inspection use bounded `context.get` / node queries rather than reading font/base64 files into model context.

`futureox-design://automation/capabilities` exposes real schemas and limits. Resources are actual generated HTML, CSS, SVG, native JSON, native `.fd` or `.sketch` files, plus asset/metadata manifests. Files remain inert; the adapter does not execute HTML/SVG. Small actual PNG/JPEG/WebP previews may be MCP images; larger previews use exact blob resources. There is no re-rendering, resizing or placeholder screenshot.

The session-only export cache holds 16 artifacts / 32 MiB stored text or base64. Each resource must fit the cache and 32 MiB response frame with envelope reserve. All files for one export are admitted atomically. If they cannot fit, the tool returns `artifact_unavailable` with a narrow/split instruction; it never silently drops bytes or falls back to inline file payloads. Oldest entries are evicted, disconnect clears everything, and reading an expired URI returns `-32002`. This cache is an export snapshot, never a design source of truth.

Limits: 256 KiB default tool output; 32 MiB explicit file-transfer frames; 8 MiB ordinary requests; larger input only for advertised font/native-document/Sketch imports or direct atomic batches containing them. 8 active requests, 1 heavyweight input, 48 MiB pending input, 40 MiB stdout queue, 256-character IDs, 65,536 request IDs/session and 512 tools. Shared operation limits still apply to queries, previews and exports.

Adapter timeout is 60 seconds; the desktop may impose a shorter deadline. Cancellation propagates and suppresses the MCP reply, but cannot undo a committed mutation. Inspect revision/history before retrying after timeout/disconnect. Work that ignores cancellation occupies its bounded slot until settlement/session close. Backpressure can close a session rather than grow memory indefinitely.

## Verification

```sh
cd frontend/design-mcp
npm run check
npm test                 # protocol/client/subprocess tests; no listener
npm run test:integration # real temporary Unix sockets + spawned stdio CLI
cd ../design-client
node_modules/.bin/vitest run src/automation/mcp-e2e.test.ts
```

Real-Editor tests use existing WASM/font setup: native node creation, layout/text fine-editing, checks, HTML/CSS/SVG/resources, JSON, true `.fd` and Sketch resource roundtrips, full 17.77 MB font export isolation, stale-write/rollback/undo boundaries and 3,000-node paginated queries. No GPU renderer is launched. Some sandboxes reject Unix `listen` with `EPERM`; injected streams are not a substitute for OS-level socket verification. Live desktop opt-in/clipboard, Windows/macOS sockets, real preview capture and actual Codex acceptance require on-device verification.

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
Old resources retain the original revision until eviction or MCP disconnect.

The permitted CPU regression, actual agent-selected visual refinement and native
acceptance checklist are documented in
`testing/verification-visual-feedback/README.md`. Browser, Electron, OS transport
and GPU presentation were not exercised by that CPU-only harness. The manual
read-only native helper is `examples/capture-native-preview.mjs`; its default help
path does not access credentials or start native work. Run its explicit `--run`
mode only in an authorized desktop environment with an already-enabled bridge.
