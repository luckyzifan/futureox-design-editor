macOS Apple silicon stub. This directory does not contain a binary.

Expected file: `darwin-arm64/ffmpeg` (no `.exe`). `build.mjs` copies it to
`dist/bin/ffmpeg` when present. Until then, a macOS package has no
`Resources/bin/ffmpeg` and motion export stays unavailable.
