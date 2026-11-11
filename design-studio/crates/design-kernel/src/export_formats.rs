//! Encoders consume the exact CPU PNG result. They never change live preview.
//! WebP is lossless RGBA; JPEG explicitly flattens to white at quality 100;
//! PDF embeds the raster at its authored size with a separate alpha mask.
//! TIFF is classic big-endian, 8-bit, uncompressed, chunky RGBA with
//! unassociated alpha and the same sRGB or Display P3 ICC profile.
//! JPEG, WebP, PDF and TIFF tag those samples. They do not leave DeviceRGB
//! or an untagged bitmap for a viewer to assign another profile.
//! HEIC is rejected: this build has no HEVC encoder, and a renamed PNG is not HEIC.
use image::ImageEncoder;

const MAX_PIXELS: u64 = 16_777_216;
const COLOR_TAG_ERROR: &str =
    "JPEG/WebP/PDF/TIFF can tag sRGB or Display P3. Export PNG for other color spaces.";

pub fn transcode(png: &[u8], format: &str, scale: f64) -> Result<Vec<u8>, String> {
    if png.len() > 64 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Expected bounded PNG input".into());
    }
    if !scale.is_finite() || !(0.001..=128.).contains(&scale) {
        return Err("Invalid export scale".into());
    }
    if matches!(format, "heic" | "heif") {
        return Err(
            "HEIC export is not available in this build: no HEVC encoder is linked, and a renamed PNG is not HEIC"
                .into(),
        );
    }
    if !matches!(format, "jpeg" | "webp" | "pdf" | "tiff") {
        return Err("Unsupported export encoder".into());
    }
    let space = tagged_space(png)?;
    let profile = match space {
        crate::color::ColorSpace::DisplayP3 => crate::export::display_p3_icc_profile()?,
        crate::color::ColorSpace::Srgb => crate::export::srgb_icc_profile()?,
        _ => return Err(COLOR_TAG_ERROR.into()),
    };
    if format == "tiff" {
        let (w, h, rgba) = png_straight_rgba8(png)?;
        return encode_baseline_tiff(&rgba, w, h, &profile);
    }
    let reader =
        image::ImageReader::with_format(std::io::Cursor::new(png), image::ImageFormat::Png);
    let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(
            "JPEG/WebP/PDF export exceeds 16 million pixels; choose a smaller export scale".into(),
        );
    }
    let rgba = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let mut bytes = Vec::new();
    match format {
        "webp" => {
            image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
                .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
                .map_err(|e| e.to_string())?;
            bytes = tag_webp_srgb(
                &bytes,
                w,
                h,
                &profile,
                rgba.chunks_exact(4).any(|p| p[3] != 255),
            )?;
        }
        "jpeg" => {
            let rgb: Vec<u8> = rgba
                .chunks_exact(4)
                .flat_map(|p| {
                    let a = u32::from(p[3]);
                    [p[0], p[1], p[2]]
                        .map(|c| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8)
                })
                .collect();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100)
                .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
                .map_err(|e| e.to_string())?;
            bytes = tag_jpeg_srgb(&bytes, &profile)?;
        }
        "pdf" => return pdf(&rgba, w, h, scale, &profile),
        _ => unreachable!(),
    }
    Ok(bytes)
}

/// sRGB when the PNG has an sRGB chunk or no cICP. Display P3 when cICP says
/// so. Other cICP values are refused instead of being labeled sRGB.
fn tagged_space(png: &[u8]) -> Result<crate::color::ColorSpace, String> {
    use crate::color::ColorSpace;
    let decoder = png::Decoder::new(std::io::Cursor::new(png));
    let reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    if let Some(code) = info.coding_independent_code_points {
        return match (code.color_primaries, code.transfer_function) {
            (12, 13) => Ok(ColorSpace::DisplayP3),
            (1, 13) => Ok(ColorSpace::Srgb),
            _ => Err(COLOR_TAG_ERROR.into()),
        };
    }
    Ok(ColorSpace::Srgb)
}

