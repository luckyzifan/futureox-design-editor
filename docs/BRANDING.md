# Futureox brand resources

The current mark is a refined letter F for Futureox: a white stroke with round terminals on an indigo squircle (`#3459D4`). It is not a font glyph, a third-party logo, or a multicolor pill. The parent brand is Futureox; the product display name is Futureox Design. The GitHub repository is `luckyzifan/futureox-design-editor`.

## Source and regeneration

- Vector master: `frontend/design-client/public/branding/futureox-desgin.svg`.
- Desktop resources: `frontend/design-desktop/assets/branding/` (PNG sizes 16–1024, Windows ICO 16–256, macOS ICNS up to 1024).
- Web: SVG favicon, multi-resolution fallback ICO, 180px Apple touch icon, 192/512px manifest icons.
- Runtime rasters are produced from the SVG masters by `frontend/design-desktop/scripts/render-brand-mark.mjs` (`@resvg/resvg-js` on `NODE_PATH` or `/tmp/brand-render`). Windows ICO and macOS ICNS embed those PNGs. These committed icon resources are required application assets, not generated application binaries.

## Integration

The editor's file-menu button uses the same SVG on Web and Electron, with an empty decorative alt because the button already has an accessible label. CSS preserves the native aspect ratio and palette.

Electron development and packaged windows load icons relative to `src/main.mjs`: Windows uses ICO, Linux uses PNG; macOS Dock uses the separate `futureox-desgin-macos.png` with white rounded-square substrate without external canvas controls at runtime. The ICNS is generated from this Mac-specific PNG, not the standalone mark. Packaging copies the assets into the application archive. Electron Packager receives the ICNS on macOS and ICO on Windows for application bundle/executable resources. Linux packages retain the PNG for window and downstream launcher use; Packager itself does not install a system menu entry.

The build-input inventory hashes the icon assets. The package verifier compares all packaged assets byte-for-byte to source resources, in addition to existing application and renderer identity checks.

There is currently no installer-generation pipeline in this project. Future Windows installers should use the committed ICO, macOS installers/app bundles the ICNS, and Linux launchers the PNG installed in the appropriate hicolor size directories. No installer, signing, notarization, native OS GUI, or trademark-clearance claim is made by these source changes.

## Checks

`node --test frontend/design-desktop/test/branding.test.mjs` checks the master, actual PNG dimensions and transparency, ICO directory entries, ICNS chunk boundaries, Web asset references, all platform packaging paths, development/packaged window integration, and package asset identity wiring. This is a source/resource contract check; native Windows/macOS resource embedding still requires a package build on each target OS.
