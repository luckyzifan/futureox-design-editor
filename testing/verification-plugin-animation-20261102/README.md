# Plugin host and lightweight prototype motion

2026-11-02. This is not a 33/100ms result and not full G2/G5. Raster, tiles, and budgets were not changed.

## What landed

The Plugins panel still runs the QuickJS host. The snapshot worker in `frontend/design-client/src/plugins/coverage.ts` is the matrix in `docs/FIGMA_PLUGIN_HOST.md`. That matrix is now 49 supported, 38 partial, 13 unsupported.

The snapshot host can now:

- `figma.clientStorage` getAsync, setAsync, deleteAsync, and keysAsync. Values stay outside the document and are not undone with the canvas. This host keeps them in process memory for the plugin id. The QuickJS panel stores them in localStorage.
- `figma.createComponent` and `createInstance` for a local main component. No variants and no team library. A name set on the new instance in the same turn can be normalized to the main component name when the editor admits it.
- `figma.createImage` and `figma.getImageByHash` for PNG, JPEG, or WebP bytes up to 256 KiB. The hash is the SHA-1 of those bytes. A paint stores a data URL. GIF bytes are refused.
- `node.exportAsync` for a small SVG of the node box. PNG, JPG, and PDF throw. This is not the export panel and not FFmpeg.
- `figma.ungroup` for a group, frame, or section that is not auto-layout, a component, or a boolean.
- `layoutSizingHorizontal`, `layoutSizingVertical`, `primaryAxisAlignItems`, `counterAxisAlignItems`, and `layoutAlign`.

Fills and strokes accept SOLID, linear, radial, angular, and diamond gradients, and IMAGE. Another paint type throws. The previous paints stay on the node. A gradient or image stroke is not reported as a solid. The QuickJS host validates that on write, before the assignment is queued.

## Load a plugin in Electron

1. Open a design. Plugins edit the normal editor document.
2. **Plugins** → **Load plugin folder…** and choose the folder that contains `manifest.json`. The desktop app also enables child folders of the user-data `plugins` directory at startup. Restart after adding one. The scan does not run the plugin.
3. **Load .zip / .figma** and choose an archive. A `.figma` plugin file is a zip. The archive may nest the plugin in one folder. The loader reads `manifest.json`, the manifest `main` script, and the optional `ui` file.

A real Figma Community plugin was not downloaded in this environment. CI does not fetch one. The stand-in is `frontend/design-client/plugins/component-kit` (`manifest.json` and `code.js`). It uses clientStorage, a local component and instance, auto-layout alignment and hug sizing, ungroup, an image hash, a linear gradient, and a radial gradient, and it refuses a VIDEO paint.

## Animation

A navigate, back, overlay, or scroll action with no duration and no `transitionStyle: "none"` uses 300ms ease-out. An explicit 0 and `none` stay instant. Dissolve still crossfades two settled frames and does not build a smart-animate plan. If the smart-animate plan cannot be built, the player crossfades opacity instead of sampling.

In-between smart-animate samples still interpolate opacity and transform. Glass and blur radii are capped for those ticks and the resting frame keeps the authored effect. Angular and diamond paints skip per-tick sampling because the sampler rejects them. A failed bake or sample does not open the red alert. The progress clock cancels when the preview unmounts and does not deliver a later tick. Reduced motion jumps to the end. FFmpeg MP4/WebM export of a smart-animate transition stays on the preview.

## Checks

`bunx vitest run` in `frontend/design-client` for:

- `src/plugins/plugin-host.test.ts`
- `src/plugins/rich-host/plugin-host.test.ts`
- `src/plugins/plugin-panel.test.tsx`
- `src/prototype-motion.test.ts`
- `src/prototype-easing.test.ts`
- `src/prototype-playback.test.ts`

40 tests passed in the plugin, panel, and motion files. The kernel used for that run was a local dev wasm build and is not part of this change.

## Still open

On the snapshot host: `figma.variables`, `figma.teamLibrary`, `figma.payments`, `figma.parameters`, `figma.codegen`, `figma.currentUser`, `figma.importComponentByKeyAsync`, `figma.createNodeFromSvg`, `node.vectorNetwork`, `node.reactions`, `figma.annotations`, and manifest `networkAccess`. The snapshot UI window still cancels network requests. There is no collaboration server and no Design API chip.

The QuickJS panel already has a larger subset, including local variables, SVG import, and `fetch` only for origins declared in `networkAccess`. Team library, payments, parameters, codegen, annotations, remote components, and `figma.currentUser` stay blocked there too. `figma.currentUser` is null. PNG, JPG, and PDF `exportAsync` stay on the export panel.

A downloaded Community plugin was not run. 33/100ms and full G2/G5 were not measured and are not closed.