/// Insert an APP2 ICC profile after a leading JFIF APP0, otherwise immediately
/// after SOI. A file that already carries `ICC_PROFILE` is left unchanged.
fn tag_jpeg_srgb(jpeg: &[u8], icc: &[u8]) -> Result<Vec<u8>, String> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err("Expected JPEG".into());
    }
    if icc.is_empty() || icc.len() > 65519 {
        return Err("sRGB ICC profile is empty or does not fit in one JPEG segment".into());
    }
    if jpeg.windows(12).any(|window| window == b"ICC_PROFILE\0") {
        return Ok(jpeg.to_vec());
    }
    let mut at = 2;
    if jpeg.len() >= 6 && jpeg[2] == 0xFF && jpeg[3] == 0xE0 {
        let len = u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize;
        if len >= 2 && 4 + len <= jpeg.len() {
            at = 4 + len;
        }
    }
    let segment_len = 16 + icc.len();
    let mut segment = Vec::with_capacity(2 + segment_len);
    segment.extend_from_slice(&[0xFF, 0xE2]);
    segment.extend_from_slice(&(segment_len as u16).to_be_bytes());
    segment.extend_from_slice(b"ICC_PROFILE\0");
    segment.extend_from_slice(&[1, 1]);
    segment.extend_from_slice(icc);
    let mut out = Vec::with_capacity(jpeg.len() + segment.len());
    out.extend_from_slice(&jpeg[..at]);
    out.extend_from_slice(&segment);
    out.extend_from_slice(&jpeg[at..]);
    Ok(out)
}

fn riff_chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut chunk = Vec::with_capacity(8 + data.len() + data.len() % 2);
    chunk.extend_from_slice(tag);
    chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
    chunk.extend_from_slice(data);
    if data.len() % 2 == 1 {
        chunk.push(0);
    }
    chunk
}

/// Wrap a simple VP8/VP8L file as VP8X + ICCP, or set the ICC flag on an
/// existing VP8X chunk. Canvas size is the encoded image size.
fn tag_webp_srgb(
    webp: &[u8],
    width: u32,
    height: u32,
    icc: &[u8],
    alpha: bool,
) -> Result<Vec<u8>, String> {
    if webp.len() < 12 || &webp[..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        return Err("Expected WebP".into());
    }
    if !(1..=16_777_216).contains(&width) || !(1..=16_777_216).contains(&height) {
        return Err("WebP canvas is outside the 24-bit size".into());
    }
    if webp.windows(4).any(|window| window == b"ICCP") {
        return Ok(webp.to_vec());
    }
    let mut chunks = Vec::new();
    let mut at = 12;
    while at + 8 <= webp.len() {
        let tag: [u8; 4] = webp[at..at + 4].try_into().unwrap();
        let size = u32::from_le_bytes(webp[at + 4..at + 8].try_into().unwrap()) as usize;
        let end = at + 8 + size;
        if end > webp.len() {
            return Err("Truncated WebP chunk".into());
        }
        chunks.push((tag, webp[at + 8..end].to_vec()));
        at = end + (size % 2);
    }
    let mut flags = if alpha { 0x30 } else { 0x20 };
    let mut body = Vec::new();
    if let Some(index) = chunks.iter().position(|(tag, _)| tag == b"VP8X") {
        let existing = &chunks[index].1;
        if existing.is_empty() {
            return Err("VP8X chunk is empty".into());
        }
        flags |= existing[0];
        let mut payload = existing.clone();
        payload[0] = flags;
        body.extend(riff_chunk(b"VP8X", &payload));
        body.extend(riff_chunk(b"ICCP", icc));
        for (i, (tag, data)) in chunks.iter().enumerate() {
            if i != index {
                body.extend(riff_chunk(tag, data));
            }
        }
    } else {
        let mut canvas = [0_u8; 10];
        canvas[0] = flags;
        let width_m1 = width - 1;
        let height_m1 = height - 1;
        canvas[4] = width_m1 as u8;
        canvas[5] = (width_m1 >> 8) as u8;
        canvas[6] = (width_m1 >> 16) as u8;
        canvas[7] = height_m1 as u8;
        canvas[8] = (height_m1 >> 8) as u8;
        canvas[9] = (height_m1 >> 16) as u8;
        body.extend(riff_chunk(b"VP8X", &canvas));
        body.extend(riff_chunk(b"ICCP", icc));
        for (tag, data) in &chunks {
            body.extend(riff_chunk(tag, data));
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32 + 4).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend(body);
    Ok(out)
}

/// Straight 8-bit RGBA, or 16-bit RGBA quantized to 8-bit. No color transform:
/// the samples are already in the space `tagged_space` reported.
fn png_straight_rgba8(png: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (width, height, color_type, bit_depth, interlaced) = {
        let info = reader.info();
        (
            info.width,
            info.height,
            info.color_type,
            info.bit_depth,
            info.interlaced,
        )
    };
    if interlaced {
        return Err("TIFF export expects a non-interlaced PNG".into());
    }
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(
            "TIFF export exceeds 16 million pixels; choose a smaller export scale".into(),
        );
    }
    let size = reader
        .output_buffer_size()
        .ok_or("PNG frame has no output buffer")?;
    let mut buffer = vec![0; size];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(frame.buffer_size());
    let rgba = match (color_type, bit_depth) {
        (png::ColorType::Rgba, png::BitDepth::Eight) => buffer,
        (png::ColorType::Rgba, png::BitDepth::Sixteen) => quantize_be_u16(&buffer)?,
        _ => {
            return Err(
                "TIFF export expects 8-bit or 16-bit straight RGBA PNG samples".into(),
            )
        }
    };
    if rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err("TIFF RGBA sample count differs from PNG dimensions".into());
    }
    Ok((width, height, rgba))
}

