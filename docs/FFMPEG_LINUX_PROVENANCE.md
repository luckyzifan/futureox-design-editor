# Linux x64 FFmpeg provenance

The executable at `frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg` is a
separate program. The Rust sidecar spawns it. That does not decide the license
of the rest of Futureox Design.

## This binary

| Record | Value |
| --- | --- |
| Banner | `ffmpeg version 7.0.2 Copyright` |
| SHA-256 | `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317` |
| Bytes | 5131728 |
| BuildID | `c14244632ea1466c5ff03cc39da18022390ad696` |
| License | GPL-3.0-or-later, from `--enable-gpl --enable-version3` |
| Built | 2026-11-10, gcc 13.3.0, NASM 2.16.01, Ubuntu 24.04.5 |
| Build script | `rebuild.sh` |
| Static libraries | libx264, libvpx |
| Dynamic libraries | glibc (`libc.so.6`, `libm.so.6`, `ld-linux-x86-64.so.2`) and `libz.so.1` |
| Minimum required glibc symbol version | `GLIBC_2.38`, independently read from this ELF; older Linux distributions were not validated |

`source.json` stores the full `ffmpeg -version` configuration line. The prefix
in that line is `/tmp/futureox-ffmpeg-rebuild/prefix`, which is the default
work directory in `rebuild.sh`.

## Corresponding source

These tarballs are in `linux-x64/sources/`. `rebuild.sh` does not download
anything. No patches were applied.

| Component | Pin | SHA-256 |
| --- | --- | --- |
| FFmpeg | n7.0.2 | `5eb46d18d664a0ccadf7b0adee03bd3b7fa72893d667f36c69e202a807e6d533` |
| libvpx | 1.15.2 | `26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa` |
| x264 | `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | `cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9` |

x264 is GPL-2.0-or-later. libvpx 1.15.2 is BSD. FFmpeg n7.0.2 without
`--enable-gpl` is LGPL-2.1-or-later. The switches in `rebuild.sh` distribute
this executable under GPL-3.0-or-later. The upstream texts are
`COPYING.GPLv2`, `COPYING.GPLv3`, `COPYING.LGPLv2.1`, `COPYING.LGPLv3`,
`x264-COPYING`, and `libvpx-LICENSE`.

glibc and zlib are the system libraries named by `ldd`. Their source is not
copied into this directory.

The desktop package copies the binary, `rebuild.sh`, the three tarballs, and
the license texts into `Resources/bin`.

## Replaced binary

Until 2026-11-10 the repository shipped a johnvansickle `7.0.2-static`
executable, SHA-256
`e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99`. The
`release-source` index fetched on 2026-11-09 did not list a matching source
archive. That executable is no longer in the tree. This page describes the
binary that is in the tree now.

```bash
node frontend/design-desktop/scripts/ffmpeg-provenance.mjs
node --test frontend/design-desktop/test/ffmpeg-bundle.test.mjs frontend/design-desktop/test/release-acceptance.test.mjs
```

On linux x64 the provenance script runs `ffmpeg -version`, `file`, and `ldd`.
Other platforms check the recorded hashes and do not execute the Linux binary.
