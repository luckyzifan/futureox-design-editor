# Figma plugin host

Futureox Design can run a documented subset of the Figma Plugin API against the open document. This is a local desktop host. It does not add Figma aliases to the MCP operation registry, install handlers from file contents, or grant network, filesystem, or account permissions.

The Plugins panel runs the QuickJS rich host. Its matrix is `frontend/design-client/src/plugins/rich-host/coverage.ts` (`PLUGIN_API_COVERAGE`) and [FIGMA_PLUGIN_HOST_V1.md](FIGMA_PLUGIN_HOST_V1.md). The panel summary counts that list. Calling an unsupported API there throws `PluginApiError` with `code: "unsupported_api"`.

This file's table is the snapshot worker in `frontend/design-client/src/plugins/coverage.ts`. Counts in this build: 49 supported, 38 partial, 13 unsupported. Calling an unsupported API throws `PluginApiError` with `code: "unsupported"`. Partial APIs do the documented subset and throw when a plugin asks for the rest. A thrown read or write leaves the previous paints on the node.

## What a plugin can change

Plugin main code runs in a worker. It receives a snapshot and returns a validated change list. The editor applies that list with `Editor.change`, so one plugin turn is one undo step. The worker cannot see the editor, Electron, or Node. The desktop plugin window is a separate sandboxed renderer: no Node, no new windows, and network requests are cancelled.

This is not a security guarantee against a hostile plugin stalling its worker or reaching a same-origin worker global that the host could not replace. Load plugins you trust. Manifest `networkAccess`, `permissions`, and `documentAccess` are ignored.

Each main-script completion and each UI message is its own turn. If the document changes while a turn is running, the commit is dropped. Auto-layout results computed after a commit are not copied back into the plugin sandbox.

Sticky notes, the blue accent, and the render and navigation paths are not part of this host.

## Load the sample

Sample folders:

`frontend/design-client/plugins/labeled-rectangles`

`frontend/design-client/plugins/layout-kit`

`layout-kit` is a local fixture, not a downloaded marketplace plugin. It stores a run count in `figma.clientStorage`, builds a vertical auto-layout frame, creates a local component and instance, ungroups a pair of shapes, and paints a 1×1 PNG through `figma.createImage`. Zip that folder (the archive must contain one `manifest.json`) to try the archive button. No marketplace plugin has been downloaded or run here.

It contains `manifest.json`, `code.js`, and `ui.html`. On launch (`figma.command === "run"`) it creates three rectangles named Label, each with a text node, on the current page.

Desktop:

1. Open a design. Plugins are for the normal editor document, not a large-source workspace or a native Sketch session.
2. Choose **Plugins → Open plugin host…** or **插件** in the file menu.
3. Click **Run sample plugin** / **运行示例插件**. The three labels appear on the canvas. Undo removes that turn.
4. On the desktop app, the sample UI opens in its own window. Enter a label and count, then Create. Close stops the session.
5. To load this folder, or another plugin, click **Load plugin folder…** and choose the folder that contains `manifest.json`. The host reads only `manifest.json` plus the manifest `main` and optional `ui` files, each up to 1 MiB, and only from inside that folder.
6. Click **Load plugin archive…** and choose a `.zip` or `.figma` archive with exactly one `manifest.json`. The same size limits apply. The archive is unpacked in the renderer. It is not scanned at startup and it is not executed until you pick it. `layout-kit` and `component-kit` are local fixtures. A marketplace download was not fetched in CI.

## Local plugins at startup

The Electron app scans the `plugins` directory inside its user-data profile once, before the first window opens. Each immediate child directory that declares a valid `manifest.json` is enabled. A declaration is valid when `editorType` includes `figma` (or is omitted), and the declared `main` and optional `ui` files stay inside that directory within the existing size limits. The first folder name in English sort order wins when two folders use the same plugin id. At most 64 visible real child directories are considered, and at most 32 plugins are enabled.

Enabled plugins appear in the **Plugins** menu and in the plugin host. Choosing one runs it through the same worker and `Editor.change` path as a folder picked by hand. The scan reads the manifest and the declared files. It does not execute plugin code and does not change the open document. Restart the app after adding or removing a plugin folder.

