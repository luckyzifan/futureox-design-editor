//! Native-resolution PNG rows for GPU uploads without a complete float image.
//! Source dimensions/encoded length are not cache-capacity quotas. The upload
//! destination still checks the actual device's dimensions and residency.
use crate::{blend::Pixel, color::{ColorSettings, ColorSpace}, image_color};
use base64::Engine as _;
use std::io::Cursor;

pub const ROW_PIXELS: usize = 262_144; // at most 4 MiB returned RGBA32F
pub struct Decoder {
    reader: png::Reader<Cursor<Vec<u8>>>, settings: ColorSettings,
    space: Option<ColorSpace>, profile: Option<Vec<u8>>,
    width: u32, height: u32, row: u32, color: png::ColorType, depth: png::BitDepth, failed: bool,
}
impl Decoder {
    pub fn new(uri: &str, settings: ColorSettings) -> Result<Self, String> {
        settings.validate()?;
        let data = uri.strip_prefix("data:image/png;base64,").ok_or("Row decoding requires PNG")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "Invalid image data")?;
        let space = image_color::png_space(&bytes)?;
        let (profile, orientation) = {
            // Metadata inspection does not allocate a full decoded surface.
            // A whole-image allocation allowance must not reject row streaming.
            let mut decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes.as_slice()), image::Limits::no_limits()).map_err(|e| e.to_string())?;
            let profile = if space.is_none() { image_color::icc(&mut decoder)? } else { None };
            (profile, image_color::orientation(&mut decoder)?)
        };
        if orientation != image::metadata::Orientation::NoTransforms {
            return Err("PNG row decoding requires unrotated source pixels".into());
        }
        let mut png = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: usize::MAX });
        // Match image::PngDecoder: palette/tRNS/low-bit gray expansion, no 16-bit stripping.
        png.set_transformations(png::Transformations::EXPAND);
        let reader = png.read_info().map_err(|e| e.to_string())?;
        let info = reader.info(); let (width, height) = (info.width, info.height);
        if width == 0 || height == 0 || (width as usize).checked_mul(4 * std::mem::size_of::<f32>()).is_none() {
            return Err("PNG row source dimensions are not addressable".into());
        }
        if info.interlaced || info.animation_control.is_some() {
            return Err("PNG row decoding requires a noninterlaced still image".into());
        }
        let (color, depth) = reader.output_color_type();
        if !matches!(depth, png::BitDepth::Eight | png::BitDepth::Sixteen) || color == png::ColorType::Indexed {
            return Err("PNG rows require expanded 8-bit or 16-bit channels".into());
        }
        Ok(Self { reader, settings, space, profile, width, height, row: 0, color, depth, failed: false })
    }
    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }
    pub fn next_rows(&mut self) -> Result<Vec<f32>, String> {
        if self.failed { return Err("PNG row decoder failed".into()); }
        if self.row == self.height { return Ok(Vec::new()); }
        let result = self.read_rows(); if result.is_err() { self.failed = true; } result
    }
    fn read_rows(&mut self) -> Result<Vec<f32>, String> {
        let height = (ROW_PIXELS / self.width as usize).max(1).min((self.height - self.row) as usize) as u32;
        let sample_bytes = if self.depth == png::BitDepth::Sixteen { 2 } else { 1 };
        let stride = (self.width as usize).checked_mul(self.color.samples()).and_then(|n| n.checked_mul(sample_bytes)).ok_or("PNG row byte overflow")?;
        let count = stride.checked_mul(height as usize).ok_or("PNG strip byte overflow")?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(count).map_err(|e| format!("Cannot allocate PNG strip: {e}"))?;
        for _ in 0..height {
            let row = self.reader.next_row().map_err(|e| e.to_string())?.ok_or("Truncated PNG rows")?;
            if row.data().len() != stride { return Err("Unexpected PNG row width".into()); }
            bytes.extend_from_slice(row.data());
        }
        // Same integer-to-float conversion, color transform and premultiplication
        // as the complete decoder. None of these operations crosses a row boundary.
        let decoded = if self.depth == png::BitDepth::Sixteen {
            // PNG scanline samples are big endian. Preserve all source bits;
            // DynamicImage performs exactly the full decoder's float conversion.
            let mut words = Vec::new(); words.try_reserve_exact(bytes.len()/2).map_err(|e| e.to_string())?;
            words.extend(bytes.chunks_exact(2).map(|b|u16::from_be_bytes([b[0],b[1]])));
            match self.color {
                png::ColorType::Grayscale => image::DynamicImage::ImageLuma16(image::ImageBuffer::from_raw(self.width, height, words).unwrap()),
                png::ColorType::GrayscaleAlpha => image::DynamicImage::ImageLumaA16(image::ImageBuffer::from_raw(self.width, height, words).unwrap()),
                png::ColorType::Rgb => image::DynamicImage::ImageRgb16(image::ImageBuffer::from_raw(self.width, height, words).unwrap()),
                png::ColorType::Rgba => image::DynamicImage::ImageRgba16(image::ImageBuffer::from_raw(self.width, height, words).unwrap()),
                _ => return Err("Unsupported PNG row channels".into()),
            }
        } else { match self.color {
            png::ColorType::Grayscale => image::DynamicImage::ImageLuma8(image::ImageBuffer::from_raw(self.width, height, bytes).unwrap()),
            png::ColorType::GrayscaleAlpha => image::DynamicImage::ImageLumaA8(image::ImageBuffer::from_raw(self.width, height, bytes).unwrap()),
            png::ColorType::Rgb => image::DynamicImage::ImageRgb8(image::ImageBuffer::from_raw(self.width, height, bytes).unwrap()),
            png::ColorType::Rgba => image::DynamicImage::ImageRgba8(image::ImageBuffer::from_raw(self.width, height, bytes).unwrap()),
            _ => return Err("Unsupported PNG row channels".into()),
        }};
        let mut image = decoded.into_rgba32f();
        image_color::to_working(&mut image, self.settings, self.space, self.profile.as_deref())?;
        for p in image.pixels_mut() { p.0 = Pixel::rgba(p[0], p[1], p[2], p[3]).0; }
        self.row += height;
        // A bad trailing chunk rejects the last strip; the uploader must destroy
        // its unpublished partial texture, never certify an incomplete asset.
        if self.row == self.height { self.reader.finish().map_err(|e| e.to_string())?; }
        Ok(image.into_raw())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn uri(width: u32, height: u32, color: png::ColorType) -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(color); encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let data: Vec<_> = (0..width as usize * height as usize * color.samples()).map(|i| ((i * 19 + 3) % 256) as u8).collect();
            writer.write_image_data(&data).unwrap();
        }
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    #[test]
    fn streamed_rows_match_full_native_color_and_premultiplication_bits() {
        for color in [png::ColorType::Grayscale, png::ColorType::GrayscaleAlpha, png::ColorType::Rgb, png::ColorType::Rgba] {
            let data = uri(1025, 513, color);
            for space in [ColorSpace::Srgb, ColorSpace::DisplayP3] {
                let settings = ColorSettings { document_space: space, reference_white_nits: 203., peak_luminance_nits: 1000. };
                let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
                let expected = images.image(&data).unwrap();
                let mut rows = Decoder::new(&data, settings).unwrap(); let mut actual = Vec::new();
                loop { let part = rows.next_rows().unwrap(); if part.is_empty() { break; } assert!(part.len() <= ROW_PIXELS * 4); actual.extend(part); }
                let expected: Vec<_> = expected.pixels.iter().flat_map(|p| p.0).map(f32::to_bits).collect();
                assert_eq!(actual.into_iter().map(f32::to_bits).collect::<Vec<_>>(), expected);
            }
        }
    }
    #[test]
    fn large_image_stream_keeps_full_dimensions_without_lifting_full_decode_guard() {
        let data = uri(4096, 2304, png::ColorType::Rgba);
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
        assert!(images.image(&data).err().unwrap().contains("Decoded image budget exceeded"));
        let mut decoder = Decoder::new(&data, settings).unwrap(); let mut pixels = 0;
        loop { let part = decoder.next_rows().unwrap(); if part.is_empty() { break; } assert!(part.len() <= ROW_PIXELS * 4); pixels += part.len() / 4; }
        assert_eq!(pixels, 4096 * 2304);
    }
    #[test]
    fn encoded_payload_over_twelve_mib_is_a_stream_not_an_admission_failure() {
        let mut encoded = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut encoded, 3072, 1024);
            encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::NoCompression);
            encoder.write_header().unwrap().write_image_data(&[127, 63, 31, 255].repeat(3072 * 1024)).unwrap();
        }
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded));
        assert!(data.len() > 12 * 1024 * 1024);
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut decoder = Decoder::new(&data, settings).unwrap(); let mut count = 0;
        loop {
            let strip = decoder.next_rows().unwrap(); if strip.is_empty() { break; }
            assert!(strip.len() <= ROW_PIXELS * 4);
            assert!(strip.chunks_exact(4).all(|p|p[0]>p[1]&&p[1]>p[2]&&p[2]>0.&&p[3]==1.));
            count += strip.len()/4;
        }
        assert_eq!(count, 3072 * 1024);
    }
    #[test]
    fn sixteen_bit_rows_keep_original_channel_and_alpha_precision() {
        for color in [png::ColorType::Grayscale, png::ColorType::GrayscaleAlpha, png::ColorType::Rgb, png::ColorType::Rgba] {
            let mut encoded = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut encoded, 1025, 257);
                encoder.set_color(color); encoder.set_depth(png::BitDepth::Sixteen);
                let data: Vec<_> = (0..1025 * 257 * color.samples()).flat_map(|i| ((i * 19 + 3) as u16).to_be_bytes()).collect();
                encoder.write_header().unwrap().write_image_data(&data).unwrap();
            }
            let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded));
            let settings = ColorSettings { document_space: ColorSpace::DisplayP3, reference_white_nits: 203., peak_luminance_nits: 1000. };
            let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
            let reference = images.image(&data).unwrap();
            let mut decoder = Decoder::new(&data, settings).unwrap(); let mut offset = 0;
            loop {
                let strip = decoder.next_rows().unwrap(); if strip.is_empty() { break; }
                for (actual, expected) in strip.chunks_exact(4).zip(&reference.pixels[offset..]) {
                    assert_eq!(actual.iter().map(|n|n.to_bits()).collect::<Vec<_>>(), expected.0.map(f32::to_bits));
                }
                offset += strip.len()/4;
            }
            assert_eq!(offset, reference.pixels.len());
        }
    }
    #[test]
    fn row_stream_has_no_whole_image_pixel_or_8192_dimension_quota() {
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
        let reference = images.image(&uri(256, 1, png::ColorType::Grayscale)).unwrap();
        for (width, height) in [(17, 8193), (4097, 4096)] {
            let data = uri(width, height, png::ColorType::Grayscale);
            let mut decoder = Decoder::new(&data, settings).unwrap();
            assert_eq!((decoder.width(), decoder.height()), (width, height));
            let mut count = 0;
            loop {
                let strip = decoder.next_rows().unwrap();
                if strip.is_empty() { break; }
                assert!(strip.len() <= ROW_PIXELS * 4);
                // The source generator is deterministic, so verify every
                // decoded pixel across strip boundaries without a full image.
                for pixel in strip.chunks_exact(4) {
                    for (actual, expected) in pixel.iter().zip(reference.pixels[count % 256].0) {
                        assert_eq!(actual.to_bits(), expected.to_bits());
                    }
                    count += 1;
                }
            }
            assert_eq!(count, width as usize * height as usize);
        }
    }
    #[test]
    fn truncated_source_never_returns_a_successful_final_strip() {
        let original = uri(3, 3, png::ColorType::Rgba);
        let mut bytes = base64::engine::general_purpose::STANDARD.decode(original.split_once(',').unwrap().1).unwrap();
        bytes.truncate(bytes.len() - 9);
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut decoder = Decoder::new(&data, settings).unwrap();
        assert!(decoder.next_rows().is_err());
        assert!(decoder.next_rows().is_err());
    }
}
