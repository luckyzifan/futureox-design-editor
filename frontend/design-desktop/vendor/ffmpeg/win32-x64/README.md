Windows x64 stub. This directory does not contain a binary.

Expected file: `win32-x64/ffmpeg.exe`. `build.mjs` copies it to
`dist/bin/ffmpeg.exe` when present. Until then, a Windows package has no
`resources/bin/ffmpeg.exe` and motion export stays unavailable.
