# Figma-shaped MCP facade

This is a thin compatibility surface for AI clients that already drive Figma through MCP. It is not a second document model. Every tool calls the existing Design API (`frontend/design-client/src/automation/`). The shared registry still advertises only `design_*` tools. These Figma-shaped names live in `frontend/design-mcp/src/figma-facade.mjs` and are translated back into that API.

The server does not evaluate plugin JavaScript. `use_figma` `code` is forwarded only when the desktop host has registered a plugin bridge. Without that bridge the tool returns `unsupported_remote_capability`.

Screenshots are `preview.capture`: a CPU raster of design content, not an application window or the GPU canvas. `fileKey` is accepted and ignored. The connection is bound to the document whose local automation bridge is enabled.

The catalog is Figma-shaped, not a claim of Figma parity. Desktop Code Connect, FigJam, shader, and the remote-only tools have no local implementation and stay visible with an explicit typed error instead of becoming unknown tools. `get_selection` and `open_document` are Futureox extensions and are hidden by default; enable `FUTUREOX_FIGMA_EXTENSIONS=1` (or `--extensions` for the stdio/HTTP launchers) to advertise them. Figma cloud node ids (`1:2`) return `unsupported_figma_node_id`; `get_metadata` returns the page list for them, matching Figma's unknown-id behavior.

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

