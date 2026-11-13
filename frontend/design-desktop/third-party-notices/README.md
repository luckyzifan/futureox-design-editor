# Notices copied beside the desktop package

`cargo/` holds the license texts of third-party crates that `cargo tree --locked --edges normal` reaches for the binaries the desktop packager installs:

- `futureox-design-desktop-backend`
- `design-render` (`futureox-design-gpu`)
- `design-prepare` (`futureox-design-kernel`)
- `futureox-design-agent`

The wasm32 graph of `futureox-design-kernel` is included. `futureox-design-server` is not. Dev-dependencies such as `tiny-skia`, and server-only crates such as `utoipa` and `sqlx-postgres`, are not in this directory.

`frontend/design-desktop/scripts/package.mjs` passes this directory as an Electron `extraResource`. That copies the texts into an unsigned package. It does not create a signed or notarized installer.

`profiling` 1.0.18 and `spirv` 0.4.0+sdk-1.4.341.0 publish an SPDX license and ship no license file in the crate archive. Their texts here were copied from the upstream git revision named in each directory's `source.json`, and that file records the URL and sha256. `color_quant` 1.1.0, `fax` 0.2.7, `gif` 0.14.2, `tiff` 0.11.3, and `weezl` 0.1.12 already ship a license file in the crate archive; those copies came from the archive. Eight macOS crates still publish an SPDX license and no license file: `block2` 0.6.2, `objc2` 0.6.5, `objc2-core-foundation` 0.3.2, `objc2-core-graphics` 0.3.2, `objc2-encode` 4.1.0, `objc2-foundation` 0.3.2, `objc2-metal` 0.3.2, and `objc2-quartz-core` 0.3.2. No macOS package was built, and no substitute text was written for them. The inventory still reports those eight crates as gaps.

Refresh the copies with:

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs --write-notices
```
