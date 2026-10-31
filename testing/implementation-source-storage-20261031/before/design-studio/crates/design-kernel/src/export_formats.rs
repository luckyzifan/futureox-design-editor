//! Encoders consume the exact CPU PNG result. They never change live preview.
//! WebP is lossless RGBA; JPEG explicitly flattens to white at quality 100;
//! PDF embeds the raster at its authored size with a separate alpha mask.
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
    let mut bytes = Vec::new();
    match format {
        "webp" => image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
            .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?,
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
        }
        "pdf" => return pdf(&rgba, w, h, scale),
        _ => unreachable!(),
    }
    Ok(bytes)
}

fn pdf(rgba: &[u8], width: u32, height: u32, scale: f64) -> Result<Vec<u8>, String> {
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
    let objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>").into_bytes(),
        stream(String::new(), format!("q {w} 0 0 {h} 0 0 cm /Im0 Do Q").into_bytes()),
        stream(format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /SMask 6 0 R /Filter /FlateDecode"), miniz_oxide::deflate::compress_to_vec_zlib(&rgb, 6)),
        stream(format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode"), miniz_oxide::deflate::compress_to_vec_zlib(&alpha, 6)),
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
        let jpeg = transcode(&png, "jpeg", 2.).unwrap();
        let jpeg = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(jpeg.dimensions(), (2, 2));
        assert!(
            jpeg.get_pixel(0, 1).0.iter().all(|&c| c >= 250),
            "transparent JPEG pixel becomes white"
        );
        let pdf = transcode(&png, "pdf", 2.).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(String::from_utf8_lossy(&pdf).contains("/MediaBox [0 0 1 1]"));
        assert!(String::from_utf8_lossy(&pdf).contains("/SMask 6 0 R"));
        assert!(transcode(&png, "jpeg", f64::NAN).is_err());
        assert!(transcode(&png, "fig", 1.).is_err());
        assert!(transcode(b"bad", "pdf", 1.).is_err());
    }
}
