# Futureox Design Figma plugin host (v1)

This host runs a documented subset of the Figma Plugin API against the open Futureox document. It is a local editor feature. It is not Figma, not a Figma account, and not an MCP `use_figma` eval tool.

## Run the sample

1. Open a design in Futureox Design.
2. Choose **插件** / **Plugins** in the header.
3. Choose **运行示例** / **Run sample**.

The sample is `frontend/design-client/src/plugins/sample/` (`manifest.json` + `code.js`). It creates a 320×140 frame named “Plugin sample”, fills it with `#3459d4`, and adds a white text layer “Futureox”. One or more undo steps labeled `Plugin: Labeled frame` remove it.

## Load a plugin folder or archive

Choose **载入插件文件夹** / **Load plugin folder** and pick a directory that contains a Figma-style `manifest.json` and the `main` script it names. Or choose **载入 .zip / .figma** / **Load .zip / .figma** in the Plugins panel. A `.figma` plugin file is a zip. The same archive loader is covered by `pluginBundleFromZip`. The archive may nest the plugin in one folder. The loader reads `manifest.json`, the manifest `main` script, and the optional `ui` file. Other files are ignored. Paths that leave the folder are rejected.

If the manifest has a `menu`, the panel lists those commands and runs the one you pick. `figma.command` is that command, or `undefined` when there is no menu.

`frontend/design-client/src/plugins/sample-ui/` is a small UI plugin. Its `ui.html` posts `{ pluginMessage: { type: "create-label", text } }`. The host answers with `{ pluginMessage, pluginId }`.

- On the desktop app the page is a sandboxed `design-app://plugin/<id>` frame (`sandbox="allow-scripts"`, no same-origin). Its response policy is `script-src 'unsafe-inline'` and `connect-src 'none'`.
- In the web app the same HTML is a sandboxed srcdoc iframe with that policy in a meta element. The parent page CSP can still block inline scripts; the desktop frame does not inherit it.

Manifest rules:

- `api` must be `1.0.0` and `editorType` must include `figma`.
- `documentAccess` is ignored. The open document is already local.
- `networkAccess` may name domains. Main-thread `fetch` is allowed only for those origins (`https`, plus an explicit `localhost` origin). The UI frame still has `connect-src 'none'`. There is no collaboration server. The panel says when network is limited to the manifest.
- `permissions` may be non-empty. They are not granted.
- `main` and `ui` must be relative paths inside the folder. `ui` may be a string or `{ "main": "ui.html" }`.

## How a call reaches the document

Plugin JavaScript runs in QuickJS. The only bridge is a fixed set of host operations. Those operations call the shared editor automation API (`batch.apply` and the existing node, page, component, and boolean methods) and commit through `Editor.change`. There is no second document model. Each flush is one undo entry. A throw before the next flush drops the unflushed edits. `figma.closePlugin` flushes, then stops the script.

Desktop content security policy still has no `unsafe-eval`. Plugin UI is an iframe with `sandbox="allow-scripts"` and `connect-src 'none'`. Main-thread `fetch` reaches only domains declared in `networkAccess`. `figma.clientStorage` is local to this client (5 MB, including JSON, `undefined`, and `Uint8Array`). Node `getPluginData` / `setPluginData` is stored in the inert FD extension `design.futureox/plugin-data` and shares the undo step of that flush. A file that carries the extension cannot be appended into another document until the extension is removed; open it on its own to keep the data.

Limits: main script 2 MiB, UI 512 KiB, guest heap 64 MiB, 8 seconds, 20,000 host calls, and 2,000 nodes in one `findAll`.

## What a real .zip or .figma plugin can do

A typical community plugin can load from a folder or a zip, read and set the selection, create rectangles, ellipses, frames, text, and the other shapes in the table, import an SVG string, create an image from bytes and paint with its SHA-1 hash, export SVG, create local paint/text/effect styles and local variables, change fills, strokes, size, position, text, and auto-layout fields that are marked supported or partial, call `figma.showUI`, exchange `pluginMessage` with the iframe, use `figma.clientStorage`, write `setPluginData`, `fetch` a declared origin from the main thread, and finish with `figma.closePlugin`. One flush is one undo step labeled `Plugin: <name>`.

## Plugins compared

Source checked on 2026-11-02, not executed inside Figma:

