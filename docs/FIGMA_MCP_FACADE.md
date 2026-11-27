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
| `get_selection` | `selection.get`, `node.get` | Active page and selection. At most 20 node summaries. |
| `get_design_context` | `context.get`, `code.export` | Futureox HTML/CSS when `code.export` is available. Not Figma React + Tailwind. `clientFrameworks` is ignored. |
| `get_screenshot` | `preview.capture` | PNG of the node, selection or active page. `maxDimension` limits the rendered size. `contentsOnly: false` includes surrounding page content inside the crop. `enableBase64Response: false` requests a resource link without inline image content. |
| `get_variable_defs` | `variable.list`, `style.list`, `node.get` | Local variables, their alias dependencies across modes, and shared styles on the specified node or first 20 selected nodes. An empty selection returns a bounded document catalog. |
| `download_assets` | `preview.capture`, `vector.export`, or `raster.sourceAssets` | Up to 20 local nodes as separate MCP resources. `png`, `jpeg`, `webp`, `svg`, or bitmap `pdf`. Use `rawImagesOnly` for the original embedded image sources. |
| `use_figma` | `batch.apply` | Listed when the session can edit. One undo step for 1–40 structured operations. `description` is required. |
| `open_document` | `workspace.open` | Listed when the session can edit and has a workspace write grant. Opens a saved local design and can end the automation session. |

### Local catalog additions

These names keep the public Figma input schema. Write tools are listed when the session can edit; every handler rechecks scope. A read-only session lists only the read entries, matching the core facade’s existing filtering.

| Tool | Design API | Local behavior |
|---|---|---|
| `whoami` | `document.get` (optional) | Local application identity: handle `futureox-local`, `email: null`, one plan `local::0`, seat `owner`, and the bound document. It is not a Figma account or OAuth grant. |
| `create_new_file` | `workspace.importCopy` | Saves a blank local Design document and returns `documentHandle`; it does not switch the editor. Only `editorType: design` exists locally; `figjam`, `slides`, and `figmake` return `unsupported_editor_type`. `planKey` and `projectId` are accepted for schema compatibility. `rootHandle` is the local workspace grant; `mutationId` is generated when omitted. Open the result with `open_document`. |
| `get_comments` | `review.list` | Reads local document reviews as threads with replies, positions, kind, and resolved state. `pageId`, `nodeId`, `resolved`, `threadId`, `offset`, and `limit` (1–100) work. Replies are bounded to 20 per thread and each text to 2,000 characters, with truncation flags. `author`, `mentionedUser`, `unread`, and `threadStarterOnly` return `unsupported_filter`; there are no Figma reactions, mentions, unread state, or image attachments. |
| `get_libraries` | `document.get`, `collection.list`, `variable.list`, `style.list` | Returns the single `local-document` library with its collections, variable count, and style count. `offset` paginates the one-entry library list. Team, organization, Community, and cross-file libraries do not exist locally. |
| `search_design_system` | `document.get`, `variable.list`, `style.list` | Answers `queries` in order for `entity: variable` or `entity: style` by case-insensitive name match, at most 20 matches per query. `entity: component` returns `status: unsupported` with no fabricated matches. `includeLibraryKeys` adds `libraryKey: local-document`; `disableCodeConnect` has no effect. |
| `get_context_for_code_connect` | `node.get`, `node.find` | Returns local component metadata: variants, component properties, slots, component-set identity, instance link, and up to 100 descendant summaries. `codeConnect.available` is false; no template or mapping is generated. |
| `upload_assets` | `svg.import`, `node.create` | Imports up to 60 inline assets of at most 10 MB each. SVG `content` becomes editable vector layers. PNG, JPEG, GIF, or WebP `dataUrl` becomes a rectangle with the exact embedded image fill. `nodeId`/`nodeIds` select a parent container, not an existing fill. `scaleMode` and `batchCommit` are accepted and ignored. A call without `assets` returns `inline_assets_required`; no upload URL is fabricated. |

`upload_assets` has no upload-URL phase. The ordinary MCP request budget is 8 MiB, so an inline asset that exceeds that budget cannot reach this tool in one request even though the schema accepts up to 10 MB per asset.

### Listed remote-only tools

These names are visible in `tools/list` with their documented input schemas. Every call validates arguments first and then returns `unsupported_remote_capability`; no remote job, file, layer, credit charge, or resource URI is fabricated.

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

## Gaps versus the Figma MCP server

Local semantics (real local capability, not Figma service parity):

- `whoami` returns the local application identity and `local::0`. There is no Figma email, plan, team, seat, OAuth grant, or AI credit.
- `create_new_file` saves a blank local Design file through `workspace.importCopy`. FigJam, Slides, and Make files are unsupported locally.
- `get_comments` reads local document reviews. Remote feedback threads, reactions, mentions, unread state, and image attachments are not available.
- `get_libraries` and `search_design_system` read local collections, variables, and shared styles. Team/Community libraries and cross-file component search do not exist locally.
- `get_context_for_code_connect` returns local component metadata. Code Connect templates and mappings are not stored.
- `upload_assets` imports inline SVG and raster assets. There is no upload-URL endpoint; the 8 MiB ordinary MCP request budget bounds each inline asset below the schema's 10 MB allowance.

Remote-only capabilities (listed, typed `unsupported_remote_capability`):

- `export_video` (no MP4 renderer or job queue)
- `generate_figma_design`, `generate_diagram`, `generate_image`, `generate_vector_illustration`, `html_to_figma`, `send_code_to_figma`
- `list_generative_plugins`, `get_generative_plugin`, `create_generative_plugin`, `update_generative_plugin`
- `list_shaders`, `get_shader`, `list_file_shaders`, `create_shader`, `update_shader`

Still absent:

- `get_figjam`, `get_motion_context`
- `get_code_connect_map`, `add_code_connect_map`, `get_code_connect_suggestions`, `send_code_connect_mappings`, `list_file_components_for_code_connect`
- Remote `https://mcp.figma.com/mcp`, OAuth, and multi-user accounts

Partial:

- `use_figma` structured edits are real Design API batches. Plugin JavaScript is not run unless a host bridge is registered.
- `download_assets` accepts up to 20 local node IDs in the active page at one editor revision. Download PNG, JPEG, WebP, SVG or bitmap PDF through `resources/read` in the same MCP client session. Render scales range from 0.01× to 4×. A separate `rawImagesOnly: true` call reads up to 20 distinct original embedded PNG, JPEG, GIF or WebP fills from the requested subtrees. Omit format and scale for originals. Truncation and unavailable sources are reported. Original bytes are delivered through the same MCP resource mechanism.
- `get_design_context` is Futureox HTML/CSS, not Figma React + Tailwind.
- `get_screenshot` is a CPU design-content export, not a GPU or window screenshot.
- `fileKey` does not select another file.

The full `design_*` catalog remains available through `frontend/design-mcp/src/cli.mjs` for clients that already speak the Futureox operation names.
