# Linux FFmpeg corresponding source, 2026-11-10

The linux-x64 executable in `frontend/design-desktop/vendor/ffmpeg/linux-x64/`
was rebuilt on this Ubuntu 24.04.5 machine from the tarballs next to it.
libx264 and libvpx are static. glibc and `libz.so.1` stay dynamic. This is not
a signed desktop installer, and it is not 33/100ms or full G2/G5.

## Commands

```bash
node frontend/design-desktop/scripts/ffmpeg-provenance.mjs
node --test frontend/design-desktop/test/ffmpeg-bundle.test.mjs frontend/design-desktop/test/release-acceptance.test.mjs
```

Provenance exited 0 with `problems: []`, `bannerChecked: true`,
`correspondingSourceInRepo: true`, and `rebuiltFromSource: true`.
The node tests were 6 passed, 0 failed, 0 skipped.

The same binary encoded two 8x8 PNGs with the argument list used by
`encode_png_sequence`:

- MP4, 1576 bytes, prefix `ftypisom`
- WebM, 565 bytes, prefix `1a45dfa3`

`ldd` showed `libc.so.6`, `libm.so.6`, `libz.so.1`, and the dynamic loader.
It did not show `libx264` or `libvpx`.

Binary SHA-256 `18b5fd65ba4de2754c548b6b3f38ec92fb8863b36f1b034d9175248aa78c3317`,
5131728 bytes, BuildID `c14244632ea1466c5ff03cc39da18022390ad696`.

Compiler: gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0. NASM 2.16.01.

After this work was moved onto `origin/main` `21cb6bf0`, which restores the
kernel test fixtures:

```bash
cargo test --locked -p futureox-design-kernel --lib vendored_linux_ffmpeg_encodes_mp4_and_webm -- --color never
```

`ffmpeg_encode::tests::vendored_linux_ffmpeg_encodes_mp4_and_webm` passed.
1 passed, 0 failed, 898 filtered out.

```bash
cargo test --locked -p futureox-design-desktop-backend autosave_recovery -- --test-threads=2 --color never
node frontend/design-desktop/scripts/accept-autosave-recovery.mjs
```

The six `autosave_recovery` tests passed. The acceptance script's simulated
faults are `passed`. Its release-package steps stay `not_run`.

macOS and Windows FFmpeg binaries were not built. The configuration line still
contains the script's default prefix `/tmp/futureox-ffmpeg-rebuild/prefix`.
glibc and `libz.so.1` are dynamic system libraries; their source is not vendored.