- [destefanis/design-lint](https://github.com/destefanis/design-lint) (MIT, community Design Lint)
- [figma/plugin-samples](https://github.com/figma/plugin-samples) (official samples, including svg-inserter and vote-tally)
- [feathericons/figma-feather](https://github.com/feathericons/figma-feather) (Feather Icons)
- [basiclines/figma-content-buddy](https://github.com/basiclines/figma-content-buddy)
- [basiclines/figma-super-tidy](https://github.com/basiclines/figma-super-tidy)
- [kawamurakazushi/figma-sort-it](https://github.com/kawamurakazushi/figma-sort-it)
- [thomas-lowry/nester](https://github.com/thomas-lowry/nester)
- [thomas-lowry/sorter](https://github.com/thomas-lowry/sorter)

Those plugins need `createNodeFromSvg`, `findAllWithCriteria`, `primaryAxisSizingMode` / `counterAxisSizingMode`, `textAutoResize`, `textCase`, `textDecoration`, `documentchange`, local paint/text styles, `fillStyleId`, image hashes, and local variables. The host now covers that local subset, plus SVG `exportAsync` and main-thread `fetch` to a declared `networkAccess` origin. Design Lint’s remote styles, text-style font size, and team-library variables are still blocked. Feather Icons can insert a local SVG string. A fetch to its icon origin works only when that origin is declared; the UI frame still cannot connect.

Behavior follows the [Figma Plugin API](https://www.figma.com/plugin-docs/api/api-reference/) where a coverage row names a property. Differences stay in the notes.

## Still blocked

These calls still throw or are absent: `createImageAsync`, vector networks, PNG/JPG/PDF `exportAsync`, remote variable libraries and variable aliases, `importStyleByKeyAsync`, payments, parameters, codegen, annotations, rich text ranges, reactions, relaunch buttons, `strokeStyleId`, UI-frame network, positive `setTimeout`, and `setInterval`. `loadFontAsync` embeds desktop system-catalog families through `font.import` admission; it never downloads a font. `figma.currentUser` is null. Viewport center is the camera origin, not the visual center, and `scrollAndZoomIntoView` does not change zoom. `documentchange` does not list the changed nodes. Plugin data lives in FD extension metadata, so a document that has it cannot be appended into another file. `createImage` accepts 256 KiB of PNG, JPEG, or WebP. GIF bytes are refused. There is no collaboration server. This is not Figma and not a published-plugin catalog.

## API coverage

`supported` runs with the behavior below. `partial` runs, with the difference in the note. `unsupported` throws `unsupported_api` or is absent. The same list is in `frontend/design-client/src/plugins/coverage.ts` and in the Plugins panel.

| API | Status | Notes |
| --- | --- | --- |
| `figma.createRectangle` | supported | Appended to the current page. Default size is 100×100. |
| `figma.createEllipse` | supported | Appended to the current page. Default size is 100×100. |
| `figma.createFrame` | supported | Appended to the current page. Default size is 100×100. |
| `figma.createSection` | supported | Appended to the current page. |
| `figma.createPolygon` | supported | Appended to the current page. pointCount defaults to 3. |
| `figma.createStar` | supported | Appended to the current page. pointCount defaults to 5. |
| `figma.createLine` | supported | Appended to the current page. Minimum thickness is 0.01 document units. |
| `figma.createText` | supported | Characters start empty. The built-in face is used until fontName is set. |
| `figma.createComponent` | supported | Creates an empty frame and converts it with component.create. |
| `figma.createComponentFromNode` | supported | Uses component.create. A non-container is wrapped by the editor. |
| `figma.createPage` | supported | Creates a page in the open document. Pass { name, makeCurrent }. |
| `figma.group` | partial | Same-parent nodes only. Bounds come from the editor group command, not Figma’s group algorithm. |
| `figma.ungroup` | partial | Ordinary group, frame, section, or boolean containers. Auto-layout and components reject. |
| `figma.union` | partial | vector.boolean.create. Operand order follows the editor’s bottom-to-top rule. |
| `figma.subtract` | partial | vector.boolean.create. Visible strokes and text reject. |
| `figma.intersect` | partial | vector.boolean.create. |
| `figma.exclude` | partial | vector.boolean.create. |
| `figma.getNodeById` | supported | Returns a node, a page, or null. Ids are document UUIDs, not Figma 1:2 ids. |
| `figma.currentPage` | supported | Get and set the editor’s active page. |
| `figma.currentPage.selection` | supported | Get and set the active page selection. |
| `figma.currentPage.appendChild` | supported | Reparents while preserving world position, then local x/y can be set. |
| `figma.currentPage.findAll` | partial | Walks at most 2000 nodes. The callback runs inside the plugin sandbox. |
| `figma.currentPage.findOne` | partial | Same walk limit as findAll. |
| `figma.root` | supported | Document name and page children. The root is not a frame. |
| `figma.notify` | supported | Shows the editor status line and the plugin log. No toast UI. |
| `figma.closePlugin` | supported | Flushes pending edits, then stops the script. The message is returned to the host. |
| `figma.showUI` | partial | Accepts __html__ or an HTML string up to 512 KiB. Desktop shows a sandboxed design-app://plugin frame. Web shows a sandboxed srcdoc iframe. visible, width, height, and title are honored. themeColors is ignored. |
| `figma.ui.show` | supported | Shows the plugin iframe after hide or showUI({ visible: false }). |
| `figma.ui.hide` | supported | Hides the iframe. The plugin keeps running. |
| `figma.ui.close` | partial | Hides the iframe. The plugin keeps running until closePlugin. show() can open it again. |
| `figma.commitUndo` | supported | Flushes the current turn as its own undo entry. Later edits in the same run are a new undo step. |
| `figma.editorType` | supported | Always "figma". |
| `figma.mode` | partial | Always "default". Inspect and codegen modes are not available. |
| `figma.pluginId` | partial | The manifest id. It is not a published Figma plugin id. |
| `figma.command` | partial | The menu command the host launched, or undefined when the manifest has no menu. |
| `figma.fileKey` | partial | Always null. Local documents have no Figma file key. |
| `figma.mixed` | partial | A frozen object. Mixed corner radius reads as this value. Assigning it throws. |
| `figma.ui.postMessage` | supported | Delivers a JSON value as event.data.pluginMessage. The frame also receives pluginId. |
| `figma.ui.onmessage` | supported | Called when the UI posts { pluginMessage }. |
| `figma.ui.on` | partial | Only the message event is accepted. |
| `figma.ui.resize` | supported | Updates the host frame size. It does not reflow the document. |
| `figma.loadFontAsync` | partial | Document families and Noto Sans SC weights resolve immediately; on desktop other families load from the system catalog through font.import admission and missing or restricted fonts reject. Web has no catalog. Italic rejects; network fonts are not fetched. |
| `figma.listAvailableFontsAsync` | partial | Lists built-in weight styles and document families. It does not scan the operating system. |
| `SceneNode.id` | supported | Document UUID. |
| `SceneNode.name` | supported | At most 200 characters. |
| `SceneNode.type` | supported | RECTANGLE, ELLIPSE, FRAME, SECTION, GROUP, POLYGON, STAR, LINE, VECTOR, TEXT, SLICE, COMPONENT, COMPONENT_SET, INSTANCE, BOOLEAN_OPERATION, or PAGE. |
| `SceneNode.x` | supported | Parent-local translation x of the node origin, matching relativeTransform tx. |
| `SceneNode.y` | supported | Parent-local translation y of the node origin. |
| `SceneNode.width` | supported | Local width. Minimum 0.01. |
| `SceneNode.height` | supported | Local height. Minimum 0.01. |
| `SceneNode.resize` | partial | Sets width and height. Figma constraints are not re-solved; this matches resizeWithoutConstraints. |
| `SceneNode.resizeWithoutConstraints` | partial | Same implementation as resize. |
| `SceneNode.visible` | supported | Authored visibility. |
| `SceneNode.locked` | supported | Locked nodes reject later edits, as in the editor. |
| `SceneNode.opacity` | supported | 0 to 1. |
| `SceneNode.rotation` | partial | Clockwise degrees around the node center. Skew is dropped when rotation is set. Scale is kept. |
| `SceneNode.relativeTransform` | partial | 2×3 matrix [[a, c, tx], [b, d, ty]]. Singular matrices are rejected. |
| `SceneNode.absoluteTransform` | partial | World 2×3 matrix from parent transforms. Stroke and effects are not included. |
| `SceneNode.absoluteBoundingBox` | partial | Axis-aligned page bounds of the node rectangle. Stroke and effects are not included. |
| `SceneNode.layoutAlign` | partial | MIN, CENTER, MAX, STRETCH, or INHERIT. Writes sizing.alignSelf. |
| `SceneNode.layoutGrow` | partial | 1 sets horizontal sizing to FILL and 0 sets FIXED. It does not follow a vertical parent axis. |
| `SceneNode.blendMode` | partial | Mapped to the editor blend list, including PASS_THROUGH. Unlisted modes throw. |
| `SceneNode.fills` | partial | SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND, and IMAGE. Any other paint throws on write and is returned as type UNSUPPORTED on read, so assigning the array back does not replace it with a solid. Gradient handles are an angle plus stops, not gradientTransform fidelity. |
| `SceneNode.strokes` | partial | Same paint types as fills. A gradient or image stroke is not reported as SOLID. One strokeWeight is written onto every stroke. Unsupported paints throw on write and stay on the node. |
| `SceneNode.strokeWeight` | partial | Creates one black stroke when the node has none. |
| `SceneNode.strokeAlign` | partial | CENTER, INSIDE, or OUTSIDE. |
| `SceneNode.strokeCap` | partial | NONE, BUTT, ROUND, or SQUARE. Arrow caps throw. |
| `SceneNode.strokeJoin` | partial | MITER, BEVEL, or ROUND. |
| `SceneNode.dashPattern` | partial | A list of dash lengths stored on the first stroke. |
| `SceneNode.cornerRadius` | partial | One number writes all four corners. Mixed corners read as figma.mixed. |
| `SceneNode.topLeftRadius` | supported | Independent corner radius. |
| `SceneNode.topRightRadius` | supported | Independent corner radius. |
| `SceneNode.bottomRightRadius` | supported | Independent corner radius. |
| `SceneNode.bottomLeftRadius` | supported | Independent corner radius. |
| `SceneNode.effects` | partial | DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, and BACKGROUND_BLUR. Other effects throw. |
| `SceneNode.constraints` | partial | MIN, CENTER, MAX, STRETCH, and SCALE. Setting constraints clears authored reference size. |
| `SceneNode.clipsContent` | supported | Frame clip flag. |
| `FrameNode.layoutMode` | partial | NONE, HORIZONTAL, or VERTICAL. Grid layout is not written. Reading grid reports GRID, which is not a Figma value. |
| `FrameNode.itemSpacing` | partial | Main-axis gap. Set layoutMode first when the frame has no layout. |
| `FrameNode.paddingTop` | partial | Auto-layout padding. |
| `FrameNode.paddingRight` | partial | Auto-layout padding. |
| `FrameNode.paddingBottom` | partial | Auto-layout padding. |
| `FrameNode.paddingLeft` | partial | Auto-layout padding. |
| `FrameNode.primaryAxisAlignItems` | partial | MIN, CENTER, MAX, or SPACE_BETWEEN. |
| `FrameNode.counterAxisAlignItems` | partial | MIN, CENTER, or MAX. BASELINE throws. |
| `FrameNode.layoutSizingHorizontal` | partial | FIXED, HUG, or FILL. Hug still has to satisfy the editor’s text or auto-layout rule. |
| `FrameNode.layoutSizingVertical` | partial | FIXED, HUG, or FILL. |
| `TextNode.characters` | supported | Replaces the whole string. Existing text runs are cleared. |
| `TextNode.fontSize` | supported | Document units, 1 to 4096. Not a screen pixel size. |
| `TextNode.fontName` | partial | Noto Sans SC styles map to weights of the built-in face. Other families must already be in the document. Italic throws. |
| `TextNode.textAlignHorizontal` | partial | LEFT, CENTER, RIGHT, or JUSTIFIED. JUSTIFIED requires the document schema that already accepts justify. |
| `TextNode.textAlignVertical` | partial | TOP, CENTER, or BOTTOM. |
| `TextNode.lineHeight` | partial | PERCENT, PIXELS, or AUTO. Stored as a unitless multiplier from 0.1 to 10. PIXELS divides by the node font size. |
| `TextNode.letterSpacing` | partial | PIXELS or PERCENT of the font size, stored as pixels from -1000 to 1000. |
| `PolygonNode.pointCount` | supported | 3 to 128. |
| `StarNode.innerRadius` | supported | 0.01 to 1. |
| `SceneNode.parent` | supported | Parent node or page. |
| `SceneNode.children` | supported | Direct children in paint order. |
| `SceneNode.appendChild` | supported | Preserves world position. |
| `SceneNode.insertChild` | supported | Index is the final sibling index. |
| `SceneNode.remove` | supported | Deletes the subtree. |
| `SceneNode.clone` | partial | Uses editor duplicate. Top-level frames are offset by the editor’s duplicate placement, not Figma’s +10,+10. |
| `SceneNode.findAll` | partial | At most 2000 visited nodes. |
| `SceneNode.findOne` | partial | At most 2000 visited nodes. |
| `ComponentNode.createInstance` | supported | Local component only. No team library. |
| `InstanceNode.detachInstance` | partial | Detaches a resolved outer instance. A brand-new instance is committed before detach. |
| `PageNode.name` | supported | Renames a page. |
| `figma.createImage` | partial | Accepts PNG, JPEG, or WebP bytes up to 256 KiB. GIF is refused because the document does not admit a GIF data URL. The hash is the SHA-1 of those bytes, the same content id a .fig archive uses for images/<hash>. |
| `figma.getImageByHash` | partial | Resolves a SHA-1 hash from this session or from an image paint already stored on a fill or stroke. getBytesAsync reads those bytes. getSizeAsync supports PNG and JPEG. |
| `figma.createImageAsync` | unsupported | Throws unsupported_api. No network image fetch. Pass bytes to createImage. |
| `figma.createNodeFromSvg` | partial | Imports the SVG through the editor SVG importer and returns the created root. Scripts, external URLs, and animation are rejected. |
| `figma.createVector` | unsupported | Throws unsupported_api. Vector networks are not exposed on this host. |
| `figma.viewport.zoom` | partial | Get and set camera zoom from 0.02 to 256. Setting zoom keeps the world point at the top-left, not the visual center. |
| `figma.viewport.center` | partial | Get and set the world point at the camera origin (top-left). The host does not know the canvas size, so this is not the visual center. |
| `figma.viewport.scrollAndZoomIntoView` | partial | Asks the editor to reveal the nodes. It does not change zoom. |
| `figma.clientStorage` | supported | getAsync, setAsync, keysAsync, and deleteAsync. JSON values, undefined, and Uint8Array. 5 MB per plugin by the official size rule, with a host ceiling of 10000 keys. Stored in this client and not undone with the canvas. |
| `figma.variables` | partial | Local collections and COLOR, FLOAT, STRING, and BOOLEAN variables. Mode ids are mode names. setValueForMode and setBoundVariable for width, height, opacity, characters, visible, fontSize, and itemSpacing. No remote libraries. |
| `figma.teamLibrary` | unsupported | Absent. There is no team library or cloud account. |
| `figma.payments` | unsupported | Absent. |
| `figma.parameters` | unsupported | Absent. Parameter UI is not collected. |
| `figma.codegen` | unsupported | Absent. |
| `figma.annotations` | unsupported | Absent. |
| `figma.currentUser` | partial | Always null. There is no account user. Optional chaining works; reading an id does not. |
| `figma.util.rgb` | supported | Returns {r, g, b} with channels from 0 to 1. |
| `figma.util.solidPaint` | supported | SOLID paint from #RGB, #RRGGBB, #RRGGBBAA, or an {r, g, b} object. |
| `figma.on` | partial | selectionchange, currentpagechange, and documentchange are delivered for editor changes outside the plugin. documentchange has an empty documentChanges list. The plugin’s own edits do not emit them. close runs inside closePlugin. run and other events throw. |
| `figma.skipInvisibleInstanceChildren` | partial | The flag is stored. findAll does not skip invisible instance children. |
| `setTimeout` | partial | Only a zero delay during the current turn. A positive delay throws. setInterval throws. |
| `fetch` | partial | Main-thread fetch only, and only to origins declared in networkAccess. https except an explicit localhost origin. Private networks, metadata hosts, credentials, and the UI frame stay blocked. |
| `figma.loadAllPagesAsync` | unsupported | Throws unsupported_api. The open document is already local; this call is not required. |
| `figma.importComponentByKeyAsync` | unsupported | Throws unsupported_api. Remote component keys are not imported. |
| `figma.createPaintStyle` | partial | Creates a local paint style. name and paints can be set. No cloud library or style key. |
| `figma.createTextStyle` | partial | Creates a local text style. fontName, lineHeight, letterSpacing, textCase, and paragraph spacing can be set. fontSize and textDecoration are kept on the node, not the style. |
| `figma.createEffectStyle` | partial | Creates a local effect style. name and effects can be set. No cloud library. |
| `figma.createGridStyle` | unsupported | Throws unsupported_api. |
| `SceneNode.exportAsync` | partial | SVG markup bytes only. PNG, JPG, and PDF stay on the editor export panel. |
| `SceneNode.getPluginData` | supported | String values for this manifest id. A missing key returns "". Pages and the document root use the same methods. Stored in the fdCompatibility extension design.futureox/plugin-data and undone with the edit. |
| `SceneNode.setPluginData` | supported | Up to 50 keys and 10000 characters. An empty string deletes the key. The same limits apply to pages and figma.root. |
| `SceneNode.getSharedPluginData` | supported | Reads a namespace another plugin on this file could also read. Missing keys return "". |
| `SceneNode.setSharedPluginData` | supported | Writes a namespaced string on the node, page, or root. An empty string deletes the key. |
| `SceneNode.setRelaunchData` | unsupported | Throws unsupported_api. Relaunch buttons are not shown. |
| `SceneNode.reactions` | unsupported | Absent. Prototype reactions are not edited from this host. |
| `SceneNode.boundVariables` | partial | Reads bindings written by setBoundVariable. Fields are width, height, opacity, characters, visible, fontSize, and itemSpacing. |
| `TextNode.getStyledTextSegments` | unsupported | Throws unsupported_api. Rich-text ranges are not read back as styled segments. |
| `figma.currentPage.findAllWithCriteria` | partial | Filters by types only, up to 2000 nodes. pluginData criteria throws. |
| `figma.createNodeFromSvg` | partial | Imports the SVG through the editor SVG importer and returns the created root. Scripts, external URLs, and animation are rejected. A multi-root import is grouped. The import is its own undo step. |
| `figma.createPaintStyle` | partial | Creates a local paint style. name and paints can be set. No cloud library or style key. |
| `figma.createTextStyle` | partial | Creates a local text style. fontName, lineHeight, letterSpacing, textCase, and paragraph spacing can be set. fontSize and textDecoration are kept on the node, not the style. |
| `figma.createEffectStyle` | partial | Creates a local effect style. name and effects can be set. No cloud library. |
| `figma.getLocalPaintStyles` | partial | Lists local paint styles. Remote library styles are absent. |
| `figma.getLocalTextStyles` | partial | Lists local text styles. fontSize reads as 16 because the style record stores the face, not a size. |
| `figma.getLocalEffectStyles` | partial | Lists local effect styles. |
| `figma.getStyleById` | partial | Returns a local style or null. Import by key is not available. |
| `figma.base64Encode` | supported | Encodes up to 256 KiB. |
| `figma.base64Decode` | supported | Decodes base64 text to bytes. |
| `FrameNode.primaryAxisSizingMode` | partial | FIXED or AUTO after layoutMode. AUTO hugs the primary axis. layoutWrap WRAP stores that axis as FIXED. |
| `FrameNode.counterAxisSizingMode` | partial | FIXED or AUTO after layoutMode. AUTO hugs the counter axis. |
| `FrameNode.layoutWrap` | partial | NONE or WRAP. Set layoutMode first. WRAP stores the primary axis as FIXED. |
| `FrameNode.counterAxisSpacing` | partial | Wrapped-row gap. Set layoutMode first. |
| `SceneNode.layoutPositioning` | partial | AUTO or ABSOLUTE. ABSOLUTE sets sizing.absolute. |
| `SceneNode.minWidth` | partial | minWidth, maxWidth, minHeight, and maxHeight write sizing limits. null resets the default bound. |
| `TextNode.textAutoResize` | partial | NONE, WIDTH_AND_HEIGHT, HEIGHT, or TRUNCATE. TRUNCATE clears wrapping and does not clip glyphs. |
| `TextNode.textCase` | partial | ORIGINAL, UPPER, or LOWER. TITLE and small caps throw. |
| `TextNode.textDecoration` | partial | NONE, UNDERLINE, or STRIKETHROUGH on the whole string. |
| `TextNode.paragraphSpacing` | partial | 0 to 10000. |
| `TextNode.paragraphIndent` | partial | -10000 to 10000. |
| `SceneNode.fillStyleId` | partial | Local paint style id, or null. No team-library styles. |
| `SceneNode.textStyleId` | partial | Local text style id on text nodes, or null. |
| `SceneNode.effectStyleId` | partial | Local effect style id, or null. |
