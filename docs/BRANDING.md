# Futureox brand resources

The original F/D monogram combines an open F with editable Bézier-curved arms, a D-shaped blue silhouette, and clipped left corners that subtly suggest an artboard. The 48-unit open gap keeps the F readable at small sizes. It uses no third-party logo, external asset, font glyph, or Figma-style multicolor pill stack. The parent brand is Futureox; the product display name is Futureox Design. The repository spelling remains `futureox-desgin`. The current user-selected palette is indigo blue (#3459D4) and white (#FFFFFF), with the same indigo rim (#3459D4).

## Source and regeneration

- MCP-exported vector master: `frontend/design-client/public/branding/futureox-desgin.svg`.
- Desktop resources: `frontend/design-desktop/assets/branding/` (PNG sizes 16–1024, Windows ICO 16–256, macOS ICNS up to 1024).
- Web: SVG favicon, multi-resolution fallback ICO, 180px Apple touch icon, 192/512px manifest icons.
- Editable native master: `docs/branding/futureox-desgin.fd` (frame plus two native vector networks). The original shape is created through actual JSON-RPC MCP operations; it is not imported from the prior hand-authored SVG.
- Run `FUTUREOX_BRAND_DIR=/tmp/futureox-brand node frontend/design-client/node_modules/vitest/vitest.mjs run --root frontend/design-client --config ../design-mcp/examples/branding.vitest.config.mjs` from the repository root. This needs the existing generated WASM and test dependencies.
- Generate the selected Mac variant with `FUTUREOX_BRAND_DIR=/tmp/futureox-mac node frontend/design-client/node_modules/vitest/vitest.mjs run --root frontend/design-client --config ../design-mcp/examples/branding-macos-clean.vitest.config.mjs`. Its exported SVG must be copied to `frontend/design-desktop/assets/branding/futureox-desgin-macos.svg`, and FD to `docs/branding/futureox-desgin-macos.fd`.
- Inspect the exported SVG/native PNGs, then copy the verified exported SVG into the public master path and FD into the native master path. Package resources with `python frontend/design-desktop/scripts/generate-branding.py --native-export-dir /tmp/futureox-brand --mac-native-export-dir /tmp/futureox-mac` using Pillow. The script rejects a source SVG that differs from the MCP export.
- PNG 1x/2x/3x (512/1024/1536px) and 16/32/64/256px are produced by the repository's actual `VectorEngine.render_region_png` CPU renderer from the MCP-authored native document. ICO/ICNS and additional convenience sizes use Pillow encoding/resampling of that output. No external image generator, SVG rasterizer, downloaded image or font is used in the application asset generation path. These committed icon resources are required application assets, not generated application binaries.
- Optional visual QA: append `--contact-sheet /tmp/futureox-branding.png` to render native-size 16/32/64/256px icons on light and dark surfaces.

## Integration

The editor's file-menu button uses the same SVG on Web and Electron, with an empty decorative alt because the button already has an accessible label. CSS preserves the native aspect ratio and palette.

Electron development and packaged windows load icons relative to `src/main.mjs`: Windows uses ICO, Linux uses PNG; macOS Dock uses the separate `futureox-desgin-macos.png` with white rounded-square substrate without external canvas controls at runtime. The ICNS is generated from this Mac-specific PNG, not the standalone mark. Packaging copies the assets into the application archive. Electron Packager receives the ICNS on macOS and ICO on Windows for application bundle/executable resources. Linux packages retain the PNG for window and downstream launcher use; Packager itself does not install a system menu entry.

The build-input inventory hashes the icon assets. The package verifier compares all packaged assets byte-for-byte to source resources, in addition to existing application and renderer identity checks.

There is currently no installer-generation pipeline in this project. Future Windows installers should use the committed ICO, macOS installers/app bundles the ICNS, and Linux launchers the PNG installed in the appropriate hicolor size directories. No installer, signing, notarization, native OS GUI, or trademark-clearance claim is made by these source changes.

## Checks

`node --test frontend/design-desktop/test/branding.test.mjs` checks the master, actual PNG dimensions and transparency, ICO directory entries, ICNS chunk boundaries, Web asset references, all platform packaging paths, development/packaged window integration, and package asset identity wiring. This is a source/resource contract check; native Windows/macOS resource embedding still requires a package build on each target OS.

## Authoring evidence

The example test saves the actual JSON-RPC transcript, authored geometry operations, MCP resource-export metadata, exact FD decode/reopen/edit/undo evidence, per-output hashes, and native render requests. Transport is in-memory NDJSON around the real server and real Editor/WASM, not a mocked operation implementation or an external service. PNG encoding runs in the native product renderer directly; SVG and FD export go through MCP resource reads. A visual comparison of the MCP SVG rasterized for QA and the actual native PNG differed by less than 0.05 per RGB channel on average (0–255), on both light and dark backgrounds. This is not a native window/GPU verification.

The selected Mac revision is **clean v5 / no canvas controls / Indigo + White**. The sky-blue comparison was rejected and is not used in production assets. Detailed brand meaning, geometry, usage and motion guidance are in [FUTUREOX_BRAND_DESIGN.md](FUTUREOX_BRAND_DESIGN.md).

The clean-icon test reads the preserved selected FD in `docs/branding/history/futureox-macos-refined-v4.fd` and deletes only its corner-control nodes through actual MCP. It checks all remaining geometry/styles unchanged, node count 7→5, undo/redo, FD reopen/edit, SVG export and native PNG rendering.
