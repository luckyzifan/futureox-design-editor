# Figma-shaped MCP facade

This is a thin compatibility surface for AI clients that already drive Figma through MCP. It is not a second document model. Every tool calls the existing Design API (`frontend/design-client/src/automation/`). The shared registry still advertises only `design_*` tools. The eight core Figma-shaped names live in `frontend/design-mcp/src/figma-facade.mjs`; the remaining Figma catalog names live in `frontend/design-mcp/src/figma-remote-tools.mjs`. Both are translated back into that API.

The server does not evaluate plugin JavaScript. `use_figma` `code` is forwarded only when the desktop host has registered a plugin bridge. Without that bridge the tool returns `plugin_host_unavailable`.

Screenshots are `preview.capture`: a CPU raster of design content, not an application window or the GPU canvas. `fileKey` is accepted and ignored. The connection is bound to the document whose local automation bridge is enabled.

## Connect

1. Open the design in the desktop app and enable local automation (read-only, or read and edit for `use_figma` and `open_document`).
2. The enable dialog’s JSON includes `endpoint`, `sessionId`, `token`, and, when the listener started, `figmaMcp.url`.
3. For the Figma-shaped stdio catalog, choose **Copy Figma-compatible stdio config** in the MCP connection and permissions panel. The JSON entry is named `futureox_design_figma` and runs the packaged `figma-cli.mjs`. **Copy stdio client config** continues to provide the full `design_*` catalog.

Stdio, using the same socket variables as the full catalog:

```sh
node /absolute/path/futureox-desgin/frontend/design-mcp/src/figma-cli.mjs
```

Environment: `FUTUREOX_DESIGN_SOCKET`, `FUTUREOX_DESIGN_SESSION`, `FUTUREOX_DESIGN_BRIDGE_TOKEN`. Do not pass the token as an argument.

Loopback HTTP is `http://127.0.0.1:<port>/mcp`. The desktop starts this listener when automation is enabled. **Copy Figma-compatible HTTP config** includes its current URL and `Authorization: Bearer <token>`. If the desktop cannot load the adapter, run `frontend/design-mcp/src/figma-http.mjs` with the same variables. The standalone launcher prints the URL to stderr and keeps the token out of logs.

Cursor-style client config:

