# sRGB path for canvas, fills, strokes, and export

Unmanaged documents store fill, stroke, and stop colors as encoded sRGB. `#RRGGBB` and `color(srgb r g b / a)` share `color::pixel`. The Figma raster profile composites those bytes in place. It does not decode them to linear light and encode them again on the way out. A managed document decodes every authored color into extended-range linear sRGB, then encodes on output. Alpha is coverage and is not run through a transfer curve.

Sketch `colorSpace` 1 is an sRGB tag, not linear management. Native Sketch composites in that encoded space, so those archives stay unmanaged and re-export as `colorSpace` 1. A document that already has sRGB color management exports `userInfo.com.futureox.design-kernel.linearSrgbComposite` and imports back onto the linear path. Native Sketch preview exports keep that linear management when the flag is present; other `colorSpace` 1 previews stay encoded. An unmanaged source reports color settings as JSON `null`, and PNG row decoding accepts that token instead of requiring `ColorSettings`. Display P3 (`colorSpace` 2) stays managed.

## Canvas

2D previews request `{ colorSpace: 'srgb' }`. The resident WebGPU swapchain is also `colorSpace: 'srgb'`.

- Unmanaged tiles are sRGB bytes. The presenter copies them (`COLOR_MODE` 0).
- Managed linear tiles are decoded or copied into an `rgba16float` target, then encoded with the IEC 61966-2-1 transfer (`COLOR_MODE` 2) before the 8-bit canvas.
- The separate float presenter can target `display-p3` when the display gamut matches. That path is not the default 8-bit canvas.

SVG export sets `color-interpolation="sRGB"` on the root and on gradients. Filter effects set `color-interpolation-filters="sRGB"`. An omitted color-control `space` means the unmanaged encoded-sRGB working values, so the SVG matrix stays in sRGB. `linearRGB` would decode before the matrix and disagree with the CPU path. Display P3 color controls are rejected for SVG instead of being relabeled as sRGB.

## PNG

8-bit CPU PNG writes a one-byte `sRGB` chunk with perceptual rendering intent and the same canonical sRGB ICC profile used by JPEG, WebP and PDF. The samples are straight RGBA8. This is the export panel's default PNG.

The export panel can also ask for Display P3 without turning on document color management. That path still composites in encoded sRGB, then converts each straight sample to encoded Display P3 and writes an 8-bit PNG with a Display P3 ICC profile and a cICP chunk (`12/13`). It does not write an sRGB chunk. The 8-bit canvas stays `colorSpace: 'srgb'`. A managed document's explicit color output remains the 16-bit path below.

An explicit color output, including a managed document's PNG, is 16-bit and carries:

| Output | sRGB chunk | ICC | cICP primaries / transfer |
| --- | --- | --- | --- |
| `srgb` | yes, perceptual | sRGB | 1 / 13 |
| `srgb-linear` | no | linear sRGB | 1 / 8 |
| `display-p3` | no | Display P3 | 12 / 13 |
| `display-p3-linear` | no | linear P3 | 12 / 8 |
| `rec2020` and the other RGB outputs | no | matching profile when one exists | the H.273 codes in `encode_color_png` |

cICP follows PNG Third Edition. HDR outputs are not given an sRGB chunk. JPEG, WebP, TIFF, and bitmap PDF follow an sRGB or Display P3 PNG tag. Other 16-bit spaces stay PNG.

## JPEG, WebP, TIFF, and PDF

These encoders consume the PNG samples. They tag the space the PNG already declared:

- JPEG inserts an APP2 `ICC_PROFILE` segment (the canonical sRGB profile, or Display P3 when the PNG cICP says so) after a leading JFIF APP0, or after SOI when JFIF is absent. A JPEG that already has `ICC_PROFILE` is not given a second profile.
- WebP is lossless RGBA wrapped as `VP8X` + `ICCP` + the image chunk. The ICC flag is bit 5 (`0x20`). The alpha flag (`0x10`) is set only when a sample is not opaque. The profile matches the PNG tag.
- TIFF is a classic big-endian file (`MM 00 2A`, not BigTIFF). Samples are 8-bit chunky RGBA, Compression 1 (uncompressed), PhotometricInterpretation 2 (RGB), ExtraSamples 2 (unassociated / straight alpha), SampleFormat 1, Orientation 1, and 72 pixels per inch. Tag 34675 carries the same sRGB or Display P3 ICC profile as JPEG. 8-bit PNG samples are copied. 16-bit RGBA samples in sRGB or Display P3 quantize with `(v * 255 + 32767) / 65535` per channel, including alpha; that map is not a transfer curve. Linear, HDR, and any other cICP stay on PNG and are rejected instead of being labeled sRGB. The authored document is not modified.
- HEIC is not an encoder in this tree. A renamed PNG, an AVIF payload, or a `heic` brand without a decodable HEVC image is not an implementation. Requesting `heic` or `heif` fails before any bytes are returned. A system libheif 1.17 build with the x265 plugin can write a real `ftypheic` file, and libde265 can decode it, but only the lossless RGB 4:4:4 setting (`chroma=444`, matrix coefficients 0) kept every channel of a straight-alpha fixture. The default 4:2:0 path did not. x265 is GPL and is a system plugin. The export worker calls the WASM `transcode_export_png` entry, which does not link that plugin, so the panels do not offer HEIC.
- Bitmap PDF sets page `DefaultRGB` and the image `/ColorSpace` to one `/ICCBased` object (`/N 3`) for that same profile.
- Vector PDF does the same for `rg`/`RG` via `DefaultRGB`, and for shadings and RGB images via an explicit ICCBased array. DeviceGray and DeviceCMYK stay device spaces.
- An embedded JPEG that already carries an RGB ICC profile keeps that profile as its own ICCBased space. Untagged JPEG RGB is declared sRGB without re-encoding.
- A bitmap with a non-sRGB cICP or an ICC profile is converted to sRGB before the vector PDF embeds it. Untagged 8-bit samples are copied as bytes and then declared sRGB. HDR cICP fails the image instead of being labeled sRGB.

Display P3 is not the default PNG encoding. Choosing it on an unmanaged document converts the sRGB export and tags it. A managed document still uses the 16-bit color output. Other spaces, including linear P3 and HDR, stay on PNG. TIFF follows that same gate and then stores 8-bit samples.

## What is still open

- Figma Auto line height (the face's ascender, descender, and line gap) when the FIG value is omitted. The editor default remains the 1.35 multiplier.
- Half-leading. Extra line-box space stays below the baseline.
- Color glyphs (COLR, CBDT, sbix) and emoji not in the fallback face.
- Italic as a separate face. A style name that is only italic does not synthesize a slant.
- Per-run horizontal alignment, OpenType features, and variation axes. Those stay on the node style.
- No font download. Matching uses embedded bytes, the bundled Poppins faces, or a face the user loads.
