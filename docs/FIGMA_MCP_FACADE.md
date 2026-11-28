# Figma-shaped MCP facade

This is a thin compatibility surface for AI clients that already drive Figma through MCP. It is not a second document model. Every tool calls the existing Design API (`frontend/design-client/src/automation/`). The shared registry still advertises only `design_*` tools. These Figma-shaped names live in `frontend/design-mcp/src/figma-facade.mjs` and are translated back into that API.

The server does not evaluate plugin JavaScript in Node. `use_figma` `code` is forwarded only when the desktop host has registered (`registerFigmaPluginBridge({ run })`) or injected (`startLoopbackFigmaMcp({ pluginBridge })`) a plugin bridge. Without that bridge the tool returns `plugin_host_unavailable` and the source is not read.

Screenshots are `preview.capture`: a CPU raster of design content, not an application window or the GPU canvas. `fileKey` is accepted and ignored. The connection is bound to the document whose local automation bridge is enabled.

`get_design_context` derives a deterministic **local** React JSX + Tailwind approximation from `context.get` plus the local variable/style catalogs. It is not Figma cloud output, does not contact Code Connect, and lists every field without an honest mapping in `unmapped` instead of synthesizing one.

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

The HTTP listener implements Streamable HTTP. Use the URL and bearer token from the active desktop automation grant. Native clients can omit the `Origin` header. When present it must match the listener origin. A successful `initialize` returns a distinct `Mcp-Session-Id`. Send it and the negotiated `MCP-Protocol-Version` on subsequent requests. `POST` accepts one JSON-RPC request or notification and answers with a JSON-RPC object (`application/json`). `GET` with `Accept: text/event-stream` opens one server-notification stream for that session; a second concurrent GET receives `409`. `DELETE` releases the session and ends its stream. The listener holds up to eight clients per grant and retires idle sessions after 30 minutes of inactivity (an open event stream keeps its session alive). Unsupported `MCP-Protocol-Version` values receive `400`. The listener stays loopback-only and still requires the desktop `Authorization: Bearer` grant; it never opens unauthenticated read or write access. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Tool arguments may also assert the active local `sessionId`. Use the current `Mcp-Session-Id` for HTTP, or `FUTUREOX_DESIGN_SESSION` from the packaged Figma stdio config. The assertion is checked before the tool reads the document. Figma cloud session IDs do not select a Futureox document.

## Web editor

The browser page does not listen on a port and cannot host stdio. The in-app Design API buttons (context, check, export) still run inside the page. An external AI client needs the desktop bridge, either the listener the desktop starts or `figma-http.mjs` / `figma-cli.mjs` pointed at that bridge.

## Tools

