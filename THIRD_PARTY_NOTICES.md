# Third-party notices and release status

This inventory preserves third-party terms; it does not select a project license,
relicense third-party work, or certify the complete distribution for release.

Full license texts are shipped in `frontend/design-client/public/licenses/`, copied
to production renderer `licenses/` by the build. `inventory.json` records installed
versions and notice hashes. Keep these texts with distributed copies.

## UI runtime

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
