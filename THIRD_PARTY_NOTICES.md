# Third-party notices and release status

Futureox Design's original code is licensed under the MIT License; see
[LICENSE](LICENSE). This inventory preserves third-party terms; it does not
relicense third-party work or certify the complete distribution for release.

Full license texts are shipped in `frontend/design-client/public/licenses/`, copied
to production renderer `licenses/` by the build. `inventory.json` records installed
versions and notice hashes. Keep these texts with distributed copies.

## UI runtime

- Poppins Regular, Medium, SemiBold and Bold: Copyright 2020 The Poppins Project Authors; SIL Open Font License 1.1. Unmodified font bytes, license and download hashes are shipped in `fonts/poppins/`. Only explicitly matching imported FIG font identities use these faces.
- Inter 3.19 variable font: Copyright 2016–2020 The Inter Project Authors; SIL Open Font License 1.1. The unmodified upstream font and notice ship in `fonts/inter/v3.19/`, with source hashes in `fonts/inter/sources.json`. FIG imports select it by source digest.

- fflate 0.8.3: MIT; `licenses/fflate-LICENSE.txt`.
- fzstd 0.1.1: MIT; `licenses/fzstd-LICENSE.txt`.
- immer 11.1.21: MIT; `licenses/immer-LICENSE.txt`.
- kiwi-schema 0.5.0: MIT; `licenses/kiwi-schema-LICENSE.txt`.
- lucide-react 1.47.0: ISC; `licenses/lucide-react-LICENSE.txt`.
- react 19.3.1: MIT; `licenses/react-LICENSE.txt`.
- react-dom 19.3.1: MIT; `licenses/react-dom-LICENSE.txt`.
- scheduler 0.28.0: MIT; `licenses/scheduler-LICENSE.txt`.
- svg-pathdata 9.0.0: MIT; `licenses/svg-pathdata-LICENSE.txt`.
- quickjs-emscripten 0.32.0, quickjs-emscripten-core 0.32.0, and `@jitl/quickjs-ffi-types` 0.32.0: MIT; `licenses/quickjs-emscripten-LICENSE.txt`.
- `@jitl/quickjs-wasmfile-debug-asyncify`, `@jitl/quickjs-wasmfile-debug-sync`, `@jitl/quickjs-wasmfile-release-asyncify`, and `@jitl/quickjs-wasmfile-release-sync`, all 0.32.0: MIT, including the QuickJS terms in the npm `LICENSE`; `licenses/quickjs-wasmfile-LICENSE.txt`.

The renderer imports `quickjs-emscripten`. That package's entry re-exports all four wasm variants. Which of those variants remain after the production bundle's tree-shaking was not measured, because this checkout has no built renderer.

Lucide's complete notice includes ISC and Feather-derived MIT terms and both
copyright attributions. The generic ISC package field does not replace that text.
Kiwi's npm installation omits a license file; its notice was obtained from the
upstream repository's LICENSE.md. Pinning upstream provenance to the precise
package source revision remains a release-verification task.

## Font and vendored code

- Noto Sans SC: SIL OFL-1.1; `public/fonts/OFL.txt`, `public/fonts/source.json`, and
  `licenses/NotoSansSC-OFL.txt`. Copyright 2014-2021 Adobe; Reserved Font Name Source.
  Preserve the OFL and copyright notice, including with embedded or bundled fonts.
- moxcms 0.8.1 and 0.9.1: BSD-3-Clause OR Apache-2.0. The kernel depends on 0.9.1.
  `image` 0.25.10 pulls the patched 0.8.1 tree under `vendor/moxcms/`. The BSD
  and Apache texts of those two versions are byte-identical; both are preserved
  under `vendor/moxcms/` and `public/licenses/moxcms-*.txt`. No new license
  election is made.

- flo_curves 0.8.1: Apache-2.0; original license in `vendor/flo_curves/LICENSE`
  and `public/licenses/flo_curves-Apache-2.0.txt`. The local ray-collision ordering
  correction is documented in `vendor/flo_curves/PATCHES.md`.

## Release gates