```json
{
  "mcpServers": {
    "futureox-design": {
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

Codex-style stdio config uses `node` and `frontend/design-mcp/src/figma-cli.mjs`, forwarding the three environment variables. Do not commit the token.

The HTTP listener implements Streamable HTTP with JSON responses. Use the URL and bearer token from the active desktop automation grant. Native clients can omit the `Origin` header. When present it must match the listener origin. A successful `initialize` returns a distinct `Mcp-Session-Id`. Send it and the negotiated `MCP-Protocol-Version` on subsequent requests. `DELETE` releases that session. The listener holds up to eight clients per grant and retires idle sessions after 30 minutes of inactivity. The listener returns `405` for a GET event stream and `400` for an unsupported protocol version. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Tool arguments may also assert the active local `sessionId`. Use the current `Mcp-Session-Id` for HTTP, or `FUTUREOX_DESIGN_SESSION` from the packaged Figma stdio config. The assertion is checked before the tool reads the document. Figma cloud session IDs do not select a Futureox document.

## Web editor

The browser page does not listen on a port and cannot host stdio. The in-app Design API buttons (context, check, export) still run inside the page. An external AI client needs the desktop bridge, either the listener the desktop starts or `figma-http.mjs` / `figma-cli.mjs` pointed at that bridge.

## Tools

| Tool | Design API | Notes |
|---|---|---|
| `get_metadata` | `page.list`, `node.find` | Omit `nodeId` to list pages. Pass a local page or node ID for an XML outline and structured nodes. Use `limit` from 1 to 100 and return `nextCursor` as `cursor` with the same `nodeId` to continue. |
| `get_selection` | `selection.get`, `node.get` | `[Futureox extension]` Active page and selection. At most 20 node summaries. Not a Figma tools-index name; listed by default. |
| `get_design_context` | `context.get`, `code.export` | Futureox HTML/CSS when `code.export` is available. Not Figma React + Tailwind. `clientFrameworks` is ignored. |
| `get_screenshot` | `preview.capture` | PNG of the node, selection or active page. `maxDimension` limits the rendered size. `contentsOnly: false` includes surrounding page content inside the crop. `enableBase64Response: false` requests a resource link without inline image content. |
| `get_variable_defs` | `variable.list`, `style.list`, `node.get` | Local variables, their alias dependencies across modes, and shared styles on the specified node or first 20 selected nodes. An empty selection returns a bounded document catalog. |
| `download_assets` | `preview.capture`, `vector.export`, or `raster.sourceAssets` | Up to 20 local nodes as separate MCP resources. `png`, `jpeg`, `webp`, `svg`, or bitmap `pdf`. Use `rawImagesOnly` for the original embedded image sources. |
| `use_figma` | `batch.apply` | Listed when the session can edit. One undo step for 1–40 structured operations. `description` is required. |
| `open_document` | `workspace.open` | `[Futureox extension]` Listed when the session can edit and has a workspace write grant. Opens a saved local design and can end the automation session. Not a Figma tools-index name; listed by default. |
| `get_code_connect_map` | process-local Code Connect map, `node.get`, `selection.get` | Read mappings for `nodeId`, `nodeIds`, or the selection. Empty results return `unsupported_remote_capability`. |
| `get_code_connect_suggestions` | local component identity, process-local Code Connect map | Suggest unconfirmed mappings and report unmapped local components without inventing a source. |
| `get_figjam` | none | Listed; every call returns `unsupported_remote_capability`. Futureox has no FigJam board model. |
| `get_motion_context` | `animation.list`, `animation.get`, `prototype.get`, `node.find` | Authored local clips, keyframes, derived CSS, and prototype interactions for `nodeId`. Not Figma timeline playback. |
| `get_shader` | none | Listed; every call returns `unsupported_remote_capability`. Futureox has no shader source model. |
| `list_shaders` | none | Listed; every call returns `unsupported_remote_capability`. Futureox has no shader library. |
| `add_code_connect_map` | local component identity, process-local Code Connect map | Write scope only. Stores one mapping at the current document revision; never edits the design document. |
| `send_code_connect_mappings` | process-local Code Connect map | Write scope only. Confirms stored mappings at the same document revision; stale mappings return `stale_revision`. |
| `weave_list_tools`, `weave_get_tool_inputs`, `weave_run_tool`, `weave_get_tool_run_output`, `weave_cancel_tool_run`, `weave_upload_asset` | none | Listed for Figma clients. Every call returns `unsupported_remote_capability`; this document session exposes no Weave account, credits, hosted recipe catalog, upload ticket, or run queue. |
| `weave_find_model`, `weave_run_model`, `weave_get_model_run_output` | none | Listed for Figma clients. Every call returns `unsupported_remote_capability`; this document session exposes no Weave-compatible model catalog, pricing, or prediction service. |
| `weave_request_report` | none | Connected Figma server only; not in the public tools-and-prompts index. Listed and returns `unsupported_remote_capability`. |
| `create_session` | `document.get` | Returns the active local automation session as `sessionId`, which other facade tools accept. Not a Figma cloud file session. |
| `create_branch` | none | Connected Figma server only; not in the public index. Returns `unsupported_remote_capability`; Futureox has no branch or merge model. |

### Local catalog additions

These names keep the public Figma input schema. Write tools are listed when the session can edit; every handler rechecks scope. A read-only session lists only the read entries, matching the core facade's existing filtering.

| Tool | Design API | Local behavior |
|---|---|---|
| `whoami` | `document.get` (optional) | Local application identity: handle `futureox-local`, `email: null`, one plan `local::0`, seat `owner`, and the bound document. It is not a Figma account or OAuth grant. |
| `create_new_file` | `workspace.importCopy` | Saves a blank local Design document and returns `documentHandle`; it does not switch the editor. Only `editorType: design` exists locally; `figjam`, `slides`, and `figmake` return `unsupported_editor_type`. `planKey` and `projectId` are accepted for schema compatibility. `rootHandle` is the local workspace grant; `mutationId` is generated when omitted. Open the result with `open_document`. |
| `get_comments` | `review.list` | Reads local document reviews as threads with replies, positions, kind, and resolved state. `pageId`, `nodeId`, `resolved`, `threadId`, `offset`, and `limit` (1–100) work. Replies are bounded to 20 per thread and each text to 2,000 characters, with truncation flags. `author`, `mentionedUser`, `unread`, and `threadStarterOnly` return `unsupported_filter`; there are no Figma reactions, mentions, unread state, or image attachments. |
| `get_libraries` | `document.get`, `collection.list`, `variable.list`, `component.list`, `style.list` | Returns the single `local-document` library with its collections, variable count, component count, and style count. `offset` paginates the one-entry library list. Team, organization, Community, and cross-file libraries do not exist locally. |
| `search_design_system` | `document.get`, `variable.list`, `component.list`, `style.list` | Answers `queries` in order for `entity: component`, `variable`, or `style` by case-insensitive name match, at most 20 matches per query. Component matches include variant axes, property keys, and slot keys from the local main-component index. `includeLibraryKeys` adds `libraryKey: local-document`; `disableCodeConnect` has no effect because no Code Connect map exists. |
| `get_context_for_code_connect` | `node.get`, `component.get`, `node.find` | Returns local component metadata: variants, component properties, slots, component-set identity, instance link, template keys, instance ids, and up to 100 descendant summaries. `codeConnect.available` is false; no template or mapping is generated. |
| `upload_assets` | `svg.import`, `node.create` | Imports up to 60 inline assets of at most 10 MB each. SVG `content` becomes editable vector layers. PNG, JPEG, GIF, or WebP `dataUrl` becomes a rectangle with the exact embedded image fill. Every item is validated before the first write, then each write is fenced with the revision returned by the previous committed write; a later failure reports the items already imported. `nodeId`/`nodeIds` select a parent container, not an existing fill. `scaleMode` and `batchCommit` are accepted and ignored. A call without `assets` returns `inline_assets_required`; no upload URL is fabricated. |

`upload_assets` has no upload-URL phase. The ordinary MCP request budget is 8 MiB, so an inline asset that exceeds that budget cannot reach this tool in one request even though the schema accepts up to 10 MB per asset.

### Listed remote-only tools

These names are visible in `tools/list` with their documented input schemas. Every call validates arguments first and then returns `unsupported_remote_capability` with `error.details.capability`, `error.details.hint`, and `error.details.docs`; no remote job, file, layer, credit charge, or resource URI is fabricated.

| Tool | Validation kept | Reason |
|---|---|---|
| `export_video` | `nodeId` xor `jobId`; `fps` 5–60; `quality` low/medium/high; `constraint` SCALE ≤ 10 or WIDTH/HEIGHT ≤ 4096 px; `ttlSeconds` 30–604800 | No timeline renderer or MP4 encoder. Use `download_assets` or `vector.export` for still assets. |
| `generate_figma_design` | `fileKey`, optional `captureId`, `nodeId` | No browser capture or live-site layer conversion. |
| `generate_diagram` | required `mermaidSyntax`, `name`; optional `fileKey`, `planKey` | No FigJam document type or Mermaid layout service. |
| `generate_image` | required `prompt`; optional `width`, `height`, `model`, `fileKey`, `nodeId`, `planKey` | No image model or AI-credit service. Import existing images with `upload_assets`. |
| `generate_vector_illustration` | required `fileKey`, `prompt`; `kind` icon/illustration; `width`/`height` 16–2048; optional `currentPageId`, `parentNodeId` | No vector generation model. Import existing SVG with `upload_assets`. |
| `html_to_figma` | required `fileKey`, `html`; optional `name`, `pageId`, `parentId`, `selector` | `document.import` explicitly rejects HTML and no HTML layout converter exists. |
| `send_code_to_figma` | required `fileKey`; optional `pageId`, `repairFrom`, `upload.archivePath` | No Make file or code-layer build service. `workspace.importCopy` accepts native, Sketch, and FIG documents only. |
| `list_generative_plugins` | optional `cursor` | No account plugin library. |
| `get_generative_plugin` | required `id`; optional 40-hex `version`, `includeSource` | No plugin source store or resource URI. |
| `create_generative_plugin` | required `name`, `description`, `planKey` | No plugin platform or build service. |
| `update_generative_plugin` | required `id`, `commitMessage`; `files[].path` code.ts/ui.html; optional `metadata` | No plugin source store or build service. |
| `list_shaders` | optional `cursor` | No shader registry. |
| `get_shader` | required `id`; optional 40-hex `version`, `includeSource` | No shader source store or resource URI. |
| `list_file_shaders` | required `fileKey` | Local documents have no shader fills/effects; returns a typed error, not an empty success. |
| `create_shader` | required `name`, `description`, `planKey`, `kind` effect/fill | No shader platform or build service. |
| `update_shader` | required `id`, `kind`, `commitMessage`; `files[].path` main.ts; optional `metadata` with `isAnimated`/`usesMouse` | No shader source store or build service. |

Metadata cursors bind to the local editor session and document revision. Restart the outline without a cursor after `stale_cursor`. XML nests nodes shown on the current page. Use structured node `parentId` values to join relationships across pages. An unknown local node ID returns `not_found` with the current page list in `error.details.pages`.

Use the `create_design_system_rules` MCP prompt to draft project guidance from supported local reads. Retrieve the prompt without arguments through `prompts/get`.

`use_figma` operations:

- `create`: `kind`, optional `parentId`, `id`, `index`, `x`, `y`, `width`, `height`, `name`, `text`, `fontSize`, `opacity`, `visible`, `fill` (`#RRGGBB`) or `fills`
- `update`: `nodeId` plus at least one of `name`, `text`, `fontSize`, `opacity`, `visible`, `locked`, `width`, `height`, `x`, `y`, `fill`, `fills`, `transform`
- `delete`: `nodeId` or `nodeIds`
- `select`: `nodeIds` (empty clears the selection), optional `pageId`
- `move`: `nodeId` or `nodeIds`, `parentId`, optional `index`

