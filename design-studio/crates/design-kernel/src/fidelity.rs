use crate::{RenderOptions, View};
use serde::{Deserialize, Serialize};

pub const SAMPLE_OFFSETS: [(f64, f64); 4] = [
    (0.375, 0.125),
    (0.875, 0.375),
    (0.125, 0.625),
    (0.625, 0.875),
];

/// Layer-blur activation measured in actual Figma browser PNG exports at
/// 1x/2x/4x (figma-blur-threshold-2026-10-08.json). The Figma profile renders
/// at twice the final output density. This SDR observation does not change
/// the mathematical HDR filter, analytic Gaussian, shadow or backdrop blur.
pub(crate) fn layer_blur_active(
    radius: f64,
    profile: RasterProfile,
    managed: bool,
    interactive_effects: bool,
) -> bool {
    if radius <= 0. {
        return false;
    }
    (managed && !interactive_effects)
        || profile == RasterProfile::Analytic
        || radius >= if profile.is_export() { 1. } else { 0.5 }
}

// Fine coverage always retains correlated samples until compositing completes.
// The document's unrelated paints/effects must never choose a different
// quantization graph for existing pixels.
pub(crate) fn coherent_samples(doc: &crate::scene::Document, options: &RenderOptions) -> bool {
    options.raster_profile != RasterProfile::Analytic
        && !(doc.color_management.is_some() && options.interactive_effects)
}

pub(crate) fn has_backdrop(doc: &crate::scene::Document, options: &RenderOptions) -> bool {
    fn visit(doc: &crate::scene::Document, id: &str) -> bool {
        let n = &doc.nodes[id];
        n.visible
            && n.opacity > 0.
            && (n.backdrop_effect().is_some() || n.children.iter().any(|id| visit(doc, id)))
    }
    doc.pages
        .iter()
        .find(|p| p.id == options.page_id)
        .is_some_and(|p| p.children.iter().any(|id| visit(doc, id)))
}

/// Positive camera jitter has the inverse sign when evaluating a pixel in
/// node space. The export passes therefore consume SAMPLE_OFFSETS in this order.
const EXPORT_ORDER: [usize; 4] = [3, 0, 2, 1];

fn premultiplied_bytes(sample: &[u8], i: usize) -> [u32; 4] {
    let alpha = u32::from(sample[i + 3]);
    [
        (u32::from(sample[i]) * alpha + 127) / 255,
        (u32::from(sample[i + 1]) * alpha + 127) / 255,
        (u32::from(sample[i + 2]) * alpha + 127) / 255,
        alpha,
    ]
}
fn straight_bytes(value: [u8; 4]) -> [u8; 4] {
    crate::figma_sampling::unpremultiply_rgba8(value)
}
fn accumulate_export(previous: [u8; 4], source: [f32; 4], count: usize) -> [u8; 4] {
    let weight = (1.0_f64 / count as f64) as f32;
    std::array::from_fn(|c| {
        let old = crate::figma_sampling::normalize_q4(u32::from(previous[c]) * 16);
        let difference = source[c] - old;
        crate::figma_sampling::encode_unorm8(difference.mul_add(weight, old).clamp(0., 1.))
    })
}

pub fn resolve_sample_planes(samples: [&[u8]; 4]) -> Vec<u8> {
    assert!(samples.iter().all(|s| s.len() == samples[0].len()));
    let mut out = vec![0; samples[0].len()];
    for i in (0..out.len()).step_by(4) {
        let mut accumulated = [0_u8; 4];
        for (pass, index) in EXPORT_ORDER.into_iter().enumerate() {
            let source = premultiplied_bytes(samples[index], i)
                .map(|b| crate::figma_sampling::normalize_q4(b * 16));
            accumulated = accumulate_export(accumulated, source, pass + 1);
        }
        out[i..i + 4].copy_from_slice(&straight_bytes(accumulated));
    }
    out
}

// Each jitter pass is filtered directly into a running RGBA8 average. The
// sampled colour remains binary32 until its weighted blend; no RGBA8 temporary
// is inserted between spatial filtering and accumulation. This order matches
// complete official gradient/coverage exports and the independent numeric probes.
pub fn resolve_sample_planes_2x(samples: [&[u8]; 4], width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let mut accumulated = [0_u8; 4];
            for (pass, index) in EXPORT_ORDER.into_iter().enumerate() {
                let mut sum = [0_u32; 4];
                for dy in 0..2 {
                    for dx in 0..2 {
                        let i = ((y * 2 + dy) * width as usize * 2 + x * 2 + dx) * 4;
                        let value = premultiplied_bytes(samples[index], i);
                        for c in 0..4 {
                            sum[c] += value[c];
                        }
                    }
                }
                let source = sum.map(|v| crate::figma_sampling::normalize_q4(v * 4));
                accumulated = accumulate_export(accumulated, source, pass + 1);
            }
            let i = (y * width as usize + x) * 4;
            out[i..i + 4].copy_from_slice(&straight_bytes(accumulated));
        }
    }
    out
}

