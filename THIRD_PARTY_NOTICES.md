# Third-party notices and release status

This inventory preserves third-party terms; it does not select a project license,
relicense third-party work, or certify the complete distribution for release.

Full license texts are shipped in `frontend/design-client/public/licenses/`, copied
to production renderer `licenses/` by the build. `inventory.json` records installed
versions and notice hashes. Keep these texts with distributed copies.

## UI runtime

- Poppins Regular, Medium, SemiBold and Bold: Copyright 2020 The Poppins Project Authors; SIL Open Font License 1.1. Unmodified font bytes, license and download hashes are shipped in `fonts/poppins/`. Only explicitly matching imported FIG font identities use these faces.

- fflate 0.8.3: MIT; `licenses/fflate-LICENSE.txt`.
- fzstd 0.1.1: MIT; `licenses/fzstd-LICENSE.txt`.
- immer 11.1.21: MIT; `licenses/immer-LICENSE.txt`.
- kiwi-schema 0.5.0: MIT; `licenses/kiwi-schema-LICENSE.txt`.
- lucide-react 1.47.0: ISC; `licenses/lucide-react-LICENSE.txt`.
- react 19.3.1: MIT; `licenses/react-LICENSE.txt`.
- react-dom 19.3.1: MIT; `licenses/react-dom-LICENSE.txt`.
- scheduler 0.28.0: MIT; `licenses/scheduler-LICENSE.txt`.
- svg-pathdata 9.0.0: MIT; `licenses/svg-pathdata-LICENSE.txt`.

Lucide's complete notice includes ISC and Feather-derived MIT terms and both
copyright attributions. The generic ISC package field does not replace that text.
Kiwi's npm installation omits a license file; its notice was obtained from the
upstream repository's LICENSE.md. Pinning upstream provenance to the precise
package source revision remains a release-verification task.

## Font and vendored code

- Noto Sans SC: SIL OFL-1.1; `public/fonts/OFL.txt`, `public/fonts/source.json`, and
  `licenses/NotoSansSC-OFL.txt`. Copyright 2014-2021 Adobe; Reserved Font Name Source.
  Preserve the OFL and copyright notice, including with embedded or bundled fonts.
- moxcms 0.8.1: BSD-3-Clause OR Apache-2.0; both original texts are preserved under
  `vendor/moxcms/` and `public/licenses/moxcms-*.txt`. No new license election is made.

- flo_curves 0.8.1: Apache-2.0; original license in `vendor/flo_curves/LICENSE`
  and `public/licenses/flo_curves-Apache-2.0.txt`. The local ray-collision ordering
  correction is documented in `vendor/flo_curves/PATCHES.md`.

## Release gates

The repository has no selected top-level project license. Rust's 337 lockfile
packages and Electron/runtime transitive notices require a separate complete
binary-distribution inventory. Installed development packages are not necessarily
shipped runtime code. This document does not clear that remaining work.

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
`frontend/design-desktop/vendor/ffmpeg/linux-x64/`. It is FFmpeg 7.0.2-static
configured with `--enable-gpl --enable-version3` (GPL-3.0-or-later), including
libx264 and libvpx. The binary is spawned by the Rust sidecar; it is not linked
into Electron or the design kernel. License text and provenance are
`linux-x64/LICENSE.txt`, `COPYING.GPLv3`, `COPYING.LGPLv2.1`, and `source.json`.
macOS and Windows paths are documented stubs and do not ship a binary yet.
Upstream build: https://johnvansickle.com/ffmpeg/ . Obtained from the
ffmpeg-static b6.1.1 linux-x64 asset.

## RustCrypto ARM SHA-2 acceleration

Native ARM builds enable the existing `sha2` 0.10.9 `asm` feature, including
`sha2-asm` 0.6.4 (MIT). The digest format and runtime portable fallback remain
unchanged. Its full license is retained in `public/licenses/sha2-asm-MIT.txt`.
Copyright (c) 2020 RustCrypto Developers; copyright (c) 2017 Project Nayuki,
Artyom Pavlov. Upstream: https://github.com/RustCrypto/asm-hashes .