`x` and `y` are parent-local document units. An update reads the current transform and replaces `tx`/`ty`. Kinds are `slice`, `frame`, `section`, `group`, `rectangle`, `ellipse`, `polygon`, `star`, `line`, `vector`, `text`.

Plugin bridge contract, registered by host code with `registerFigmaPluginBridge({ run })`:

```js
run({ code, description, documentId, session, revision }, context) => AutomationResponse
```

The MCP process does not eval `code`. The current desktop build does not register a bridge; the plugin host is a separate change.

## Weave, sessions, and branches

`frontend/design-mcp/src/figma-weave-tools.mjs` registers the connected server's Weave, session, and branch names so `tools/list` answers a Figma client instead of an unknown-tool error. Every call is explicit:

- The nine `weave_*` names and `weave_request_report` return `unsupported_remote_capability` with `error.details.capability` and `error.details.docs`. Weave runs recipes and models on a Figma account with credits; this document session exposes no Weave account, credits, hosted catalog, upload ticket, job queue, or hosted prediction service, and no remote request is made. The desktop Design Assistant is a separate editor feature and is not reachable from this MCP session. Advertised arguments follow the capability summary in [DESIGN_AUTOMATION_PARITY.zh-CN.md](DESIGN_AUTOMATION_PARITY.zh-CN.md) section 3.7 and are not interpreted; the connected server's exact published schemas were not available offline.
- `weave_request_report`, `create_session`, and `create_branch` appear on the connected Figma MCP server but not in the public tools-and-prompts index. They are registered for comparison and labeled here rather than presented as documented public tools.
- `create_session` is the one supported mapping. It returns the active local automation transport session (`Mcp-Session-Id` over HTTP, `FUTUREOX_DESIGN_SESSION` over packaged stdio) with the current `documentId` and `revision`. That value is exactly what other facade tools accept as `sessionId`. It does not create a Figma cloud file session. A transport with no session assertion returns `session_unavailable`.
- `create_branch` returns `unsupported_remote_capability`. Futureox has no cloud branch or merge model; save a copy of the design and open it with `open_document`.
- These names stay on the Figma-shaped entry. The shared `design_*` registry still advertises only `design_*` operations, so a native client never sees a name that always fails.

