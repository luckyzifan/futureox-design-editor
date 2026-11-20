//! Bitmap profiles are decoded once in Rust for every rendering backend.
//! PNG cICP takes precedence over ICC per PNG 3. ICC transforms use moxcms;
//! unsupported source models fail rather than being mislabeled as sRGB.
use crate::blend::Pixel;
use crate::color::{srgb_encode, ColorSettings, ColorSpace};
use image::{ImageDecoder, Rgba32FImage};

pub fn png_space(bytes: &[u8]) -> Result<Option<ColorSpace>, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(None);
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 8 * 1024 * 1024,
    });
    let reader = decoder
        .read_info()
        .map_err(|e| format!("PNG color metadata: {e}"))?;
    let Some(c) = reader.info().coding_independent_code_points else {
        return Ok(None);
    };
    if c.matrix_coefficients != 0 || !c.is_video_full_range_image {
        return Err("Only full-range RGB PNG cICP is supported".into());
    }
    let space = match (c.color_primaries, c.transfer_function) {
        (1, 13) => ColorSpace::Srgb,
        (1, 8) => ColorSpace::LinearSrgb,
        (12, 13) => ColorSpace::DisplayP3,
        (12, 8) => ColorSpace::LinearP3,
        (9, 14 | 15) => ColorSpace::Rec2020,
        (9, 8) => ColorSpace::LinearRec2020,
        (9, 16) => ColorSpace::Pq,
        (9, 18) => ColorSpace::Hlg,
        _ => {
            return Err(format!(
                "Unsupported PNG cICP primaries/transfer {}/{}",
                c.color_primaries, c.transfer_function
            ));
        }
    };
    Ok(Some(space))
}
pub fn icc(decoder: &mut impl ImageDecoder) -> Result<Option<Vec<u8>>, String> {
    let icc = decoder
        .icc_profile()
        .map_err(|e| format!("Image ICC metadata: {e}"))?;
    if icc.as_ref().is_some_and(|p| p.len() > 4 * 1024 * 1024) {
        return Err("ICC profile exceeds 4 MiB".into());
    }
    Ok(icc)
}
/// Validate the primary TIFF directory instead of image's permissive
/// `orientation()` fallback: invalid EXIF must not silently become identity.
/// Unrelated tags, their payloads and thumbnail/sub-IFDs remain opaque.
pub fn orientation(
    decoder: &mut impl ImageDecoder,
) -> Result<image::metadata::Orientation, String> {
    match decoder
        .exif_metadata()
        .map_err(|e| format!("Image EXIF metadata: {e}"))?
    {
        Some(bytes) => exif_orientation(&bytes),
        None => Ok(image::metadata::Orientation::NoTransforms),
    }
}
pub(crate) fn exif_orientation(bytes: &[u8]) -> Result<image::metadata::Orientation, String> {
    use image::metadata::Orientation;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Image EXIF metadata exceeds 4 MiB".into());
    }
    let bytes = bytes.strip_prefix(b"Exif\0\0").unwrap_or(bytes);
    let little = match bytes.get(..4) {
        Some(b"II\x2a\0") => true,
        Some(b"MM\0\x2a") => false,
        _ => return Err("Invalid EXIF TIFF header".into()),
    };
    let u16_at = |at: usize| -> Result<u16, String> {
        let raw: [u8; 2] = bytes
            .get(at..at + 2)
            .ok_or("Truncated EXIF directory")?
            .try_into()
            .unwrap();
        Ok(if little {
            u16::from_le_bytes(raw)
        } else {
            u16::from_be_bytes(raw)
        })
    };
    let u32_at = |at: usize| -> Result<u32, String> {
        let raw: [u8; 4] = bytes
            .get(at..at + 4)
            .ok_or("Truncated EXIF directory")?
            .try_into()
            .unwrap();
        Ok(if little {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        })
    };
    let offset = u32_at(4)? as usize;
    // A null first-IFD pointer denotes no directory, hence no orientation.
    if offset == 0 {
        return Ok(Orientation::NoTransforms);
    }
    if offset < 8 || offset > bytes.len().saturating_sub(2) {
        return Err("Invalid EXIF primary directory offset".into());
    }
    let count = usize::from(u16_at(offset)?);
    // count is u16 and offset has been bounded above; no unbounded allocation,
    // recursion, or out-of-file entry access. The final four bytes are next IFD.
    let end = offset + 2 + count * 12 + 4;
    if end > bytes.len() {
        return Err("Truncated EXIF primary directory".into());
    }
    let mut orientation = None;
    for i in 0..count {
        let at = offset + 2 + i * 12;
        if u16_at(at)? != 0x0112 {
            continue;
        }
        if u16_at(at + 2)? != 3 || u32_at(at + 4)? != 1 {
            return Err("Invalid EXIF orientation type or count".into());
        }
        let value = u16_at(at + 8)?;
        let current = u8::try_from(value)
            .ok()
            .and_then(Orientation::from_exif)
            .ok_or("Invalid EXIF orientation value (expected 1 through 8)")?;
        if orientation.is_some_and(|previous| previous != current) {
            return Err("Conflicting EXIF orientation values".into());
        }
        orientation = Some(current);
    }
    Ok(orientation.unwrap_or(Orientation::NoTransforms))
}

