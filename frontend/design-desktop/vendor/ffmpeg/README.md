# Bundled FFmpeg

Futureox Design encodes motion previews by spawning this binary. Chromium's
`libffmpeg` inside Electron is a decode library and is not used.

The packager already copies `dist/bin` with `extraResource`, so the file lands
at `Resources/bin/ffmpeg` (macOS: `Contents/Resources/bin/ffmpeg`) outside
`app.asar`. `asarUnpack` is unnecessary while the binary stays an extra
resource.

`scripts/ffmpeg-bundle.mjs` copies the host triple into `dist/bin` during
`build.mjs`. Linux x64 is required for a desktop build on that host. Other
triples are skipped when the binary is absent, and video encode stays
unavailable there.

| Triple | Packaged name | Status |
| --- | --- | --- |
| `linux-x64` | `ffmpeg` | Vendored static GPL build. See `linux-x64/LICENSE.txt`. |
| `darwin-arm64` | `ffmpeg` | Not vendored. Place the executable at `darwin-arm64/ffmpeg`. |
| `darwin-x64` | `ffmpeg` | Not vendored. Place the executable at `darwin-x64/ffmpeg`. |
| `win32-x64` | `ffmpeg.exe` | Not vendored. Place the executable at `win32-x64/ffmpeg.exe`. |

Dev builds prefer `dist/bin/ffmpeg`. A `PATH` lookup is only a fallback when
that file is missing and the app is not packaged. A packaged app never uses
`PATH`.

The Rust entry is `futureox_design_kernel::ffmpeg_encode::encode_png_sequence`.
Electron resolves the path and the desktop sidecar method `video.encode`
passes it through. The renderer never receives a filesystem path.
