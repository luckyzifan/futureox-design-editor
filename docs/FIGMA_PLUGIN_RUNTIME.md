# Figma plugin runtime

Futureox can load a Figma plugin folder or `.zip` and run its main script against the open document. This is a local host. It is not a Figma account, not the Design API / MCP registry, and not a promise that every community plugin runs.

The canonical matrix is `frontend/design-client/src/plugins/coverage.ts`. This build records **35 supported**, **14 partial**, and **13 unsupported** entries. Calling an unsupported surface throws. Partial entries do the subset named there.

## What runs where

| Piece | Owner |
| --- | --- |
| Manifest, zip/folder read, QuickJS sandbox, iframe messages, `clientStorage` | TypeScript / Electron |
| Create, resize, reparent, clone, group, transforms, bounds, hit-testing, plugin data | Rust `PluginSession` in `design-studio/crates/design-kernel/src/plugin_api.rs` |
| Undo, layout, and document admission | Existing `Editor.change` after the Rust flush |

The guest does not hold a second scene graph. Each command is applied by the kernel. A flush returns only changed nodes and pages. The editor commits that patch, so one plugin turn is one undo step labeled `Plugin: <name>`.

Rebuild the kernel after this change or the panel reports that `PluginSession` is missing:

```bash
cd frontend/design-client && bun run build:kernel
```

Generated bindings stay out of git. Until that rebuild, the panel can still be opened, and the guest tests do not need the wasm file.

## Load a plugin

1. Open a normal design document. Large-source workspaces stay on their own editor and do not take plugin writes.
2. Choose **插件 / Plugins** in the header.
3. **运行示例插件 / Run sample plugin** loads `frontend/design-client/plugins/labeled-rectangles`. It creates three blue frames with white text. Undo removes that turn. The sample UI can create more labels.
4. **加载插件文件夹** reads a directory that contains `manifest.json`. **加载插件 zip** reads the same shape, including one top-level folder inside the zip.
5. Only `manifest.json`, the manifest `main` file, and the optional `ui` file are executed. Each file is at most 1 MiB and the package at most 2 MiB. Paths cannot leave the package.

`editorType` must include `figma`. FigJam-only manifests are refused. Manifest `menu` commands are buttons. `figma.command` is the command you launch. `networkAccess` is recorded and not granted.

## Sandbox

Main code runs in QuickJS. It sees `figma` and the standard language built-ins. It does not see the editor, DOM, Node, or network. The run is interrupted after 8 seconds and limited to 32 MiB.

`figma.showUI` puts `ui.html`, or the HTML passed to `showUI`, in an iframe with `sandbox="allow-scripts"` and a content security policy of `default-src 'none'`. The iframe talks to the plugin with `parent.postMessage({ pluginMessage }, '*')` and reads `event.data.pluginMessage`, matching the Figma UI convention. Messages are JSON and at most 64 KiB.

`figma.clientStorage` is stored in this app’s local storage, per plugin id, up to 200 keys and 1 MiB. It is not synced anywhere.

## What a typical plugin can do

A main script can read the selection, create rectangles, ellipses, frames, text, lines, polygons, stars, sections, and pages, set SOLID fills and strokes, resize, rotate, reparent, group, clone, write text after `loadFontAsync`, save `setPluginData`, show a UI, remember `clientStorage`, and `closePlugin`.

Rotation keeps the node’s translation and scale, so the origin stays put. Reparent and ungroup keep the world position. `absoluteBoundingBox` is the transformed rectangle and does not include stroke or effect padding. Hit-testing uses the kernel picker; it is not exposed as a fake `figma.hitTest`.

## Still blocked

These do not run, and the host throws instead of pretending:

- Variables, team libraries, payments, parameters, codegen, and `figma.currentUser`
- Components, instances, and remote component import
- Image hashes, SVG import, vector networks, and `exportAsync`
- Prototype reactions and shared plugin data
- Gradient, image, and other non-SOLID paints, plus effects other than drop shadow, inner shadow, layer blur, and background blur
- Manifest network access, including from the UI iframe
- Real font-file loading. `loadFontAsync` only records the family so text writes are allowed. The document still renders with its default font
- Text line wrapping to glyph bounds
- FigJam plugins

`figma.mixed` is a host sentinel for mixed radii and stroke weights. It is not Figma’s internal symbol. `figma.viewport.center` is the visual center only when the host knows the canvas size; otherwise it is the camera origin. Assigning `zoom` scales around that origin.

This host does not change the blue accent, sticky-note tools, raster paths, or tile navigation.