/// Immutable source colour policy plus reusable per-row transform scratch.
/// One instance belongs to one decoder; no profile or global cache authority
/// is inferred from an image name or a document-controlled identifier.
pub(crate) struct WorkingTransform {
    settings: ColorSettings,
    space: ColorSpace,
    icc: Option<std::sync::Arc<moxcms::TransformF32Executor>>,
    row: Vec<f32>,
}
#[cfg(test)]
std::thread_local! { static ICC_PREPARATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn icc_preparations() -> usize { ICC_PREPARATIONS.with(std::cell::Cell::get) }
fn prepare_icc(icc: &[u8]) -> Result<std::sync::Arc<moxcms::TransformF32Executor>, String> {
    #[cfg(test)] ICC_PREPARATIONS.with(|n|n.set(n.get()+1));
        use moxcms::{
            ColorProfile, DataColorSpace, Layout, ParsingOptions, ToneReprCurve, TransformOptions,
        };
        let source = ColorProfile::new_from_slice_with_options(
            icc,
            ParsingOptions {
                max_profile_size: 4 * 1024 * 1024,
                max_allowed_clut_size: 4 * 1024 * 1024,
                max_allowed_trc_size: 40000,
            },
        )
        .map_err(|e| format!("Invalid ICC profile: {e}"))?;
        if source.color_space != DataColorSpace::Rgb {
            return Err("ICC source must be RGB; CMYK/Gray need a matching decoder layout".into());
        }
        if source.cicp.is_some_and(|c| {
            matches!(
                c.transfer_characteristics,
                moxcms::TransferCharacteristics::Smpte2084 | moxcms::TransferCharacteristics::Hlg
            )
        }) {
            return Err(
                "HDR ICC luminance normalization is not defined; import a cICP-tagged PQ/HLG PNG"
                    .into(),
            );
        }
        let mut target = ColorProfile::new_srgb();
        let linear = Some(ToneReprCurve::Parametric(vec![1.]));
        target.red_trc = linear.clone();
        target.green_trc = linear.clone();
        target.blue_trc = linear;
        target.cicp = None;
        let transform = source
            .create_transform_f32(
                Layout::Rgba,
                &target,
                Layout::Rgba,
                TransformOptions {
                    prefer_fixed_point: false,
                    allow_extended_range_rgb_xyz: true,
                    ..Default::default()
                },
            )
            .map_err(|e| format!("Unsupported ICC transform: {e}"))?;
        Ok(transform)
}
impl WorkingTransform {
    pub(crate) fn new(settings: ColorSettings, space: Option<ColorSpace>, icc: Option<&[u8]>) -> Result<Self, String> {
        let transform = if space.is_none() { icc.map(prepare_icc).transpose()? } else { None };
        Ok(Self { settings, space: space.unwrap_or(ColorSpace::Srgb), icc: transform, row: Vec::new() })
    }
    pub(crate) fn apply(&mut self, image: &mut Rgba32FImage) -> Result<(), String> {
        if let Some(transform) = &self.icc {
            let stride = image.width() as usize * 4;
            self.row.resize(stride, 0.);
            for pixels in image.as_mut().chunks_exact_mut(stride) {
                transform.transform(pixels, &mut self.row).map_err(|e|e.to_string())?;
                pixels.copy_from_slice(&self.row);
            }
            if self.settings.uses_encoded_p3() {
                for p in image.pixels_mut() {
                    let rgb = self.settings.linear_srgb_to_working([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])]);
                    p.0[..3].copy_from_slice(&rgb.map(|c| c as f32));
                }
            }
        } else {
            for p in image.pixels_mut() {
                let rgb = self.settings.to_working([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])], self.space);
                for i in 0..3 { p[i] = rgb[i] as f32; }
            }
        }
        if image.as_raw().iter().any(|v| !v.is_finite() || v.abs() > 65504.) {
            return Err("Decoded image exceeds finite float16 color range".into());
        }
        Ok(())
    }
}
pub fn to_working(image: &mut Rgba32FImage, settings: ColorSettings, space: Option<ColorSpace>, icc: Option<&[u8]>) -> Result<(), String> {
    WorkingTransform::new(settings, space, icc)?.apply(image)
}

#[cfg(test)]
#[path="image_color_prepared_tests.rs"]
mod prepared_tests;