## Desktop and Dev Mode tools

The eight desktop/Dev Mode names are listed so a Figma client gets a translated result instead of `unknown_tool`. They call the live Design API or return a typed boundary; no name contacts Figma, evaluates plugin code, or stores a design document.

### Motion

`get_motion_context` requires `nodeId` and `fileKey` (the Figma-shaped schema requires both; `fileKey` is accepted and ignored) and accepts optional `recursive`. It reads `animation.list`, `animation.get`, and authored `prototype.get` interactions for the node, or for readable descendants with `recursive: true`. The result is `futureox.figma-motion.v1` with bounded clips, keyframes, prototype interactions, and a derived CSS `@keyframes` snippet. Spring easing has no CSS equivalent and is copied, not converted. This is not Figma timeline playback, Motion (motion.dev) code generation, or a rendered animation. A session without `animation.list`/`animation.get` and `prototype.get` returns `unsupported_remote_capability`.

### Code Connect

`get_code_connect_map`, `get_code_connect_suggestions`, `add_code_connect_map`, and `send_code_connect_mappings` use a bounded process-local Code Connect map keyed by the live `documentId`. This is not the Figma cloud Code Connect service and the map is not durable across MCP processes.

- `add_code_connect_map` requires `nodeId`, `fileKey`, `source`, `componentName`, and `label`; `snippet`, `version`, `mutationId`, and `replace` are optional. `nodeId` must identify a local main component or instance (`not_a_component` otherwise); instances resolve to their main component id. The mapping records the document revision at write time. A second mapping for the same `nodeId` and `label` with a different source returns `mapping_conflict` unless `replace: true`. The design document is not modified.
- `get_code_connect_map` resolves `nodeId`/`nodeIds` or the current selection, follows instances to their main component, and returns stored mappings with `confirmed`, `documentRevision`, and a `stale` flag. When no local mapping exists it returns `unsupported_remote_capability` with `details.mappingCount: 0` instead of an empty or invented map.
- `get_code_connect_suggestions` returns stored unconfirmed mappings as `suggested`, and local components without a mapping as `unmapped` with `source: null`. It does not invent code sources. A request whose nodes contain no component or instance returns `unsupported_remote_capability`.
- `send_code_connect_mappings` confirms stored mappings. Every entry must match a mapping added at the same document revision; otherwise the call returns `not_found`, `mapping_conflict`, or `stale_revision` and confirms nothing. Re-adding at the current revision is the recovery path.
- `mutationId` is idempotent: replaying the same payload returns the earlier result with `replayed: true`; reusing the id with another payload returns `mutation_conflict`.