| Tool | Design API | Notes |
|---|---|---|
| `get_metadata` | `page.list`, `node.find` | Omit `nodeId` to list pages. Pass a local page or node ID for an XML outline and structured nodes. Use `limit` from 1 to 100 and return `nextCursor` as `cursor` with the same `nodeId` to continue. Figma-style ids (`1:23`, URL form `1-23`, instance ids) are accepted. An id that is not a local page or node returns the page list, matching Figma's unknown-id response; no local subtree is invented. |
| `get_selection` | `selection.get`, `node.get` | Active page and selection. At most 20 node summaries. |
| `get_design_context` | `context.get`, `variable.list`, `style.list`, `code.export` | Deterministic local React JSX + Tailwind approximation with node tree, layout, paint/text fields, variables, shared styles, explicit `unmapped` entries, and `cursor`/`limit` pagination. Not Figma output. `clientFrameworks`, `clientLanguages`, `disableCodeConnect`, `excludeScreenshot` and `forceCode` are accepted; no screenshot or Code Connect is embedded. When `code.export` exists its HTML/CSS remains a supplemental resource artifact. |
| `get_screenshot` | `preview.capture` | PNG (or JPEG/WebP) of the node, selection or active page. `maxDimension` fits the rendered size and defaults to 1024 when `scale` is omitted. `contentsOnly: false` includes surrounding page content inside the crop. `enableBase64Response: false` requests a resource link without inline image content. No temporary URL is returned; the result carries a typed URL boundary and real CPU bytes. |
| `get_variable_defs` | `variable.list`, `style.list`, `node.get` | Local variables, their alias dependencies across modes, and shared styles on the specified node or first 20 selected nodes. `nodeId` is optional; without it the result is a bounded document-level catalog. Team libraries return a typed `unsupported_remote_capability` boundary, not an empty catalog. |
| `download_assets` | `preview.capture`, `vector.export`, or `raster.sourceAssets` | Up to 20 local nodes as separate MCP resources. `png`, `jpeg`, `webp`, `svg`, or bitmap `pdf`. Use `rawImagesOnly` for the original embedded image sources. Delivery is explicitly local (`temporaryUrls: false`) with a typed URL boundary; no remote URL is fabricated. |
| `use_figma` | `batch.apply` | Listed when the session can edit. One undo step for 1–40 structured operations. `description` is required. |
| `open_document` | `workspace.open` | Listed when the session can edit and has a workspace write grant. Opens a saved local design and can end the automation session. |
| `weave_list_tools`, `weave_get_tool_inputs`, `weave_run_tool`, `weave_get_tool_run_output`, `weave_cancel_tool_run`, `weave_upload_asset` | none | Listed for Figma clients. Every call returns `unsupported_remote_capability`; this document session exposes no Weave account, credits, hosted recipe catalog, upload ticket, or run queue. |
| `weave_find_model`, `weave_run_model`, `weave_get_model_run_output` | none | Listed for Figma clients. Every call returns `unsupported_remote_capability`; this document session exposes no Weave-compatible model catalog, pricing, or prediction service. |
| `weave_request_report` | none | Connected Figma server only; not in the public tools-and-prompts index. Listed and returns `unsupported_remote_capability`. |
| `create_session` | `document.get` | Returns the active local automation session as `sessionId`, which other facade tools accept. Not a Figma cloud file session. |
| `create_branch` | none | Connected Figma server only; not in the public index. Returns `unsupported_remote_capability`; Futureox has no branch or merge model. |

Metadata cursors bind to the local editor session and document revision. Restart the outline without a cursor after `stale_cursor`. XML nests nodes shown on the current page. Use structured node `parentId` values to join relationships across pages. A Figma-style id that is not a page or node returns the page list in a successful `scope: "pages"` result with `unresolvedNodeId`; an unknown local id remains `not_found` with the page list in `error.details.pages`. A cursor against a node that no longer exists returns `stale_cursor`.

Use the `create_design_system_rules` MCP prompt to draft project guidance from supported local reads. Retrieve the prompt without arguments through `prompts/get`.

`use_figma` operations:

- `create`: `kind`, optional `parentId`, `id`, `index`, `x`, `y`, `width`, `height`, `name`, `text`, `fontSize`, `opacity`, `visible`, `fill` (`#RRGGBB`) or `fills`
- `update`: `nodeId` plus at least one of `name`, `text`, `fontSize`, `opacity`, `visible`, `locked`, `width`, `height`, `x`, `y`, `fill`, `fills`, `transform`
- `delete`: `nodeId` or `nodeIds`
- `select`: `nodeIds` (empty clears the selection), optional `pageId`
- `move`: `nodeId` or `nodeIds`, `parentId`, optional `index`

`x` and `y` are parent-local document units. An update reads the current transform and replaces `tx`/`ty`. Kinds are `slice`, `frame`, `section`, `group`, `rectangle`, `ellipse`, `polygon`, `star`, `line`, `vector`, `text`.

Plugin bridge contract, registered by host code with `registerFigmaPluginBridge({ run })` or injected through `startLoopbackFigmaMcp({ pluginBridge })`:

```js
run({ code, description, documentId, session, revision }, context) => AutomationResponse
```

`description` is limited to 2000 characters and `code` to 50000, matching the Figma write-to-canvas schema. The MCP process never evaluates `code`; it forwards the exact source plus the current document/session/revision fences. A host that runs the existing QuickJS plugin host can register that host behind this contract. The current desktop build does not register a bridge by itself, so the typed `plugin_host_unavailable` result remains until the desktop host supplies one.

## Weave, sessions, and branches

`frontend/design-mcp/src/figma-weave-tools.mjs` registers the connected server's Weave, session, and branch names so `tools/list` answers a Figma client instead of an unknown-tool error. Every call is explicit:

