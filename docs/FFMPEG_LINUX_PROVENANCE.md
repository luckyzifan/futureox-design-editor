# Linux x64 FFmpeg provenance

The executable at `frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg` is a
separate program. The Rust sidecar spawns it. That does not decide the license
of the rest of Futureox Design.

## Checked against this file

| Record | Value |
| --- | --- |
| Banner | `ffmpeg version 7.0.2-static` |
| SHA-256 | `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99` |
| Bytes | 79826272 |
| BuildID | `edfa98c6c76982e3c1e0bf47fa06c97212951b21` |
| License | GPL-3.0-or-later, from `--enable-gpl --enable-version3` |
| Obtained from | ffmpeg-static `b6.1.1` asset `ffmpeg-linux-x64.gz` |
| Gzip SHA-256 | `bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa` |
| Uncompressed match | yes, checked 2026-11-09 |
| Upstream readme | `UPSTREAM-README.txt`, SHA-256 `72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537` |
| `COPYING.GPLv3` | SHA-256 `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`, same as the b6.1.1 `linux-x64.LICENSE` asset |

The full configuration line is in `source.json`. It was read from this binary's
`ffmpeg -version` banner. An earlier record listed only
`--enable-gpl --enable-version3 --enable-static --enable-libx264 --enable-libvpx`.
Those flags are still present. The banner also names gnutls, libx265, libaom,
and the other `--enable-lib*` flags stored in `source.json`.

`UPSTREAM-README.txt` names build `ffmpeg-7.0.2-amd64-static.tar.xz` and gives
library versions such as libx264 0.164.3191 and libvpx 1.11.0-30-g888bafc78.
Those versions come from that readme, not from strings extracted out of the
binary one by one.

## Not checked

`https://johnvansickle.com/ffmpeg/release-source/` was fetched on 2026-11-09.
The index listed older archives such as `ffmpeg-4.1.tar.xz`. It did not list
an FFmpeg 7.0.2 tarball or the library versions in `UPSTREAM-README.txt`.
This repository does not vendor that corresponding source, and this binary was
not rebuilt here. `correspondingSourceInRepo` and `rebuiltFromSource` stay
false.

```bash
node frontend/design-desktop/scripts/ffmpeg-provenance.mjs
node --test frontend/design-desktop/test/ffmpeg-bundle.test.mjs frontend/design-desktop/test/release-acceptance.test.mjs
```
