# Figma-shaped MCP facade

This is a thin compatibility surface for AI clients that already drive Figma through MCP. It is not a second document model. Every tool calls the existing Design API (`frontend/design-client/src/automation/`). The shared registry still advertises only `design_*` tools. These Figma-shaped names live in `frontend/design-mcp/src/figma-facade.mjs` and are translated back into that API.

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

## Web editor

The browser page does not listen on a port and cannot host stdio. The in-app Design API buttons (context, check, export) still run inside the page. An external AI client needs the desktop bridge, either the listener the desktop starts or `figma-http.mjs` / `figma-cli.mjs` pointed at that bridge.

## Tools

| Tool | Design API | Notes |
|---|---|---|
| `get_metadata` | `page.list`, `node.find` | No `nodeId`: pages. A page id outlines that page. Any other id outlines that subtree, at most 100 nodes. Text content is XML. |
| `get_selection` | `selection.get`, `node.get` | Active page and selection. At most 20 node summaries. |
| `get_design_context` | `context.get`, `code.export` | Futureox HTML/CSS when `code.export` is available. Not Figma React + Tailwind. `clientFrameworks` is ignored. |
| `get_screenshot` | `preview.capture` | PNG. Omitted `nodeId` uses the selection, or the active page when the selection is empty. `scale` is 0.1–4. |
| `get_variable_defs` | `variable.list`, `style.list`, `node.get` | Variables and styles used by the selection. An empty selection returns local document variables and styles. No team libraries. |
| `download_assets` | `preview.capture` or `vector.export` | Up to 20 local nodes as separate MCP resources. `png`, `jpeg`, `webp`, or `svg`. |
| `use_figma` | `batch.apply` | Listed when the session can edit. One undo step for 1–40 structured operations. `description` is required. |
| `open_document` | `workspace.open` | Listed when the session can edit and has a workspace write grant. Opens a saved local design and can end the automation session. |

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

## Gaps versus the Figma MCP server

Absent:

- `whoami` (no account, plan, or seat)
- `create_new_file` (no cloud file; `open_document` opens a saved local design)
- `generate_figma_design`, `generate_diagram`, `generate_image`, `html_to_figma`
- `upload_assets`, `send_code_to_figma`
- `get_libraries`, `search_design_system`, and Code Connect tools
- `get_figjam`, `get_motion_context`, shader tools, and generative-plugin library tools
- Remote `https://mcp.figma.com/mcp`, OAuth, and multi-user accounts

Partial:

- `use_figma` structured edits are real Design API batches. Plugin JavaScript is not run unless a host bridge is registered.
- `download_assets` accepts up to 20 local node IDs. Every node in a batch uses the same editor revision, and the batch succeeds only when all resources fit the existing byte budget. Download the results through `resources/read` in the same MCP client session. PDF, original uploaded images and external temporary URLs are unavailable.
- `get_design_context` is Futureox HTML/CSS, not Figma React + Tailwind.
- `get_screenshot` is a CPU design-content export, not a GPU or window screenshot.
- `fileKey` does not select another file.

The full `design_*` catalog remains available through `frontend/design-mcp/src/cli.mjs` for clients that already speak the Futureox operation names.
