# Futureox Design Figma plugin host (v1)

This host runs a documented subset of the Figma Plugin API against the open Futureox document. It is a local editor feature. It is not Figma, not a Figma account, and not an MCP `use_figma` eval tool.

## Run the sample

1. Open a design in Futureox Design.
2. Choose **插件** / **Plugins** in the header.
3. Choose **运行示例** / **Run sample**.

The sample is `frontend/design-client/src/plugins/sample/` (`manifest.json` + `code.js`). It creates a 320×140 frame named “Plugin sample”, fills it with `#3459d4`, and adds a white text layer “Futureox”. One or more undo steps labeled `Plugin: Labeled frame` remove it.

## Load a plugin folder

Choose **载入插件文件夹** / **Load plugin folder** and pick a directory that contains a Figma-style `manifest.json` and the `main` script it names. Optional `ui` must be an `.html` file in that folder. The loader reads only those files.

`frontend/design-client/src/plugins/sample-ui/` is a small UI plugin. Its `ui.html` posts `{ pluginMessage: { type: "create-label", text } }`. In the desktop app that page is a sandboxed `design-app://plugin/<id>` frame (`sandbox="allow-scripts"`, no same-origin, no network). In the web app the same main script stays running and the panel can send that JSON message.

Manifest rules:

- `api` must be `1.0.0` and `editorType` must include `figma`.
- `documentAccess`, when set, must be `dynamic-page`. Only the open document is visible.
- `networkAccess.allowedDomains` must be omitted, empty, or `["none"]`. Any other domain rejects the plugin.
- `permissions` must be omitted or empty.
- `main` and `ui` must be relative paths inside the folder.

## How a call reaches the document

Plugin JavaScript runs in QuickJS. The only bridge is a fixed set of host operations. Those operations call the shared editor automation API (`batch.apply` and the existing node, page, component, and boolean methods) and commit through `Editor.change`. There is no second document model. Each flush is one undo entry. A throw before the next flush drops the unflushed edits. `figma.closePlugin` flushes, then stops the script.

Desktop content security policy still has no `unsafe-eval`. Plugin UI is the only framed document, and only at `design-app://plugin`. Its own policy is `script-src 'unsafe-inline'` and `connect-src 'none'`.

Limits: main script 2 MiB, UI 512 KiB, guest heap 64 MiB, 8 seconds, 20,000 host calls, and 2,000 nodes in one `findAll`.

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
| `figma.showUI` | partial | The first argument must be __html__. Desktop shows it in a sandboxed frame. Web keeps the script alive and can send JSON messages. |
| `figma.ui.postMessage` | supported | Delivers a JSON value to the plugin UI frame. |
| `figma.ui.onmessage` | supported | Called when the UI posts { pluginMessage }. |
| `figma.ui.on` | partial | Only the message event is accepted. |
| `figma.ui.resize` | supported | Updates the host frame size. It does not reflow the document. |
| `figma.loadFontAsync` | partial | Resolves Noto Sans SC weight styles and document font families. Italic and unknown families reject. Network fonts are not fetched. |
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
| `SceneNode.blendMode` | partial | Mapped to the editor blend list, including PASS_THROUGH. Unlisted modes throw. |
| `SceneNode.fills` | partial | SOLID and GRADIENT_LINEAR. Other paint types throw. Gradient handles are an angle plus stops, not gradientTransform fidelity. |
| `SceneNode.strokes` | partial | SOLID strokes only. One strokeWeight is written onto every stroke. |
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
| `figma.createImage` | unsupported | Throws unsupported_api. Image bytes are not accepted from plugin code. |
| `figma.createImageAsync` | unsupported | Throws unsupported_api. No network image fetch. |
| `figma.createNodeFromSvg` | unsupported | Throws unsupported_api. Use the editor SVG import for SVG files. |
| `figma.createVector` | unsupported | Throws unsupported_api. Vector networks are not exposed on this host. |
| `figma.viewport` | unsupported | Absent. Camera and zoom are editor commands, not plugin API. |
| `figma.clientStorage` | unsupported | Absent. Plugin key-value storage is not persisted. |
| `figma.variables` | unsupported | Absent. Document variables stay on the editor variable operations. |
| `figma.teamLibrary` | unsupported | Absent. There is no team library or cloud account. |
| `figma.payments` | unsupported | Absent. |
| `figma.parameters` | unsupported | Absent. Parameter UI is not collected. |
| `figma.codegen` | unsupported | Absent. |
| `figma.annotations` | unsupported | Absent. |
| `figma.currentUser` | unsupported | Absent. There is no account user. |
| `figma.util` | unsupported | Absent. |
| `figma.on` | unsupported | Throws unsupported_api. Document change events are not subscribed. |
| `figma.loadAllPagesAsync` | unsupported | Throws unsupported_api. The open document is already local; this call is not required. |
| `figma.importComponentByKeyAsync` | unsupported | Throws unsupported_api. Remote component keys are not imported. |
| `figma.createPaintStyle` | unsupported | Throws unsupported_api. Shared styles are not created from plugins. |
| `figma.createTextStyle` | unsupported | Throws unsupported_api. |
| `figma.createEffectStyle` | unsupported | Throws unsupported_api. |
| `figma.createGridStyle` | unsupported | Throws unsupported_api. |
| `SceneNode.exportAsync` | unsupported | Throws unsupported_api. Use the editor export panel. |
| `SceneNode.getPluginData` | unsupported | Throws unsupported_api. Plugin data is not stored on nodes. |
| `SceneNode.setPluginData` | unsupported | Throws unsupported_api. Plugin data is not stored on nodes. |
| `SceneNode.getSharedPluginData` | unsupported | Throws unsupported_api. |
| `SceneNode.setSharedPluginData` | unsupported | Throws unsupported_api. |
| `SceneNode.setRelaunchData` | unsupported | Throws unsupported_api. Relaunch buttons are not shown. |
| `SceneNode.reactions` | unsupported | Absent. Prototype reactions are not edited from this host. |
| `SceneNode.boundVariables` | unsupported | Absent. |
| `TextNode.getStyledTextSegments` | unsupported | Throws unsupported_api. Rich-text ranges are not read back as styled segments. |