All four tools accept the common local `sessionId` assertion. Code Connect write tools are listed only in a write-scope catalog.

### FigJam and shaders

`get_figjam`, `get_shader`, and `list_shaders` are discoverable, validate their advertised arguments, and then return `unsupported_remote_capability` with `error.details.capability` and `error.details.docs`. Futureox has no FigJam board model or connectors and no shader library or shader source model. They do not call the Design API and do not modify the document.

## Futureox extension tools

`get_selection` and `open_document` are Futureox extension tools. Neither name is in the Figma tools-and-prompts index or the connected Figma server catalog. They remain listed by default so existing Futureox clients keep working; their descriptions start with `[Futureox extension]` so a strict client can identify them without a hidden catalog change.

Set `FUTUREOX_FIGMA_STRICT_TOOLS=1` (or `true`) to omit exactly those two names from `tools/list`. The switch affects presentation only: `tools/call` still resolves both names, all other tools stay listed, and authentication/authorization is unchanged. The loopback HTTP listener still requires its bearer token; there is no new unauthenticated access path.

## Gaps versus the Figma MCP server

Local semantics (real local capability, not Figma service parity):

- `whoami` returns the local application identity and `local::0`. There is no Figma email, plan, team, seat, OAuth grant, or AI credit.
- `create_new_file` saves a blank local Design file through `workspace.importCopy`. FigJam, Slides, and Make files are unsupported locally.
- `get_comments` reads local document reviews. Remote feedback threads, reactions, mentions, unread state, and image attachments are not available.
- `get_libraries` and `search_design_system` read local collections, variables, main components, and shared styles. Team/Community libraries and cross-file component search do not exist locally.
- `get_context_for_code_connect` returns local component metadata. A Figma cloud Code Connect store does not exist locally; the Code Connect names use the labeled process-local map described above.
- `get_motion_context` reads authored local animation clips, keyframes, and prototype interactions and derives CSS. It is not Figma timeline playback.
- `upload_assets` imports inline SVG and raster assets. There is no upload-URL endpoint; the 8 MiB ordinary MCP request budget bounds each inline asset below the schema's 10 MB allowance. Each imported item is fenced with the revision returned by the previous committed write.