The HTTP listener implements Streamable HTTP with JSON responses, MCP sessions, and `DELETE` session release. Streamable HTTP permits either a JSON response or an SSE stream for POST; this listener chooses JSON and does not implement the optional GET event stream. Use the URL and bearer token from the active desktop automation grant. Native clients can omit the `Origin` header. When present it must match the listener origin. A successful `initialize` returns a distinct `Mcp-Session-Id`. Send it and the negotiated `MCP-Protocol-Version` on subsequent requests. The listener holds up to eight clients per grant and retires idle sessions after 30 minutes of inactivity. The listener returns `405` for a GET event stream and `400` for an unsupported protocol version. [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

For a client configured exactly like Figma Desktop (`http://127.0.0.1:3845/mcp`, no `Authorization` header), start the standalone launcher with `--figma-compatible`:

```sh
node /absolute/path/frontend/design-mcp/src/figma-http.mjs --figma-compatible
```

That mode binds loopback only, defaults to port 3845 (falling back to an ephemeral port with a printed warning when 3845 is busy), and accepts loopback requests without a bearer token. A supplied but wrong bearer is still rejected. The bridge token is still used internally to reach the desktop socket and is never printed. The desktop host uses the same mode when launched with `FUTUREOX_FIGMA_COMPATIBLE=1`. The default listener keeps requiring `Authorization: Bearer <token>`; `--port N` selects a fixed port without changing authentication.

Tool arguments may include `sessionId`. A matching Futureox transport session is asserted; another active local transport session is rejected; a UUID-shaped Figma cloud `sessionId` (from `create_session`) is ignored, because it cannot select a Futureox document. `fileKey` is always ignored.

## Web editor

The browser page does not listen on a port and cannot host stdio. The in-app Design API buttons (context, check, export) still run inside the page. An external AI client needs the desktop bridge, either the listener the desktop starts or `figma-http.mjs` / `figma-cli.mjs` pointed at that bridge.

## Tools

| Tool | Design API | Notes |
|---|---|---|
| `get_metadata` | `page.list`, `node.find` | Omit `nodeId` to list pages. Pass a local page or node ID for an XML outline and structured nodes. A Figma cloud id (`1:2`) returns the page list. Use `limit` from 1 to 100 and return `nextCursor` as `cursor` with the same `nodeId` to continue. |
| `get_selection` | `selection.get`, `node.get` | Futureox extension, hidden by default. Enable with `FUTUREOX_FIGMA_EXTENSIONS=1` or `--extensions`. Active page and selection, at most 20 node summaries. |
| `get_design_context` | `context.get`, `code.export` | Futureox HTML/CSS when `code.export` is available. Not Figma React + Tailwind. `clientFrameworks` and `disableCodeConnect` are ignored, `excludeScreenshot` is accepted because screenshots stay in `get_screenshot`, and `forceCode` is the local default when code export exists. |
| `get_screenshot` | `preview.capture` | CPU PNG of the node, selection or active page. `maxDimension` limits the rendered size. `contentsOnly: false` includes surrounding page content inside the crop. `enableBase64Response: false` requests a resource link without inline image content. The result carries rendered `width`/`height`, `naturalWidth`/`naturalHeight`, `delivery: "mcp-image-or-resource"`, and no temporary URL. |
| `get_variable_defs` | `variable.list`, `style.list`, `node.get` | Local variables, alias dependencies across modes, and shared styles on the specified node or first 20 selected nodes. An empty selection returns a bounded document catalog. `libraries` is always empty and `librarySupport` is false: no team libraries. |
| `download_assets` | `preview.capture`, `vector.export`, or `raster.sourceAssets` | Up to 20 local nodes as separate MCP resources. `png`, `jpeg`, `webp`, `svg`, or bitmap `pdf`. Use `rawImagesOnly` for original embedded image sources. Delivery is `mcp-resources`; temporary Figma URLs are not available. |
| `use_figma` | `batch.apply` | Listed when the session can edit. One undo step for 1–40 structured operations. `description` is required (max 2000). `code` is Figma Plugin API JavaScript (max 50000) and returns `unsupported_remote_capability` unless a host plugin bridge is registered. |
| `open_document` | `workspace.open` | Futureox extension, hidden by default. Listed when extensions are enabled and the session can edit with a workspace write grant. Opens a saved local design and can end the automation session. Not Figma `create_new_file`. |
| `get_motion_context` | `animation.list`, `animation.get`, `node.get`, `node.find` | Reads authored local animation clips and keyframes for `nodeId` (optionally `recursive`) and returns a derived CSS `@keyframes` snippet. Not Figma timeline playback or motion.dev generation. |
| `get_code_connect_map` | none | Visible, returns `unsupported_remote_capability`: no Code Connect store. |
| `get_code_connect_suggestions` | none | Visible, returns `unsupported_remote_capability`: no suggestion engine. |
| `add_code_connect_map` | none | Write tool in edit scope, returns `unsupported_remote_capability`: no Code Connect store. |
| `send_code_connect_mappings` | none | Write tool in edit scope, returns `unsupported_remote_capability`: no Code Connect store. |
| `get_figjam` | none | Visible, returns `unsupported_remote_capability`: no FigJam model or connectors. Use `get_metadata` for a local outline. |
| `get_shader` | none | Visible, returns `unsupported_remote_capability`: no Figma shader library or source model. |
| `list_shaders` | none | Visible, returns `unsupported_remote_capability`: no Figma shader library. |

Tools without a local implementation stay in `tools/list` so a Figma client receives a typed result instead of an unknown-tool error. `unsupported_remote_capability` means the capability belongs to Figma's hosted service, plugin runtime, or Figma-specific data model; the call did not reach the Design API and did not modify the document.

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

The MCP process does not eval `code`. The current desktop build does not register a bridge; the plugin host is a separate change. Without a bridge, `code` returns `unsupported_remote_capability` before any document read.

## Gaps versus the Figma MCP server

Absent:

- `whoami` (no account, plan, or seat)
- `create_new_file` (no cloud file; `open_document` opens a saved local design when extensions are enabled)
- `generate_figma_design`, `generate_diagram`, `generate_image`, `html_to_figma`
- `upload_assets`, `send_code_to_figma`
- `get_libraries` and `search_design_system` (no team libraries or published design systems)
- Generative-plugin library tools
- Remote `https://mcp.figma.com/mcp`, OAuth, and multi-user accounts

Visible with `unsupported_remote_capability`:

- Code Connect: `get_code_connect_map`, `get_code_connect_suggestions`, `add_code_connect_map`, `send_code_connect_mappings`
- FigJam: `get_figjam`
- Shader library: `get_shader`, `list_shaders`

Partial:

- `use_figma` structured edits are real Design API batches. Plugin JavaScript is not run unless a host bridge is registered; otherwise `code` returns `unsupported_remote_capability` and is not evaluated. `description` and `code` use the connected Figma length limits (2000 / 50000).
- `get_motion_context` reads authored local animation clips, keyframes, and a derived CSS snippet. It is not Figma timeline playback or motion.dev code generation.
- `download_assets` accepts up to 20 local node IDs in the active page at one editor revision. Download PNG, JPEG, WebP, SVG or bitmap PDF through `resources/read` in the same MCP client session. Render scales range from 0.01× to 4×. A separate `rawImagesOnly: true` call reads up to 20 distinct original embedded PNG, JPEG, GIF or WebP fills from the requested subtrees. Omit format and scale for originals. Truncation and unavailable sources are reported. Delivery is MCP resources, not temporary Figma URLs.
- `get_design_context` is Futureox HTML/CSS, not Figma React + Tailwind. It accepts `disableCodeConnect`, `excludeScreenshot`, and `forceCode`; none of them adds a Code Connect mapping or an embedded screenshot.
- `get_screenshot` is a CPU design-content export, not a GPU or window screenshot, and it returns MCP image content or a resource instead of a temporary URL. Rendered and natural dimensions are both reported.
- `get_variable_defs` returns local variables and styles only. `libraries` is always empty.
- `fileKey` does not select another file. Figma cloud node ids return `unsupported_figma_node_id`; `get_metadata` returns the page list instead, like Figma's unknown-id response.
- `get_selection` and `open_document` are Futureox extensions, not Figma tool names. They are hidden by default and enabled with `FUTUREOX_FIGMA_EXTENSIONS=1` or `--extensions`.
- The default HTTP listener requires a bearer token and uses an ephemeral port. `--figma-compatible` opts into the published Figma desktop shape (port 3845, no bearer header), still loopback-only and Origin-checked. It is not Figma's OAuth remote server.

The full `design_*` catalog remains available through `frontend/design-mcp/src/cli.mjs` for clients that already speak the Futureox operation names.
