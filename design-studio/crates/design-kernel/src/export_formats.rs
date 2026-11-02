//! Encoders consume the exact CPU PNG result. They never change live preview.
//! WebP is lossless RGBA; JPEG explicitly flattens to white at quality 100;
//! PDF embeds the raster at its authored size with a separate alpha mask.
//! JPEG, WebP and PDF tag those sRGB samples. They do not leave DeviceRGB
//! or an untagged bitmap for a viewer to assign another profile.
use image::ImageEncoder;

const MAX_PIXELS: u64 = 16_777_216;

pub fn transcode(png: &[u8], format: &str, scale: f64) -> Result<Vec<u8>, String> {
    if png.len() > 64 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Expected bounded PNG input".into());
    }
    if !scale.is_finite() || !(0.001..=128.).contains(&scale) {
        return Err("Invalid export scale".into());
    }
    if !matches!(format, "jpeg" | "webp" | "pdf") {
        return Err("Unsupported export encoder".into());
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
    let profile = crate::export::srgb_icc_profile()?;
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
}