Remote-only capabilities (listed, typed `unsupported_remote_capability` with a capability name and hint):

- `export_video` (no MP4 renderer or job queue)
- `generate_figma_design`, `generate_diagram`, `generate_image`, `generate_vector_illustration`, `html_to_figma`, `send_code_to_figma`
- `list_generative_plugins`, `get_generative_plugin`, `create_generative_plugin`, `update_generative_plugin`
- `list_shaders`, `get_shader`, `list_file_shaders`, `create_shader`, `update_shader`
- `get_figjam` (no FigJam board model)

Still absent:

- Remote `https://mcp.figma.com/mcp`, OAuth, and multi-user accounts

Listed but unsupported (Weave, session, branch):

- `weave_list_tools`, `weave_get_tool_inputs`, `weave_upload_asset`, `weave_run_tool`, `weave_get_tool_run_output`, `weave_cancel_tool_run`, `weave_find_model`, `weave_run_model`, and `weave_get_model_run_output` are visible in `tools/list`; every call returns `unsupported_remote_capability`. This document session exposes no Weave account, credits, recipe catalog, upload store, model catalog, or job queue.
- `weave_request_report` (connected server only) is visible and returns `unsupported_remote_capability`.
- `create_branch` (connected server only) is visible and returns `unsupported_remote_capability`; Futureox has no branch or merge model.
- `get_figjam`, `get_shader`, and `list_shaders` are visible in `tools/list`; every call returns `unsupported_remote_capability` and does not call the Design API.

Partial:

- `create_session` returns the active local automation transport session, which other facade tools accept as `sessionId`. It does not create a Figma cloud session and is not in the public tools-and-prompts index.
- Code Connect tools read and write a bounded process-local map keyed by the live document revision and local component identity. There is no Figma cloud Code Connect store, no team library, and no persistence across MCP processes. The map is not part of the design document and `send_code_connect_mappings` does not modify the document.
- `get_motion_context` reads authored local animation and prototype data and derives CSS. It is not Figma timeline playback, Motion (motion.dev) generation, or rendered output.
- `get_selection` and `open_document` are labeled Futureox extension tools, listed by default; `FUTUREOX_FIGMA_STRICT_TOOLS=1` removes them from `tools/list` only.

- `use_figma` structured edits are real Design API batches. Plugin JavaScript is not run unless a host bridge is registered.
- `download_assets` accepts up to 20 local node IDs in the active page at one editor revision. Download PNG, JPEG, WebP, SVG or bitmap PDF through `resources/read` in the same MCP client session. Render scales range from 0.01× to 4×. A separate `rawImagesOnly: true` call reads up to 20 distinct original embedded PNG, JPEG, GIF or WebP fills from the requested subtrees. Omit format and scale for originals. Truncation and unavailable sources are reported. Original bytes are delivered through the same MCP resource mechanism.
- `get_design_context` is Futureox HTML/CSS, not Figma React + Tailwind.
- `get_screenshot` is a CPU design-content export, not a GPU or window screenshot.
- `fileKey` does not select another file.

The full `design_*` catalog remains available through `frontend/design-mcp/src/cli.mjs` for clients that already speak the Futureox operation names.