Hidden directories, directory symlinks, FigJam-only manifests, and files that resolve outside the plugin folder are not enabled. The renderer receives the manifest text and a session grant. It does not receive the filesystem path. An additional local window uses its own profile, so it scans that profile’s `plugins` directory.

The web build can run the sample main script. The UI window and the startup scan exist only in the Electron app.

A plugin folder uses the Figma manifest shape:

```json
{
  "name": "Labeled rectangles",
  "id": "futureox.sample.labeled-rectangles",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"]
}
```

`editorType` must include `figma`. FigJam-only manifests are refused. The host always runs command `run`; it does not list manifest menus.

UI code talks to the plugin with `parent.postMessage({ pluginMessage }, '*')` and reads `event.data.pluginMessage`. Messages must be JSON, up to 64 KiB.

## API coverage

The table below is the earlier worker subset. The Plugins panel list is the rich host and already includes local `clientStorage`, `createComponent` / `createInstance`, `createImage`, `ungroup`, and the auto-layout fields the layout-kit fixture uses. PNG `exportAsync`, remote components, and reactions stay unsupported there.

| API | Status | Behavior |
| --- | --- | --- |
| `figma.createRectangle` | supported | Appends a 100×100 rectangle to the current page. |
| `figma.createEllipse` | supported | Appends a 100×100 ellipse to the current page. |
| `figma.createFrame` | supported | Appends a clipping frame. Children use parent-local coordinates. |
| `figma.createText` | supported | Creates empty text. Writes require loadFontAsync; glyphs use the document default font. |
| `figma.createLine` | supported | Creates a 100×0.01 line. Zero width or height is rejected. |
| `figma.createPolygon` | supported | Creates a polygon. pointCount is the authored point count. |
| `figma.createStar` | supported | Creates a star. innerRadius uses the 0.01–1 authored range. |
| `figma.createSection` | supported | Appends a section container. |
| `figma.createPage` | supported | Adds a page and does not switch to it. |
| `figma.group` | partial | Groups nodes that already share the given parent. Bounds ignore rotation. |
| `figma.currentPage` | supported | Read and assign the open page. Assignment clears the plugin selection. |
| `figma.currentPage.selection` | supported | Nodes on the current page only. |
| `figma.currentPage.findAll` | supported | Walks the page subtree. An omitted callback returns every node. |
| `figma.currentPage.findOne` | supported | Returns the first match or null. |
| `figma.getNodeById` | supported | Returns a page, scene node, or the document root. Missing ids return null. |
| `figma.notify` | supported | Shows the editor status line. Options such as timeout are ignored. |
| `figma.closePlugin` | supported | Ends the turn. One editor undo step covers that turn’s document edits. |
| `figma.showUI` | supported | Desktop opens a sandboxed window. Inline HTML is capped at 200000 characters. |
| `figma.ui.postMessage` | supported | JSON values up to 64 KiB. The desktop UI window receives pluginMessage. |
| `figma.ui.onmessage` | supported | Receives the pluginMessage value. figma.ui.on("message") assigns the same handler. |
| `figma.loadFontAsync` | partial | Snapshot worker: resolves document families only and embeds nothing. The rich QuickJS host loads desktop system-catalog families through `font.import` admission. |
| `figma.util.rgb` | supported | Returns {r,g,b}. Other figma.util helpers throw. |
| `node.id` | supported | Stable document id. |
| `node.type` | supported | Figma-style names such as RECTANGLE, TEXT, FRAME, PAGE, and DOCUMENT. |
| `node.name` | supported | String up to 200 characters. |
| `node.x` | supported | Parent-local translation. Reparenting does not preserve world position. |
| `node.y` | supported | Parent-local translation. |
| `node.width` | supported | Minimum 0.01, maximum 1e7. |
| `node.height` | supported | Minimum 0.01, maximum 1e7. |
| `node.resize` | supported | Sets width and height together. |
| `node.opacity` | supported | 0–1. |
| `node.visible` | supported | Boolean. |
| `node.locked` | supported | Boolean. Plugin remove() can delete a locked node; the canvas Delete key still skips locks. |
| `node.parent` | supported | Page, container, document root, or null. |
| `node.children` | supported | A snapshot array. Only frames, sections, groups, and pages accept children. |
| `node.appendChild` | supported | Moves the node. Coordinates stay parent-local. |
| `node.insertChild` | supported | Index is the final index after the node leaves its old parent. |
| `node.remove` | supported | Deletes the subtree. |
| `node.clone` | supported | Deep-clones ordinary geometry. Components and boolean nodes throw. |
| `node.fills` | partial | SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND, and IMAGE. Any other paint throws on read and on write, and the node is left unchanged. Gradient handles are an angle plus stops, not full gradientTransform fidelity. |
| `node.strokes` | partial | Same paint types as fills. A gradient or image stroke is not reported as SOLID. Assigning replaces the stack only when every paint is supported. |
| `node.strokeWeight` | supported | One width for every stroke. A positive weight creates a stroke when none exist. |
| `node.cornerRadius` | supported | Rectangles, frames, and sections use the four radii. Polygons and stars use the authored corner radius. Mixed radii read as figma.mixed. |
| `node.topLeftRadius` | supported | Rectangle, frame, and section top-left radius. Other nodes throw. |
| `node.topRightRadius` | supported | Rectangle, frame, and section top-right radius. Other nodes throw. |
| `node.bottomRightRadius` | supported | Rectangle, frame, and section bottom-right radius. Other nodes throw. |
| `node.bottomLeftRadius` | supported | Rectangle, frame, and section bottom-left radius. Other nodes throw. |
| `node.cornerSmoothing` | supported | Rectangle, frame, and section corner smoothing from 0 to 1. |
| `node.characters` | supported | Text only, after loadFontAsync for the node’s fontName. Clears style ranges. |
| `node.fontSize` | supported | 1–4096, after loadFontAsync. Does not change per-range fonts. |
| `node.getPluginData` | supported | String values stored on the node for this plugin id. Missing keys return an empty string. |
| `node.setPluginData` | supported | Up to 50 keys and 10000 characters per value. This is document data, not clientStorage. |
| `node.rotation` | partial | Clockwise degrees around the node origin, not the visual center. Range -180 to 180. |
| `node.relativeTransform` | partial | 2×3 matrix [[a, c, tx], [b, d, ty]]. Singular matrices are rejected. |
| `node.layoutMode` | partial | NONE, HORIZONTAL, and VERTICAL on frames, sections, and groups. GRID cannot be read. New layout uses Futureox defaults (gap 12, padding 16). |
| `node.itemSpacing` | partial | Maps to layout gap after layoutMode is set. Grid layout throws. |
| `node.paddingTop` | partial | Authored padding after layoutMode is set. |
| `node.paddingRight` | partial | Authored padding after layoutMode is set. |
| `node.paddingBottom` | partial | Authored padding after layoutMode is set. |
| `node.paddingLeft` | partial | Authored padding after layoutMode is set. |
| `node.effects` | partial | DROP_SHADOW and LAYER_BLUR or FOREGROUND_BLUR only. Other effects throw on read and stay unchanged. |
| `node.fontName` | partial | Stored for the plugin session. Rendering keeps the document default font. |
| `node.pointCount` | partial | Polygon and star only, integers 3–128. |
| `node.innerRadius` | partial | Star only, 0.01–1. |
| `figma.viewport.center` | partial | Read-only world point under the viewport’s top-left. The host does not know the canvas size, so this is not the visual center. |
| `figma.viewport.zoom` | partial | Read-only camera zoom. Assigning zoom throws. |
| `figma.viewport.scrollAndZoomIntoView` | partial | Asks the editor to reveal the nodes. It does not change zoom. |
| `figma.fileKey` | partial | Always null. Local documents have no Figma file key. |
| `figma.on` | partial | selectionchange and currentpagechange are accepted and not delivered. close runs inside closePlugin. |
| `figma.editorType` | partial | Always "figma". FigJam-only manifests are refused. |
| `figma.mode` | partial | Always "default". |
| `figma.pluginId` | partial | The manifest id. It is not a published Figma plugin id. |
| `figma.command` | partial | The host always passes "run". Manifest menu commands are not listed. |
| `figma.mixed` | partial | Returned when corner radii or stroke weights differ. It is not the full Figma mixed sentinel. |
| `figma.root` | partial | Read-only document name and page children. |
| `figma.variables` | unsupported | No variable, mode, or alias API. |
| `figma.teamLibrary` | unsupported | No team library or published styles. |
| `figma.clientStorage` | supported | getAsync, setAsync, deleteAsync, and keysAsync. JSON values, undefined, and Uint8Array. Stored for this plugin id outside the document, and not undone with the canvas. The QuickJS panel stores it in localStorage. This snapshot host keeps it in process memory for the plugin id. |
| `figma.payments` | unsupported | No payments. |
| `figma.parameters` | unsupported | No parameter UI. |
| `figma.codegen` | unsupported | No codegen. |
| `figma.currentUser` | unsupported | No Figma account. |
| `figma.createComponent` | partial | Creates a local main component from an empty frame. No variants, component properties, or team library. |
| `figma.createInstance` | partial | ComponentNode.createInstance and figma.createInstance copy a local component onto the page. No team library and no remote key. A name set in the same turn can be normalized to the main component name when the editor admits the instance. |
| `figma.importComponentByKeyAsync` | unsupported | No remote components. |
| `figma.createImage` | partial | PNG, JPEG, or WebP bytes up to 256 KiB. The hash is the SHA-1 of those bytes. The paint stores a data URL. GIF bytes are refused because the document does not admit a GIF data URL. |
| `figma.getImageByHash` | partial | Resolves a hash created in this session or already stored on a PNG, JPEG, or WebP fill or stroke. getBytesAsync returns those bytes. getSizeAsync reads PNG and JPEG headers. |
| `figma.createNodeFromSvg` | unsupported | Use the editor’s SVG import, not the plugin API. |
| `node.exportAsync` | partial | SVG markup bytes for the node box, a solid fill, and text. PNG, JPG, and PDF throw. This is not the editor export panel. |
| `node.vectorNetwork` | unsupported | Vector networks stay as authored geometry and cannot be edited here. |
| `node.reactions` | unsupported | No prototype reactions. |
| `figma.annotations` | unsupported | No annotations API. |
| `node.layoutSizingHorizontal` | partial | FIXED, HUG, or FILL on sizing.width. Hug still has to satisfy the editor layout rule. |
| `node.layoutSizingVertical` | partial | FIXED, HUG, or FILL on sizing.height. |
| `node.primaryAxisAlignItems` | partial | MIN, CENTER, MAX, or SPACE_BETWEEN after layoutMode. BASELINE throws. |
| `node.counterAxisAlignItems` | partial | MIN, CENTER, or MAX after layoutMode. BASELINE throws. |
| `node.layoutAlign` | partial | MIN, CENTER, MAX, STRETCH, or INHERIT. Writes sizing.alignSelf. |
| `figma.ui.resize` | unsupported | Pass width and height to showUI. The window does not resize later. |
| `figma.ungroup` | partial | Lifts children of a group, frame, or section that is not auto-layout, a component, or a boolean. Child transforms stay parent-local. |
| `networkAccess` | unsupported | Manifest network access is ignored. The UI window cancels network requests. |

## Limits

- Plugin main source: 1 MiB. UI HTML: 200000 characters. Manifest: 64 KiB.
- At most 2000 nodes created per session, including clones.
- Document snapshots larger than 32 MB are refused.
- A turn that runs longer than 15 seconds is stopped and not committed.
- Text writes require `figma.loadFontAsync` first. The promise resolves, and the glyphs still use the document default font.
- Geometry is parent-local. `rotation` turns around the node origin, not the visual center.
- Supported paints round-trip. An unsupported paint throws, and the previous fills or strokes stay on the node.
- `figma.variables`, `figma.teamLibrary`, `figma.payments`, `figma.currentUser`, and manifest `networkAccess` stay unsupported on this snapshot host. The UI window still cancels network requests. There is no collaboration server.