`node frontend/design-desktop/scripts/release-component-inventory.mjs` maps the
current package inputs. It does not accept a signed installer. On 2026-11-10
the locked graph had 381 package entries. The normal dependency trees of the
four packaged binaries, across Linux x64, macOS arm64, Windows x64, and
wasm32, contain 263 third-party crates. 253 of those have a license text under
`frontend/design-desktop/third-party-notices/cargo/`. The other ten publish an
SPDX identifier and no license file in the crate archive.

Installed development packages are not shipped runtime code. Vite, Lightning
CSS, Playwright, and `@electron/packager` stay on that development side. The
`electron` npm package is a downloader; the runtime that ships is the Electron
distribution zip.

This document does not clear a signed or notarized release. Native sidecar
binaries were not built here, and the generated WASM bindings were not in
this checkout.

Reference fixtures are excluded from production assets, but remain in the source
repository and tests. Source publication still requires their ownership/permission
review. See `docs/UI_ASSET_PROVENANCE.md`, including unresolved derivation claims.
Do not remove required attribution when renaming internal implementation concepts.

## Retired Nomi artwork companion

The previous optional sprite runtime and its artwork have been removed from the
current application source. Historical delivered archives retain their original
MIT license and attribution for Cookieboty/nomi-ai commit
`2d50d24dc0bae366d74918f90fe203e7a129a0b3`, copyright (c) 2026 Cookieboty and
contributors. This retirement does not change the terms of those archives.
No replacement artwork, upstream executable runtime, voice assets or model is
included in this pending replacement stage. See
`docs/NOMI_PET_INTEGRATION.zh-CN.md` for current scope and validation limits.

## Desigma architecture and FIG geometry reference

The f64 vector geometry and shared FIG decoding refactor references Desigma
commit `bb09ba87b1b7e7246b5dfbf916d75e3f12abe870`,
https://github.com/deepfounder-ai/desigma (MIT OR Apache-2.0). The MIT notice
is retained in `public/licenses/desigma-MIT.txt` and its hash in the inventory.
Copyright (c) 2026 Deep Founder and the desigma contributors.

The reference separates render paths from editable networks and documents FIG
segment/tangent/region and path-command layouts. This project uses its existing
scene and renderer with f64 geometry, bounded decoding and source-preserving
storage; it does not embed Desigma's app or renderer. Desigma has no Sketch
importer in that revision; Sketch continues through this project's own codec.

## Bundled FFmpeg

The desktop package can include a separate linux-x64 `ffmpeg` executable under
`frontend/design-desktop/vendor/ffmpeg/linux-x64/`. It is FFmpeg 7.0.2,
GPL-3.0-or-later. SHA-256
`18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317`, build id
`c14244632ea1466c5ff03cc39da18022390ad696`, and the `ffmpeg -version`
configuration are in `linux-x64/source.json`.

`rebuild.sh` built that binary on 2026-11-10 from the tarballs in
`linux-x64/sources/`: FFmpeg n7.0.2, libvpx 1.15.2, and x264 commit
`b35605ace3ddf7c1a5d67a2eb553f034aef41d55`. No patches were applied. libx264 and
libvpx are linked into the executable. glibc and `libz.so.1` remain dynamic
system libraries. `--enable-gpl` and `--enable-version3` select
GPL-3.0-or-later. x264 is GPL-2.0-or-later and libvpx is BSD.

The earlier johnvansickle `7.0.2-static` executable is no longer shipped. Its
release-source index did not contain a matching source archive.

The binary is spawned by the Rust sidecar; it is not linked into Electron or
the design kernel. That spawn does not decide the license of the rest of the
application. License texts are `LICENSE.txt`, `BUILD.txt`, `COPYING.GPLv2`,
`COPYING.GPLv3`, `COPYING.LGPLv2.1`, `COPYING.LGPLv3`, `x264-COPYING`, and
`libvpx-LICENSE`. macOS and Windows paths are documented stubs and do not ship
a binary yet.

## RustCrypto SHA-2

The kernel uses the workspace `sha2` 0.11.1 dependency. The current lockfile
does not include `sha2-asm` 0.6.4, and native ARM builds no longer request its
old `asm` feature. The digest format remains unchanged. See `Cargo.lock` for
the resolved native and transitive dependency versions.