/// Round a big-endian 16-bit sample to 8-bit: `(v * 255 + 32767) / 65535`.
/// Alpha is coverage and uses the same integer map, not a transfer curve.
fn quantize_be_u16(samples: &[u8]) -> Result<Vec<u8>, String> {
    if samples.len() % 2 != 0 {
        return Err("Truncated 16-bit PNG samples".into());
    }
    let mut out = Vec::with_capacity(samples.len() / 2);
    for pair in samples.chunks_exact(2) {
        let value = u16::from_be_bytes([pair[0], pair[1]]);
        out.push(((u32::from(value) * 255 + 32767) / 65535) as u8);
    }
    Ok(out)
}

/// Classic TIFF (not BigTIFF): big-endian `MM 00 2A`, one strip, Compression 1,
/// Photometric RGB, SamplesPerPixel 4, ExtraSamples 2 (unassociated alpha),
/// 8 bits, and an RGB ICC profile (tag 34675).
fn encode_baseline_tiff(
    rgba: &[u8],
    width: u32,
    height: u32,
    icc: &[u8],
) -> Result<Vec<u8>, String> {
    if icc.len() < 128 || &icc[36..40] != b"acsp" || &icc[16..20] != b"RGB " {
        return Err("TIFF ICC profile is missing or not an RGB profile".into());
    }
    if icc.len() > 8 * 1024 * 1024 {
        return Err("TIFF ICC profile is too large".into());
    }
    let pixel_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or("TIFF dimensions overflow")?;
    if pixel_count == 0 || pixel_count > MAX_PIXELS || pixel_count * 4 != rgba.len() as u64 {
        return Err("TIFF RGBA buffer does not match dimensions".into());
    }
    let mut bits_per_sample = Vec::with_capacity(8);
    for _ in 0..4 {
        bits_per_sample.extend_from_slice(&8u16.to_be_bytes());
    }
    let mut resolution = [0u8; 8];
    resolution[..4].copy_from_slice(&72u32.to_be_bytes());
    resolution[4..].copy_from_slice(&1u32.to_be_bytes());

    const ENTRIES: usize = 17;
    let ifd_bytes = 2 + ENTRIES * 12 + 4;
    let mut cursor = 8 + ifd_bytes;
    if cursor % 2 == 1 {
        cursor += 1;
    }
    let bits_at = cursor;
    cursor += bits_per_sample.len();
    let x_at = cursor;
    cursor += resolution.len();
    let y_at = cursor;
    cursor += resolution.len();
    if cursor % 2 == 1 {
        cursor += 1;
    }
    let icc_at = cursor;
    cursor += icc.len();
    if cursor % 2 == 1 {
        cursor += 1;
    }
    let strip_at = cursor;
    let end = cursor
        .checked_add(rgba.len())
        .ok_or("TIFF layout overflow")?;
    if strip_at > u32::MAX as usize || icc.len() > u32::MAX as usize {
        return Err("TIFF layout exceeds classic 32-bit offsets".into());
    }

    let short = |tag: u16, value: u16| -> [u8; 12] {
        let mut entry = [0u8; 12];
        entry[0..2].copy_from_slice(&tag.to_be_bytes());
        entry[2..4].copy_from_slice(&3u16.to_be_bytes());
        entry[4..8].copy_from_slice(&1u32.to_be_bytes());
        entry[8..10].copy_from_slice(&value.to_be_bytes());
        entry
    };
    let long = |tag: u16, value: u32| -> [u8; 12] {
        let mut entry = [0u8; 12];
        entry[0..2].copy_from_slice(&tag.to_be_bytes());
        entry[2..4].copy_from_slice(&4u16.to_be_bytes());
        entry[4..8].copy_from_slice(&1u32.to_be_bytes());
        entry[8..12].copy_from_slice(&value.to_be_bytes());
        entry
    };
    let pointed = |tag: u16, kind: u16, count: u32, at: usize| -> [u8; 12] {
        let mut entry = [0u8; 12];
        entry[0..2].copy_from_slice(&tag.to_be_bytes());
        entry[2..4].copy_from_slice(&kind.to_be_bytes());
        entry[4..8].copy_from_slice(&count.to_be_bytes());
        entry[8..12].copy_from_slice(&(at as u32).to_be_bytes());
        entry
    };
    let entries = [
        long(256, width),
        long(257, height),
        pointed(258, 3, 4, bits_at),
        short(259, 1),
        short(262, 2),
        long(273, strip_at as u32),
        short(274, 1),
        short(277, 4),
        long(278, height),
        long(279, rgba.len() as u32),
        pointed(282, 5, 1, x_at),
        pointed(283, 5, 1, y_at),
        short(284, 1),
        short(296, 2),
        short(338, 2),
        short(339, 1),
        pointed(34675, 7, icc.len() as u32, icc_at),
    ];
    let mut previous = 0u16;
    for entry in &entries {
        let tag = u16::from_be_bytes([entry[0], entry[1]]);
        if tag <= previous {
            return Err("TIFF tags must be sorted".into());
        }
        previous = tag;
    }

    let mut out = Vec::with_capacity(end);
    out.extend_from_slice(b"MM\x00\x2A");
    out.extend_from_slice(&8u32.to_be_bytes());
    out.extend_from_slice(&(ENTRIES as u16).to_be_bytes());
    for entry in entries {
        out.extend_from_slice(&entry);
    }
    out.extend_from_slice(&0u32.to_be_bytes());
    if out.len() != 8 + ifd_bytes {
        return Err("TIFF IFD size changed".into());
    }
    out.resize(bits_at, 0);
    out.extend_from_slice(&bits_per_sample);
    out.extend_from_slice(&resolution);
    out.extend_from_slice(&resolution);
    out.resize(icc_at, 0);
    out.extend_from_slice(icc);
    out.resize(strip_at, 0);
    out.extend_from_slice(rgba);
    if out.len() != end || &out[..4] != b"MM\x00\x2A" {
        return Err("TIFF file layout was not written".into());
    }
    Ok(out)
}

