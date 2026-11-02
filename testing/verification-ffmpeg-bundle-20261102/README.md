# Bundled FFmpeg motion encode (2026-11-02)

Linux x64 desktop builds copy `frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg` into `dist/bin/ffmpeg`. Electron's existing `extraResource` for `dist/bin` places it at `resources/bin/ffmpeg`, outside `app.asar`. macOS and Windows only have path stubs under `vendor/ffmpeg/darwin-*` and `win32-x64`.

`resolveBundledFfmpegPath` prefers that bundled file. A packaged app does not consult `PATH`. Development may use `PATH` only when `dist/bin/ffmpeg` is missing. The renderer never sees the path. The desktop sidecar method `video.encode` calls `futureox_design_kernel::ffmpeg_encode::encode_png_sequence`, which spawns the binary with a fixed argument list (`libx264` for MP4, `libvpx-vp9` for WebM).

Animation preview, the export panel, and a prototype smart-animate transition can bake a short PNG sequence (12 fps, at most 8 seconds) and encode it when the desktop bridge reports the binary. The web app has no binary and stays on still PNG. `animation_bake` is still the plan cache, not the encoder.

This does not change raster, tiles, budgets, or experimental flags. It is not a 33/100ms or full G2/G5 result.

## Verify on Linux Electron

1. From `frontend/design-desktop`: `node scripts/ffmpeg-bundle.mjs` is not a CLI; the copy runs inside `node scripts/build.mjs`. A full desktop build is `bun run build --fast` (or `node scripts/build.mjs` after the client toolchain is installed). Confirm `dist/bin/ffmpeg` exists and `dist/bin/ffmpeg -version` prints `7.0.2-static`.
2. Package with `node scripts/package.mjs` after that build. `node scripts/verify-package.mjs` must report the bundled ffmpeg identity and accept `resources/bin/ffmpeg` as ELF matching `dist/bin/ffmpeg`, plus `ffmpeg-LICENSE.txt`.
3. Launch the packaged app (`futureox-desgin`). Open a file that has an animation clip. Export should offer MP4 and WebM, and the animation preview should offer 导出 MP4 / 导出 WebM next to 导出当前帧 PNG. The download is a real MP4 (`ftyp`) or WebM (EBML). A prototype smart-animate transition shows 导出过渡 MP4 / WebM.
4. `strings` or `ldd dist/bin/ffmpeg` should show a static binary, not Chromium's `libffmpeg.so`.

Targeted checks that do not need a full package:

- `cargo test -p futureox-design-kernel --lib ffmpeg_encode`
- `cargo test -p futureox-design-desktop-backend --lib video_encode_method`
- `node --test test/ffmpeg-encode.test.mjs test/ffmpeg-bundle.test.mjs test/preload.test.mjs` from `frontend/design-desktop`
- `bun x vitest run src/motion-video.test.ts` from `frontend/design-client`

The vendored binary is GPL-3.0-or-later. See `vendor/ffmpeg/linux-x64/LICENSE.txt`.

## What was run

- `cargo test -p futureox-design-kernel --lib ffmpeg_encode`: 4 passed. That includes a real spawn of the vendored linux-x64 binary encoding two 8×8 PNGs to MP4 (`ftyp`) and WebM (EBML).
- `cargo test -p futureox-design-desktop-backend --lib video_encode_method`: the sidecar method `video.encode` spawned the supplied executable and accepted the MP4 result.
- `node --test` for `ffmpeg-encode`, `ffmpeg-bundle`, `preload`, and `motion-preview` passed.
- A packaged Electron window was not clicked through in this run. Raster, tiles, and budgets were not changed. This is not a 33/100ms or full G2/G5 result.