pub(crate) fn to_sdr_working(
    image: &mut Rgba32FImage,
    space: Option<ColorSpace>,
    icc: Option<&[u8]>,
) -> Result<(), String> {
    if matches!(space, Some(ColorSpace::Pq | ColorSpace::Hlg)) {
        return Err("HDR bitmap requires a color-managed document; source bytes retained".into());
    }
    to_working(image, ColorSettings::default(), space, icc)
}

/// Tagged bitmaps in an SDR document still require a source-profile transform.
/// Reuse the managed decoder, then encode the sRGB destination before the
/// existing RGBA8 storage boundary. Source asset bytes remain untouched.
pub fn to_sdr(
    image: &mut Rgba32FImage,
    space: Option<ColorSpace>,
    icc: Option<&[u8]>,
) -> Result<(), String> {
    to_sdr_working(image, space, icc)?;
    let settings = ColorSettings::default();
    for pixel in image.pixels_mut() {
        let rgb = settings.from_working(
            [
                f64::from(pixel[0]),
                f64::from(pixel[1]),
                f64::from(pixel[2]),
            ],
            ColorSpace::Srgb,
        );
        for channel in 0..3 {
            pixel[channel] = rgb[channel].clamp(0.0, 1.0) as f32;
        }
    }
    Ok(())
}

/// Store encoded sRGB bytes in the renderer's premultiplied RGBA8 surface.
/// The divisor 255 is odd, so an exact byte product cannot land on a half tie.
#[inline]
pub(crate) fn premultiplied_srgb8([r, g, b, alpha]: [u8; 4]) -> Pixel {
    let alpha = u16::from(alpha);
    let premultiply = |channel| f32::from((u16::from(channel) * alpha + 127) / 255) / 255.;
    Pixel([premultiply(r), premultiply(g), premultiply(b), f32::from(alpha) / 255.])
}

fn encode_sdr_channel(linear: f32) -> f32 {
    srgb_encode(f64::from(linear)).clamp(0., 1.) as f32
}

/// Exact legacy SDR storage quantization for opaque source pixels. Each
/// threshold is the first representable f32 whose encoded, cast, scaled and
/// ties-to-even rounded value enters the next byte. The coarse table only
/// bounds the lookup; it never approximates the transfer or the rounding.
pub(crate) struct SdrStorage {
    thresholds: [f32; 255],
    coarse: [u8; 4096],
}

impl SdrStorage {
    pub(crate) fn shared() -> &'static Self {
        static LOOKUP: std::sync::OnceLock<SdrStorage> = std::sync::OnceLock::new();
        LOOKUP.get_or_init(|| {
            let thresholds = std::array::from_fn(|i| {
                let code = (i + 1) as f32;
                let mut low = 0u32;
                let mut high = 1f32.to_bits();
                while low < high {
                    let middle = low + (high - low) / 2;
                    let quantized =
                        (encode_sdr_channel(f32::from_bits(middle)) * 255.).round_ties_even();
                    if quantized < code {
                        low = middle + 1;
                    } else {
                        high = middle;
                    }
                }
                f32::from_bits(low)
            });
            let coarse = std::array::from_fn(|i| {
                thresholds.partition_point(|&threshold| threshold <= i as f32 / 4096.) as u8
            });
            Self { thresholds, coarse }
        })
    }

    fn channel(&self, linear: f32) -> f32 {
        if linear == 0. {
            return linear; // Retain the existing signed-zero storage boundary.
        }
        if linear < 0. {
            return 0.;
        }
        if linear >= 1. {
            return 1.;
        }
        if linear.is_nan() {
            return (encode_sdr_channel(linear) * 255.).round_ties_even() / 255.;
        }
        // Scaling a finite f32 by a power of two gives its exact coarse cell.
        let mut code = self.coarse[(linear * 4096.) as usize] as usize;
        while code < self.thresholds.len() && self.thresholds[code] <= linear {
            code += 1;
        }
        code as f32 / 255.
    }

    pub(crate) fn pixel(&self, [r, g, b, a]: [f32; 4]) -> Pixel {
        if a == 1. {
            Pixel([self.channel(r), self.channel(g), self.channel(b), a])
        } else {
            Pixel::rgba(encode_sdr_channel(r), encode_sdr_channel(g), encode_sdr_channel(b), a)
                .rgba8_quantized()
        }
    }
}

#[cfg(test)]
mod sdr_storage_tests {
    use super::{encode_sdr_channel, premultiplied_srgb8, to_sdr_working, ColorSpace, Pixel, SdrStorage};

    fn verify_pixel(samples: [f32; 4]) {
        let [r, g, b, a] = samples;
        let reference =
            Pixel::rgba(encode_sdr_channel(r), encode_sdr_channel(g), encode_sdr_channel(b), a)
                .rgba8_quantized();
        assert_eq!(
            SdrStorage::shared().pixel(samples).0.map(f32::to_bits),
            reference.0.map(f32::to_bits),
            "{samples:?}"
        );
    }