fn pdf(
    rgba: &[u8],
    width: u32,
    height: u32,
    scale: f64,
    profile: &[u8],
) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| p[..3].iter().copied())
        .collect();
    let alpha: Vec<u8> = rgba.chunks_exact(4).map(|p| p[3]).collect();
    let w = f64::from(width) / scale;
    let h = f64::from(height) / scale;
    // PDF 1.4 page dimensions are bounded in default user-space units.
    if w > 14400. || h > 14400. {
        return Err("PDF page exceeds 14400 points".into());
    }
    let stream = |dictionary: String, data: Vec<u8>| {
        let mut object =
            format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).into_bytes();
        object.extend(data);
        object.extend_from_slice(b"\nendstream");
        object
    };
    let icc = crate::export::pdf_icc_based_object(profile)?;
    let objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Resources << /ColorSpace << /DefaultRGB [/ICCBased 7 0 R] >> /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>").into_bytes(),
        stream(String::new(), format!("q {w} 0 0 {h} 0 0 cm /Im0 Do Q").into_bytes()),
        stream(format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace [/ICCBased 7 0 R] /BitsPerComponent 8 /Interpolate false /SMask 6 0 R /Filter /FlateDecode"), miniz_oxide::deflate::compress_to_vec_zlib(&rgb, 6)),
        stream(format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode"), miniz_oxide::deflate::compress_to_vec_zlib(&alpha, 6)),
        icc,
    ];
    let mut output = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.into_iter().enumerate() {
        offsets.push(output.len());
        output.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        output.extend(object);
        output.extend_from_slice(b"\nendobj\n");
    }
    let xref = output.len();
    output
        .extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoders_preserve_dimensions_alpha_and_pdf_physical_size() {
        let pixels = vec![255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 0, 20, 30, 40, 255];
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&pixels, 2, 2, image::ExtendedColorType::Rgba8)
            .unwrap();
        let webp = transcode(&png, "webp", 2.).unwrap();
        assert_eq!(
            image::load_from_memory(&webp).unwrap().to_rgba8().as_raw(),
            &pixels
        );
        let jpeg_bytes = transcode(&png, "jpeg", 2.).unwrap();
        assert!(jpeg_bytes
            .windows(12)
            .any(|window| window == b"ICC_PROFILE\0"));
        let jpeg = image::load_from_memory(&jpeg_bytes).unwrap().to_rgb8();
        assert_eq!(jpeg.dimensions(), (2, 2));
        assert!(
            jpeg.get_pixel(0, 1).0.iter().all(|&c| c >= 250),
            "transparent JPEG pixel becomes white"
        );
        let pdf = transcode(&png, "pdf", 2.).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 1 1]"));
        assert!(text.contains("/SMask 6 0 R"));
        assert!(text.contains("/DefaultRGB [/ICCBased 7 0 R]"));
        assert!(text.contains("/N 3 /Alternate /DeviceRGB"));
        assert!(webp.windows(4).any(|window| window == b"VP8X"));
        assert!(webp.windows(4).any(|window| window == b"ICCP"));
        assert!(transcode(&png, "jpeg", f64::NAN).is_err());
        assert!(transcode(&png, "fig", 1.).is_err());
        assert!(transcode(b"bad", "pdf", 1.).is_err());
    }

    #[test]
    fn tiff_is_big_endian_uncompressed_rgba_and_round_trips_exact_pixels() {
        let mut pixels = vec![0u8; 120 * 90 * 4];
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            pixel[0] = (index % 251) as u8;
            pixel[1] = ((index / 3) % 251) as u8;
            pixel[2] = ((index / 7) % 251) as u8;
            pixel[3] = if index % 11 == 0 { 0 } else { 200 };
        }
        let png = crate::export::encode_rgba(120, 90, &pixels).unwrap();
        assert!(png.windows(4).any(|window| window == b"sRGB"));
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let tiff = transcode(&png, "tiff", 1.).unwrap();
        assert_eq!(&tiff[..4], b"MM\x00\x2A");
        assert!(!tiff.starts_with(b"\x89PNG"));
        assert_ne!(tiff, png);
        let profile = crate::export::srgb_icc_profile().unwrap();
        assert_tiff_contract(&tiff, 120, 90, &pixels, &profile);
        let decoded = decode_tiff_crate(&tiff);
        assert_eq!(decoded, (120, 90, pixels));
        assert!(transcode(&tiff, "tiff", 1.).is_err(), "TIFF bytes are not a PNG");
        assert!(transcode(&png, "heic", 1.)
            .unwrap_err()
            .contains("HEIC"));
        assert!(transcode(&png, "heif", 2.).is_err());
        assert!(transcode(&png, "eps", 1.).is_err());
        if let Ok(path) = std::env::var("TIFF_FIXTURE") {
            std::fs::write(path, &tiff).unwrap();
        }
    }

    #[test]
    fn tiff_keeps_display_p3_samples_and_refuses_linear_and_sixteen_bit_mislabel() {
        let source = [10u8, 20, 30, 128, 255, 0, 0, 255];
        let png = crate::export::encode_tagged_rgba(
            2,
            1,
            &source,
            crate::color::ColorSpace::DisplayP3,
        )
        .unwrap();
        assert!(!png.windows(8).any(|window| window == [0, 0, 0, 1, b's', b'R', b'G', b'B']));
        let expected = png_samples(&png);
        assert_ne!(expected, source);
        let tiff = transcode(&png, "tiff", 2.).unwrap();
        let profile = crate::export::display_p3_icc_profile().unwrap();
        assert_tiff_contract(&tiff, 2, 1, &expected, &profile);
        assert_eq!(decode_tiff_crate(&tiff).2, expected);
        assert!(!tiff.windows(profile.len()).any(|window| {
            window == crate::export::srgb_icc_profile().unwrap().as_slice()
        }));

        let linear = crate::export::encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 1.)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput {
                space: crate::color::ColorSpace::LinearSrgb,
                tone_map: crate::color::ToneMap::Clip,
            },
        )
        .unwrap();
        let rejected = transcode(&linear, "tiff", 1.).unwrap_err();
        assert!(rejected.contains("sRGB") || rejected.contains("Display P3"), "{rejected}");
        assert!(!rejected.contains("MM"));

        let wide = crate::export::encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 0.5)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput::default(),
        )
        .unwrap();
        let raw = png_samples_raw(&wide);
        assert_eq!(raw.len(), 8, "16-bit RGBA is four big-endian channels");
        let mut quantized = Vec::new();
        for pair in raw.chunks_exact(2) {
            let value = u16::from_be_bytes([pair[0], pair[1]]);
            quantized.push(((u32::from(value) * 255 + 32767) / 65535) as u8);
        }
        let tiff = transcode(&wide, "tiff", 1.).unwrap();
        assert_eq!(&tiff[..4], b"MM\x00\x2A");
        assert_tiff_contract(
            &tiff,
            1,
            1,
            &quantized,
            &crate::export::srgb_icc_profile().unwrap(),
        );
        assert_eq!(decode_tiff_crate(&tiff).2, quantized);
        assert_ne!(quantized.len(), raw.len());
    }

    fn png_samples(png: &[u8]) -> Vec<u8> {
        let samples = png_samples_raw(png);
        assert_eq!(samples.len() % 4, 0);
        samples
    }

    fn png_samples_raw(png: &[u8]) -> Vec<u8> {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
        decoder.set_transformations(png::Transformations::IDENTITY);
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut buffer).unwrap();
        buffer.truncate(frame.buffer_size());
        buffer
    }

    fn assert_tiff_contract(bytes: &[u8], width: u32, height: u32, pixels: &[u8], icc: &[u8]) {
        assert_eq!(&bytes[..4], b"MM\x00\x2A");
        let ifd = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_be_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
        let mut tags = std::collections::BTreeMap::new();
        let mut previous = 0u16;
        for index in 0..count {
            let at = ifd + 2 + index * 12;
            let tag = u16::from_be_bytes(bytes[at..at + 2].try_into().unwrap());
            assert!(tag > previous, "IFD tags are sorted");
            previous = tag;
            let kind = u16::from_be_bytes(bytes[at + 2..at + 4].try_into().unwrap());
            let n = u32::from_be_bytes(bytes[at + 4..at + 8].try_into().unwrap());
            let raw = bytes[at + 8..at + 12].to_vec();
            tags.insert(tag, (kind, n, raw));
        }
        assert_eq!(
            u32::from_be_bytes(bytes[ifd + 2 + count * 12..ifd + 6 + count * 12].try_into().unwrap()),
            0
        );
        let value = |tag: u16| -> Vec<u8> {
            let (kind, n, raw) = &tags[&tag];
            let unit = match *kind {
                3 => 2,
                4 => 4,
                5 => 8,
                7 => 1,
                other => panic!("tag {tag} type {other}"),
            };
            let len = unit * *n as usize;
            if len <= 4 {
                raw[..len].to_vec()
            } else {
                let offset = u32::from_be_bytes(raw.as_slice().try_into().unwrap()) as usize;
                bytes[offset..offset + len].to_vec()
            }
        };
        let short = |tag: u16| u16::from_be_bytes(value(tag).as_slice().try_into().unwrap());
        let long = |tag: u16| u32::from_be_bytes(value(tag).as_slice().try_into().unwrap());
        assert_eq!(long(256), width);
        assert_eq!(long(257), height);
        assert_eq!(value(258), [0, 8, 0, 8, 0, 8, 0, 8]);
        assert_eq!(short(259), 1, "uncompressed");
        assert_eq!(short(262), 2, "RGB");
        assert_eq!(short(274), 1, "top-left");
        assert_eq!(short(277), 4);
        assert_eq!(long(278), height);
        assert_eq!(long(279), pixels.len() as u32);
        assert_eq!(short(284), 1, "chunky");
        assert_eq!(short(296), 2, "inch");
        assert_eq!(short(338), 2, "unassociated alpha");
        assert_eq!(short(339), 1, "unsigned integer");
        assert_eq!(value(282), 72u32.to_be_bytes().into_iter().chain(1u32.to_be_bytes()).collect::<Vec<_>>());
        assert_eq!(value(283), value(282));
        assert_eq!(value(34675), icc);
        let strip = long(273) as usize;
        assert_eq!(&bytes[strip..strip + pixels.len()], pixels);
    }

    fn decode_tiff_crate(bytes: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(bytes)).unwrap();
        let (width, height) = decoder.dimensions().unwrap();
        assert_eq!(
            decoder.colortype().unwrap(),
            tiff::ColorType::RGBA(8)
        );
        match decoder.read_image().unwrap() {
            tiff::decoder::DecodingResult::U8(samples) => (width, height, samples),
            _ => panic!("TIFF decoder did not return 8-bit samples"),
        }
    }
}