/// A 0/255 neighborhood is four equal coverage taps. Rounding each axis first
/// sends the two-and-two split to 127; one rounding of the four-tap mean is
/// 128, which is the code the measured export keeps after byte accumulation.
/// Other neighborhoods keep the separable byte filter.
fn software_binary_coverage_sample(pixels: [[u8; 4]; 4]) -> [u8; 4] {
    if pixels
        .iter()
        .all(|pixel| pixel.iter().all(|channel| *channel == 0 || *channel == 255))
    {
        return std::array::from_fn(|channel| {
            let sum = pixels
                .iter()
                .map(|pixel| u32::from(pixel[channel]))
                .sum::<u32>();
            ((sum + 2) / 4) as u8
        });
    }
    crate::software_raster::sample_bytes(pixels, 128, 128)
}

/// Same four jitter planes and 2x source density, with byte-precision
/// horizontal/vertical filtering and separately rounded UNORM blend terms.
/// This is an explicit arithmetic contract, not an adaptive quality mode.
pub fn resolve_software_sample_planes_2x(samples: [&[u8]; 4], width: u32, height: u32) -> Vec<u8> {
    assert!(
        samples
            .iter()
            .all(|s| s.len() == width as usize * height as usize * 16)
    );
    let mut out = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let mut accumulated = [0_u8; 4];
            for (pass, index) in EXPORT_ORDER.into_iter().enumerate() {
                let pixels = std::array::from_fn(|corner| {
                    let i = ((y * 2 + corner / 2) * width as usize * 2 + x * 2 + corner % 2) * 4;
                    premultiplied_bytes(samples[index], i).map(|v| v as u8)
                });
                let source = software_binary_coverage_sample(pixels);
                let factor =
                    crate::software_raster::encode_unorm8((1.0_f64 / (pass + 1) as f64) as f32);
                accumulated = crate::software_raster::blend_constant(accumulated, source, factor);
            }
            let i = (y * width as usize + x) * 4;
            out[i..i + 4].copy_from_slice(&crate::software_raster::straight_rgba8(accumulated));
        }
    }
    out
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RasterProfile {
    #[default]
    Analytic,
    Figma,
    FigmaSubpixel,
    /// Versioned software-raster export arithmetic. Explicit opt-in keeps
    /// existing documents' measured macOS/Metal output stable.
    FigmaSoftware,
}

impl RasterProfile {
    pub fn is_export(self) -> bool {
        matches!(self, Self::Figma | Self::FigmaSoftware)
    }

    pub fn is_software(self) -> bool {
        self == Self::FigmaSoftware
    }

    /// Stable identity for render instructions: two options with the same
    /// tag produce the same raster bytes for identical geometry, so tile
    /// residency may compare tags instead of the full profile value.
    pub fn tag(self) -> &'static str {
        match self {
            Self::Analytic => "analytic",
            Self::Figma => "figma",
            Self::FigmaSubpixel => "figmaSubpixel",
            Self::FigmaSoftware => "figmaSoftware",
        }
    }
}

pub fn source(
    options: &RenderOptions,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<RenderOptions, String> {
    if options.width == 0
        || options.height == 0
        || options.width > 8192
        || options.height > 8192
        || u64::from(options.width) * u64::from(options.height) > 8_388_608
        || !(0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
        || ![options.view.x, options.view.y]
            .iter()
            .all(|v| v.is_finite())
    {
        return Err("Invalid Figma raster options".into());
    }
    let width = width.checked_mul(2).ok_or("Sampling width overflow")?;
    let height = height.checked_mul(2).ok_or("Sampling height overflow")?;
    let zoom = options.view.zoom * 2.;
    if !zoom.is_finite() || zoom > crate::renderer::MAX_CANVAS_SAMPLE_SCALE {
        return Err("Figma sampling exceeds the device scale budget".into());
    }
    Ok(RenderOptions {
        page_id: options.page_id.clone(),
        width,
        height,
        view: View {
            x: (options.view.x - f64::from(x)) * 2.,
            y: (options.view.y - f64::from(y)) * 2.,
            zoom,
        },
        transparent: options.transparent,
        grid: options.grid,
        pixel_preview: None,
        animation: options.animation.clone(),
        interactive_effects: options.interactive_effects,
        checkerboard: options.checkerboard,
        raster_profile: if options.raster_profile.is_software() {
            RasterProfile::FigmaSoftware
        } else {
            RasterProfile::Figma
        },
    })
}

pub fn downsample(bytes: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let indices = [
                ((y * 2) * width as usize * 2 + x * 2) * 4,
                ((y * 2) * width as usize * 2 + x * 2 + 1) * 4,
                ((y * 2 + 1) * width as usize * 2 + x * 2) * 4,
                ((y * 2 + 1) * width as usize * 2 + x * 2 + 1) * 4,
            ];
            // Reconstruct the exact premultiplied UNORM8 bytes produced by
            // render_scene, then reproduce the normalized 2x texture filter.
            let mut sum = [0_u32; 4];
            for i in indices {
                let alpha = u32::from(bytes[i + 3]);
                for c in 0..3 {
                    sum[c] += (u32::from(bytes[i + c]) * alpha + 127) / 255;
                }
                sum[3] += alpha;
            }
            let resolved = sum.map(|v| u32::from(crate::figma_sampling::normalized_resolve_sum(v)));
            let dst = (y * width as usize + x) * 4;
            let alpha = resolved[3];
            if alpha > 0 {
                for c in 0..3 {
                    // Public PNGs use straight alpha; same half-up conversion
                    // as the GPU readback path, after resolving premultiplication.
                    out[dst + c] = ((resolved[c] * 255 * 2 + alpha) / (alpha * 2)).min(255) as u8;
                }
            }
            out[dst + 3] = alpha as u8;
        }
    }
    out
}