- The nine `weave_*` names and `weave_request_report` return `unsupported_remote_capability` with `error.details.capability` and `error.details.docs`. Weave runs recipes and models on a Figma account with credits; this document session exposes no Weave account, credits, hosted catalog, upload ticket, job queue, or hosted prediction service, and no remote request is made. The desktop Design Assistant is a separate editor feature and is not reachable from this MCP session. Advertised arguments follow the capability summary in [DESIGN_AUTOMATION_PARITY.zh-CN.md](DESIGN_AUTOMATION_PARITY.zh-CN.md) section 3.7 and are not interpreted; the connected server's exact published schemas were not available offline.
- `weave_request_report`, `create_session`, and `create_branch` appear on the connected Figma MCP server but not in the public tools-and-prompts index. They are registered for comparison and labeled here rather than presented as documented public tools.
- `create_session` is the one supported mapping. It returns the active local automation transport session (`Mcp-Session-Id` over HTTP, `FUTUREOX_DESIGN_SESSION` over packaged stdio) with the current `documentId` and `revision`. That value is exactly what other facade tools accept as `sessionId`. It does not create a Figma cloud file session. A transport with no session assertion returns `session_unavailable`.
- `create_branch` returns `unsupported_remote_capability`. Futureox has no cloud branch or merge model; save a copy of the design and open it with `open_document`.
- These names stay on the Figma-shaped entry. The shared `design_*` registry still advertises only `design_*` operations, so a native client never sees a name that always fails.

## Gaps versus the Figma MCP server

Absent:

- `whoami` (no account, plan, or seat)
- `create_new_file` (no cloud file; `open_document` opens a saved local design)
- `generate_figma_design`, `generate_diagram`, `generate_image`, `html_to_figma`
- `upload_assets`, `send_code_to_figma`
- `get_libraries`, `search_design_system`, and Code Connect tools
- `get_figjam`, `get_motion_context`, shader tools, and generative-plugin library tools
- Remote `https://mcp.figma.com/mcp`, OAuth, and multi-user accounts

Listed but unsupported:

- `weave_list_tools`, `weave_get_tool_inputs`, `weave_upload_asset`, `weave_run_tool`, `weave_get_tool_run_output`, `weave_cancel_tool_run`, `weave_find_model`, `weave_run_model`, and `weave_get_model_run_output` are visible in `tools/list`; every call returns `unsupported_remote_capability`. This document session exposes no Weave account, credits, recipe catalog, upload store, model catalog, or job queue.
- `weave_request_report` (connected server only) is visible and returns `unsupported_remote_capability`.
- `create_branch` (connected server only) is visible and returns `unsupported_remote_capability`; Futureox has no branch or merge model.

Partial:

- `create_session` returns the active local automation transport session, which other facade tools accept as `sessionId`. It does not create a Figma cloud session and is not in the public tools-and-prompts index.

- `use_figma` structured edits are real Design API batches. Plugin JavaScript is forwarded only through a host-registered or host-injected plugin bridge; the MCP process never evals it. Description/code limits match the Figma write-to-canvas schema (2000/50000).
- `download_assets` accepts up to 20 local node IDs in the active page at one editor revision. Download PNG, JPEG, WebP, SVG or bitmap PDF through `resources/read` in the same MCP client session. Render scales range from 0.01× to 4×. A separate `rawImagesOnly: true` call reads up to 20 distinct original embedded PNG, JPEG, GIF or WebP fills from the requested subtrees. Omit format and scale for originals. Truncation and unavailable sources are reported. Original bytes are delivered through the same MCP resource mechanism. The result states `delivery: "mcp-resources"`, `temporaryUrls: false`, and a typed `urlExport` boundary; it never invents a remote URL.
- `get_design_context` returns a local React JSX + Tailwind approximation with an explicit `unmapped` list. It is not Figma cloud React/Tailwind, has no Code Connect registry, and does not embed a screenshot.
- `get_screenshot` is a CPU design-content export, not a GPU or window screenshot. It accepts Figma `nodeId`, `format`, `scale`, `contentsOnly`, `enableBase64Response` and `maxDimension` (default 1024) and returns local bytes plus a typed URL boundary.
- `get_variable_defs` treats `nodeId` as optional and reports team libraries as a typed unsupported boundary.
- `fileKey` does not select another file. Figma-style node ids are accepted; an unknown id returns the page list like Figma.
- Streamable HTTP supports `POST`, one `GET` event stream per session, `Mcp-Session-Id`, `MCP-Protocol-Version` and `DELETE`, still behind the loopback bearer grant.

The full `design_*` catalog remains available through `frontend/design-mcp/src/cli.mjs` for clients that already speak the Futureox operation names.