    #[test]
    fn byte_storage_matches_both_legacy_srgb_paths_for_every_alpha() {
        let bytes = image::RgbaImage::from_fn(256, 256, |channel, alpha| {
            let channel = channel as u8;
            image::Rgba([channel, 255 - channel, channel.rotate_left(3), alpha as u8])
        });
        let encoded = image::DynamicImage::ImageRgba8(bytes.clone()).into_rgba32f();
        let mut linear = encoded.clone();
        to_sdr_working(&mut linear, Some(ColorSpace::Srgb), None).unwrap();
        for ((bytes, encoded), linear) in bytes.pixels().zip(encoded.pixels()).zip(linear.pixels()) {
            let [r, g, b, a] = encoded.0;
            let actual = premultiplied_srgb8(bytes.0).0.map(f32::to_bits);
            assert_eq!(actual, Pixel::rgba(r, g, b, a).rgba8_quantized().0.map(f32::to_bits));
            assert_eq!(actual, SdrStorage::shared().pixel(linear.0).0.map(f32::to_bits));
        }
    }

    #[test]
    fn opaque_sdr_lookup_preserves_thresholds_cells_and_alpha_boundaries() {
        for &threshold in &SdrStorage::shared().thresholds {
            let bits = threshold.to_bits();
            verify_pixel([f32::from_bits(bits - 1), threshold, f32::from_bits(bits + 1), 1.]);
        }
        for i in 0..=4096 {
            let value = i as f32 / 4096.;
            let bits = value.to_bits();
            verify_pixel([f32::from_bits(bits.saturating_sub(1)), value, f32::from_bits(bits + 1), 1.]);
        }
        let mut bits = 1u32;
        for _ in 0..65_536 {
            bits = bits.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let linear = f32::from_bits(bits % 1f32.to_bits());
            verify_pixel([linear, -linear, 1. - linear, 1.]);
        }
        for a in [0., 0.1, 0.5, 0.999, 1.] {
            verify_pixel([-0., 0.003_130_8, 1.25, a]);
        }
    }
}

#[cfg(test)]
mod exif_tests {
    use super::exif_orientation;
    use image::metadata::Orientation;
    fn tiff(little: bool, entries: &[(u16, u16, u32, u16)]) -> Vec<u8> {
        let mut bytes = if little {
            b"II\x2a\0\x08\0\0\0".to_vec()
        } else {
            b"MM\0\x2a\0\0\0\x08".to_vec()
        };
        fn short(out: &mut Vec<u8>, v: u16, little: bool) {
            out.extend(if little {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            });
        }
        fn long(out: &mut Vec<u8>, v: u32, little: bool) {
            out.extend(if little {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            });
        }
        short(&mut bytes, entries.len() as u16, little);
        for &(tag, kind, count, value) in entries {
            short(&mut bytes, tag, little);
            short(&mut bytes, kind, little);
            long(&mut bytes, count, little);
            short(&mut bytes, value, little);
            short(&mut bytes, 0, little);
        }
        long(&mut bytes, 0, little);
        bytes
    }
    #[test]
    fn primary_orientation_both_endians_and_opaque_unrelated_tags() {
        for little in [false, true] {
            for value in 1..=8 {
                let data = tiff(
                    little,
                    &[(0xc001, 0xffff, u32::MAX, 0xffff), (0x112, 3, 1, value)],
                );
                assert_eq!(
                    exif_orientation(&data).unwrap(),
                    Orientation::from_exif(value as u8).unwrap()
                );
            }
            assert_eq!(
                exif_orientation(&tiff(little, &[])).unwrap(),
                Orientation::NoTransforms
            );
            assert_eq!(
                exif_orientation(&tiff(little, &[(0xc001, 0xffff, u32::MAX, 0xffff)])).unwrap(),
                Orientation::NoTransforms
            );
        }
    }
    #[test]
    fn invalid_primary_orientation_is_rejected_without_identity_fallback() {
        for entry in [
            (0x112, 3, 1, 0),
            (0x112, 3, 1, 9),
            (0x112, 4, 1, 1),
            (0x112, 3, 2, 1),
        ] {
            assert!(exif_orientation(&tiff(false, &[entry])).is_err());
        }
        assert!(exif_orientation(&tiff(true, &[(0x112, 3, 1, 6), (0x112, 3, 1, 7)])).is_err());
        let valid = tiff(false, &[(0x112, 3, 1, 6)]);
        for end in 0..valid.len() {
            assert!(exif_orientation(&valid[..end]).is_err());
        }
        let mut invalid = valid;
        invalid[3] = 43;
        assert!(exif_orientation(&invalid).is_err());
        assert!(exif_orientation(&[0; 4 * 1024 * 1024 + 1]).is_err());
    }
}
