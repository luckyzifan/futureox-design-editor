macOS Intel stub. This directory does not contain a binary.

Expected file: `darwin-x64/ffmpeg`. `build.mjs` copies it to `dist/bin/ffmpeg`
when present. Until then, a macOS package has no `Resources/bin/ffmpeg` and
motion export stays unavailable.
