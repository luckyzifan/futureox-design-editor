# Notices copied beside the desktop package

`cargo/` holds the license texts of third-party crates that `cargo tree --locked --edges normal` reaches for the binaries the desktop packager installs:

- `futureox-design-desktop-backend`
- `design-render` (`futureox-design-gpu`)
- `design-prepare` (`futureox-design-kernel`)
- `futureox-design-agent`

The wasm32 graph of `futureox-design-kernel` is included. `futureox-design-server` is not. Dev-dependencies such as `tiny-skia`, and server-only crates such as `utoipa` and `sqlx-postgres`, are not in this directory.

`frontend/design-desktop/scripts/package.mjs` passes this directory as an Electron `extraResource`. That copies the texts into an unsigned package. It does not create a signed or notarized installer.

These ten crates publish an SPDX license and no license file in the crate archive, so they have no text here: `profiling` 1.0.18, `spirv` 0.4.0+sdk-1.4.341.0, and the macOS `objc2` / `block2` crates. The inventory reports them as gaps.

Refresh the copies with:

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs --write-notices
```
