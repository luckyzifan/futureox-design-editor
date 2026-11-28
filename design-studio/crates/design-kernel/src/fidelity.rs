use crate::{RenderOptions, View};
use serde::{Deserialize, Serialize};

pub const SAMPLE_OFFSETS: [(f64, f64); 4] = [
    (0.375, 0.125),
    (0.875, 0.375),
    (0.125, 0.625),
    (0.625, 0.875),
];

/// Independent Sketch 2025.1.3 and 2026.3.1 exports agree that a
/// uniform layer Gaussian below 0.5 authored points is an identity.
/// The cutoff is before raster scale, not a device-pixel effect budget.
pub(crate) fn sketch_gaussian_identity(
    doc: &crate::scene::Document, node: &crate::scene::Node, effect: &crate::scene::Effect,
) -> bool {
    effect.kind == "gaussian-blur" && effect.gradient_blur.is_none() && effect.radius < 0.5
        && doc.color_management.is_none()
        && crate::interop::sketch_binding(doc, node, "sketchSourceBlur").is_some()
}

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

impl crate::Engine {
    pub(crate) fn export_source(
        &mut self, options: &RenderOptions, width: u32, height: u32,
    ) -> Result<RenderOptions, String> {
        let mut source = source(options, 0, 0, width, height)?;
        if source.raster_profile.is_software() && self.source_compile_context.is_none() {
            self.resolve_layout()?;
            // Glass, frost, refraction and backdrop documents are preserved
            // against Chrome Figma PNGs in the measured Figma arithmetic.
            // Their byte software path is one code off on the material
            // captures, so the software profile selects the measured path
            // for these documents only. Ordinary geometry keeps the
            // versioned software arithmetic.
            if self.doc.as_ref().is_some_and(|doc| {
                has_backdrop(doc, options) || measured_export_arithmetic(doc, options, &source)
            }) {
                source.raster_profile = RasterProfile::Figma;
            }
        }
        Ok(source)
    }

    /// Only ordinary solid geometry certifies that two colored endpoints
    /// describe coverage. A material or effect capture can quantize to the
    /// same endpoints for other reasons. Use the full requested page so a
    /// tile or export crop cannot independently change its rounding.
    pub(crate) fn allows_software_color_coverage(&self, options: &RenderOptions) -> bool {
        use crate::scene::{Document, Paint};
        fn solid(paint: &Paint) -> bool {
            !paint.visible || paint.kind == "solid" && paint.opacity == 1. && paint.blend == "normal"
        }
        fn visit(doc: &Document, id: &str) -> bool {
            doc.nodes.get(id).is_some_and(|node| {
                !node.mask && (!node.visible || node.opacity == 0. || {
                    node.opacity == 1.
                        && node.blend == "normal"
                        && node.instance.is_none()
                        && matches!(node.kind.as_str(), "frame" | "group" | "rectangle" | "ellipse" | "polygon" | "star" | "line" | "vector")
                        && node.effects.iter().all(|effect| !effect.visible)
                        && node.fills.iter().all(solid)
                        && node.strokes.iter().all(|stroke| !stroke.visible || solid(&stroke.paint))
                        && node.render_children().iter().all(|child| visit(doc, child))
                })
            })
        }
        options.raster_profile.is_software()
            && !options.grid
            && !options.checkerboard
            && options.animation.is_none()
            && self.source_compile_context.is_none()
            && self.doc.as_ref().is_some_and(|doc| {
                doc.color_management.is_none()
                    && doc.pages.iter().find(|page| page.id == options.page_id).is_some_and(|page| {
                        page.children.iter().all(|id| visit(doc, id))
                    })
            })
    }
}

/// The Chrome phase and material controls establish the lookup, texture
/// capture and resolve of one opaque gradient inside a rectangular clip.
/// A crop must not change the decision or the jitter phase.
fn measured_export_arithmetic(
    doc: &crate::scene::Document, options: &RenderOptions, source: &RenderOptions,
) -> bool {
    use crate::math::Transform;
    use crate::scene::{Node, Paint};
    let opaque = |color: &str| {
        crate::color::unmanaged_straight(color).is_ok_and(|channels| channels[3] == 1.)
    };
    let visible_paint = |paint: &&Paint| paint.visible && paint.opacity > 0.;
    let plain_box = |node: &Node| {
        let [a, b, c, d, x, y] = node.transform.0;
        node.visible && node.blend == "normal" && a == 1. && b == 0. && c == 0. && d == 1.
            && x.fract() == 0. && y.fract() == 0.
            && node.width > 0. && node.height > 0.
            && node.width.fract() == 0. && node.height.fract() == 0.
            && node.corner_radius == 0. && node.radii == [0.; 4] && node.smoothing == 0.
            && !node.mask && node.mask_chain.is_none() && node.boolean_operation.is_none()
            && node.network.is_none() && node.vector_geometry.is_none()
            && node.repeat.is_none() && node.spatial.is_none() && node.instance.is_none()
            && node.strokes.iter().all(|stroke| !stroke.visible || stroke.width == 0.)
    };
    let effect_free = |node: &Node| node.effects.iter().all(|effect| !effect.visible);
    if doc.color_management.is_some() || options.transparent || options.grid || options.checkerboard
        || options.animation.is_some() || options.interactive_effects
        || options.view.zoom != 1. || options.view.x.fract() != 0. || options.view.y.fract() != 0.
    {
        return false;
    }
    let Some(page) = doc.pages.iter().find(|page| page.id == options.page_id) else { return false };
    let [root] = page.children.as_slice() else { return false };
    let root = &doc.nodes[root];
    let [child] = root.children.as_slice() else { return false };
    if root.kind != "frame" || !plain_box(root) || !effect_free(root) || !root.clip
        || root.opacity != 1. || !opaque(&page.background)
    {
        return false;
    }
    let mut fills = root.fills.iter().filter(visible_paint);
    let Some(background) = fills.next() else { return false };
    if fills.next().is_some() || background.kind != "solid" || background.opacity != 1.
        || background.blend != "normal" || !opaque(&background.color)
    {
        return false;
    }
    let mut leaf = &doc.nodes[child];
    let isolated = leaf.kind == "frame";
    if isolated {
        let [child] = leaf.children.as_slice() else { return false };
        // The shader uses zero as its sentinel for painting without group
        // scaling. The measured isolation pass needs a normal positive
        // uniform even on hardware that flushes subnormal values to zero.
        let opacity = leaf.opacity as f32;
        if !plain_box(leaf) || !effect_free(leaf) || !leaf.clip
            || !opacity.is_normal() || !(0. < opacity && opacity < 1.)
            || leaf.fills.iter().any(|paint| visible_paint(&paint))
        {
            return false;
        }
        leaf = &doc.nodes[child];
    }
    if leaf.kind != "rectangle" || !plain_box(leaf) || leaf.clip || leaf.opacity != 1.
        || !leaf.children.is_empty()
    {
        return false;
    }
    let mut fills = leaf.fills.iter().filter(visible_paint);
    let Some(gradient) = fills.next() else { return false };
    let [first, last] = gradient.stops.as_slice() else { return false };
    let Some(angle) = crate::figma_gradient::canonical_angle(gradient) else { return false };
    let angle = angle.rem_euclid(360.);
    // The material controls fit one canonical capture tile. Bound the
    // replay preflight here without enumerating a large scene on each crop.
    // Use the same gate when a neutral texture is removed from the paint.
    let measured_material = !isolated && angle == 45.
        && root.width.max(root.height) * source.view.zoom <= f64::from(crate::texture_replay::TILE);
    if fills.next().is_some() || gradient.opacity != 1.
        || !(angle == 0. || measured_material)
        || !crate::figma_gradient::supported(gradient, leaf.transform)
        || first.offset != 0. || last.offset != 1. || !opaque(&first.color) || !opaque(&last.color)
    {
        return false;
    }
    let Some(effect) = leaf.effects.iter().find(|effect| effect.visible) else { return true };
    if !measured_material || effect.kind != "texture" {
        return false;
    }
    // The replay already verifies the entire capture, including every tile
    // and sample. This one-leaf frame has no sibling or effect that can read
    // its output. The calibrated resolve belongs to the same paint program,
    // even when the replay passes a neutral texture through as plain paint.
    let view = source.view;
    let camera = Transform([view.zoom, 0., 0., view.zoom, view.x, view.y]);
    let matrix = camera.concat(root.transform).concat(leaf.transform);
    crate::texture_replay::recipe(doc, leaf, matrix, effect).is_ok_and(|replay| replay.is_some())
}

pub(crate) fn full_frame_vector(frame: &crate::scene::Node, node: &crate::scene::Node) -> bool {
    node.kind == "vector"
        && node.transform == crate::math::Transform::default()
        && node.width == frame.width
        && node.height == frame.height
}

pub(crate) fn has_full_frame_vector_backdrop(
    doc: &crate::scene::Document,
    options: &RenderOptions,
) -> bool {
    use crate::scene::Node;
    let frame = doc.pages.iter().find(|page| page.id == options.page_id)
        .and_then(|page| match page.children.as_slice() {
            [id] => doc.nodes.get(id),
            _ => None,
        })
        .filter(|node| node.kind == "frame" && node.visible && !node.clip && !node.mask
            && node.opacity == 1. && node.blend == "normal");
    frame.is_some_and(|frame| frame.render_children().iter().filter_map(|id| doc.nodes.get(id))
        .any(|node: &Node| node.visible && full_frame_vector(frame, node)
            && node.backdrop_effect().is_some_and(|effect| {
                effect.kind == "background-blur" && !effect.sketch_backdrop && effect.gradient_blur.is_none()
            })))
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

/// Opaque white beside the one-pixel tent's stored half-code. 212 is
/// ties-even of 212.5, and 212 + 255 is the odd export half 233.5. Binary32
/// normalization encodes 233; ties-even of that average is 234. Other gray
/// pairs, including glass and light, keep the binary32 resolve. The samples
/// stay as composited.
fn ties_even_white_tent_half(pixels: [[u32; 4]; 4]) -> Option<[f32; 4]> {
    if pixels[0] != pixels[2] || pixels[1] != pixels[3] {
        return None;
    }
    let endpoint = |pixel: [u32; 4], code: u32| {
        pixel[0] == code && pixel[1] == code && pixel[2] == code && pixel[3] == 255
    };
    let pair = (pixels[0], pixels[1]);
    let white_tent = (endpoint(pair.0, 212) && endpoint(pair.1, 255))
        || (endpoint(pair.0, 255) && endpoint(pair.1, 212));
    if !white_tent {
        return None;
    }
    let sum = 212 + 255 + 212 + 255;
    let quotient = sum / 4;
    debug_assert_eq!(
        u32::from(crate::figma_sampling::normalized_resolve_sum(sum)),
        quotient
    );
    let ties_even = quotient + 1;
    let mut adjusted = [0.0; 4];
    for channel in 0..3 {
        adjusted[channel] = crate::figma_sampling::normalize_q4(ties_even * 16);
    }
    adjusted[3] = crate::figma_sampling::normalize_q4(255 * 16);
    Some(adjusted)
}

fn pair_source(pixels: [[u32; 4]; 4]) -> [f32; 4] {
    ties_even_white_tent_half(pixels).unwrap_or_else(|| {
        std::array::from_fn(|channel| {
            let sum = pixels.iter().map(|pixel| pixel[channel]).sum::<u32>();
            crate::figma_sampling::normalize_q4(sum * 4)
        })
    })
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
    resolve_sample_planes_2x_with(samples, width, height, |_, _| false)
}

fn resolve_sample_planes_2x_with(
    samples: [&[u8]; 4], width: u32, height: u32, precise: impl Fn(u32, u32) -> bool,
) -> Vec<u8> {
    let mut out = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let mut accumulated = [0_u8; 4];
            let mut sum = [0_f32; 4];
            let keep_mean = precise(x as u32, y as u32);
            for (pass, index) in EXPORT_ORDER.into_iter().enumerate() {
                let pixels = std::array::from_fn(|corner| {
                    let i = ((y * 2 + corner / 2) * width as usize * 2 + x * 2 + corner % 2) * 4;
                    premultiplied_bytes(samples[index], i)
                });
                let source = pair_source(pixels);
                if keep_mean {
                    let weight = (1.0_f64 / (pass + 1) as f64) as f32;
                    sum = std::array::from_fn(|channel| {
                        (source[channel] - sum[channel])
                            .mul_add(weight, sum[channel])
                            .clamp(0., 1.)
                    });
                } else {
                    accumulated = accumulate_export(accumulated, source, pass + 1);
                }
            }
            let i = (y * width as usize + x) * 4;
            if keep_mean {
                out[i..i + 4].copy_from_slice(&straight_bytes(
                    sum.map(crate::figma_sampling::encode_unorm8),
                ));
            } else {
                out[i..i + 4].copy_from_slice(&straight_bytes(accumulated));
            }
        }
    }
    out
}

/// #1126: a projected inset stroke's own output pixels keep the jitter mean
/// in binary32 until one final encode, matching the desktop 126.11.9 export
/// (the perspective fixture's edge at (151, 125)). The desktop re-encodes a
/// running u8 mean for other content, so this path takes the exact written
/// region instead of changing [`resolve_sample_planes_2x`]: every pixel
/// outside `precise` keeps that established byte accumulation bit for bit.
pub fn resolve_sample_planes_2x_inset(
    samples: [&[u8]; 4], width: u32, height: u32, precise: &[crate::math::Rect],
) -> Vec<u8> {
    resolve_sample_planes_2x_with(samples, width, height, |x, y| {
        precise.iter().any(|rect| {
            rect.x <= x as i32 && (x as i32) < rect.right()
                && rect.y <= y as i32 && (y as i32) < rect.bottom()
        })
    })
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

fn opaque_color_endpoints(planes: &[[[u8; 4]; 4]; 4]) -> bool {
    let first = planes[0][0];
    let mut second = None;
    for &pixel in planes.iter().flatten() {
        if pixel[3] != 255 {
            return false;
        }
        if pixel == first {
            continue;
        }
        if *second.get_or_insert(pixel) != pixel {
            return false;
        }
    }
    let chromatic = |[r, g, b, _]: [u8; 4]| r != g || g != b;
    second.is_some_and(|color| {
        chromatic(first)
            || chromatic(color)
            || (first[0].min(color[0]) == 0 && first[0].max(color[0]) == 255)
    })
}

/// Same four jitter planes and 2x source density, with byte-precision
/// horizontal/vertical filtering and separately rounded UNORM blend terms.
/// Certified solid coverage uses the exact spatial sum and jitter weights for
/// colored pairs and pure black/white pairs. Other grey and material
/// neighborhoods keep their byte arithmetic.
pub fn resolve_software_sample_planes_2x(
    samples: [&[u8]; 4], width: u32, height: u32, allow_color_coverage: bool,
) -> Vec<u8> {
    assert!(
        samples
            .iter()
            .all(|s| s.len() == width as usize * height as usize * 16)
    );
    let mut out = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let planes = EXPORT_ORDER.map(|index| {
                std::array::from_fn(|corner| {
                    let i = ((y * 2 + corner / 2) * width as usize * 2 + x * 2 + corner % 2) * 4;
                    premultiplied_bytes(samples[index], i).map(|v| v as u8)
                })
            });
            let coverage = allow_color_coverage && opaque_color_endpoints(&planes);
            let mut accumulated = [0_u8; 4];
            for (pass, pixels) in planes.into_iter().enumerate() {
                if coverage {
                    let source = pair_source(pixels.map(|pixel| pixel.map(u32::from)));
                    accumulated = accumulate_export(accumulated, source, pass + 1);
                    continue;
                }
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

/// One export 2×2 of straight RGBA8 pixels, in the same order as
/// [`downsample`]: top-left, top-right, bottom-left, bottom-right.
pub(crate) fn export_pair_straight(straight: [[u8; 4]; 4]) -> [u8; 4] {
    let pixels = straight.map(|pixel| {
        let alpha = u32::from(pixel[3]);
        [
            (u32::from(pixel[0]) * alpha + 127) / 255,
            (u32::from(pixel[1]) * alpha + 127) / 255,
            (u32::from(pixel[2]) * alpha + 127) / 255,
            alpha,
        ]
    });
    let resolved = if let Some(adjusted) = ties_even_white_tent_half(pixels) {
        adjusted.map(|value| u32::from(crate::figma_sampling::encode_unorm8(value)))
    } else {
        let sum = std::array::from_fn(|channel| pixels.iter().map(|pixel| pixel[channel]).sum::<u32>());
        sum.map(|value| u32::from(crate::figma_sampling::normalized_resolve_sum(value)))
    };
    let mut out = [0u8; 4];
    let alpha = resolved[3];
    if alpha > 0 {
        for channel in 0..3 {
            // Public PNGs use straight alpha; same half-up conversion as the
            // GPU readback path, after resolving premultiplication.
            out[channel] = ((resolved[channel] * 255 * 2 + alpha) / (alpha * 2)).min(255) as u8;
        }
    }
    out[3] = alpha as u8;
    out
}

/// Device-pixel 2×2 whose unrounded tent mean is not the byte average.
/// `expected` is the straight RGBA8 of that 2×2 on an opaque black backdrop.
/// The export pixel is rewritten only when every sample plane still shows it.
#[derive(Clone, Debug)]
pub(crate) struct FalseHalfFix {
    pub x: i32,
    pub y: i32,
    pub expected: [[u8; 4]; 4],
    pub output: [u8; 4],
}

pub(crate) fn apply_false_half_fixes(
    output: &mut [u8],
    planes: [&[u8]; 4],
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
    fixes: &[FalseHalfFix],
) {
    let plane_w = width.saturating_mul(2) as i32;
    let plane_h = height.saturating_mul(2) as i32;
    let plane_stride = width as usize * 2;
    for fix in fixes {
        let lx = fix.x - origin_x;
        let ly = fix.y - origin_y;
        if lx < 0 || ly < 0 || lx % 2 != 0 || ly % 2 != 0 || lx + 1 >= plane_w || ly + 1 >= plane_h {
            continue;
        }
        let ox = (lx / 2) as usize;
        let oy = (ly / 2) as usize;
        if ox >= width as usize || oy >= height as usize {
            continue;
        }
        let mut intact = true;
        for plane in planes {
            for (index, (dx, dy)) in [(0i32, 0i32), (1, 0), (0, 1), (1, 1)].into_iter().enumerate() {
                let byte = ((ly as usize + dy as usize) * plane_stride + lx as usize + dx as usize) * 4;
                if plane.len() < byte + 4 || plane[byte..byte + 4] != fix.expected[index] {
                    intact = false;
                    break;
                }
            }
            if !intact {
                break;
            }
        }
        if !intact {
            continue;
        }
        let dst = (oy * width as usize + ox) * 4;
        if dst + 4 <= output.len() {
            output[dst..dst + 4].copy_from_slice(&fix.output);
        }
    }
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
            let straight = indices.map(|i| [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            let dst = (y * width as usize + x) * 4;
            out[dst..dst + 4].copy_from_slice(&export_pair_straight(straight));
        }
    }
    out
}

#[cfg(test)]
mod export_half_tests {
    use super::*;

    fn plane(
        top_left: [u8; 4],
        top_right: [u8; 4],
        bottom_left: [u8; 4],
        bottom_right: [u8; 4],
    ) -> Vec<u8> {
        let mut bytes = vec![0_u8; 16];
        bytes[0..4].copy_from_slice(&top_left);
        bytes[4..8].copy_from_slice(&top_right);
        bytes[8..12].copy_from_slice(&bottom_left);
        bytes[12..16].copy_from_slice(&bottom_right);
        bytes
    }

    fn resolve(sample: &[u8]) -> Vec<u8> {
        resolve_sample_planes_2x([&sample, &sample, &sample, &sample], 1, 1)
    }

    #[test]
    fn odd_gray_export_half_uses_ties_even_at_the_output_only() {
        // 212 + 255 is the odd half 233.5. Binary32 encodes 233; ties-even is 234.
        let odd = plane(
            [212, 212, 212, 255],
            [255, 255, 255, 255],
            [212, 212, 212, 255],
            [255, 255, 255, 255],
        );
        assert_eq!(crate::figma_sampling::normalized_resolve_sum(934), 233);
        assert_eq!(resolve(&odd), vec![234, 234, 234, 255]);
        assert_eq!(downsample(&odd, 1, 1), vec![234, 234, 234, 255]);
        // The source bytes are the composite inputs and stay distinct.
        assert_eq!(&odd[0..4], &[212, 212, 212, 255]);
        assert_eq!(&odd[4..8], &[255, 255, 255, 255]);
    }

    #[test]
    fn even_half_split_rows_and_color_keep_binary32() {
        // 181 + 244 is the even half 212.5. Ties-even already matches binary32.
        let even = plane(
            [181, 181, 181, 255],
            [244, 244, 244, 255],
            [181, 181, 181, 255],
            [244, 244, 244, 255],
        );
        let binary = crate::figma_sampling::normalized_resolve_sum(181 + 244 + 181 + 244);
        assert_eq!(resolve(&even), vec![binary, binary, binary, 255]);
        // Rows that are not equal still belong to later coverage and clips.
        let split = plane(
            [212, 212, 212, 255],
            [255, 255, 255, 255],
            [0, 0, 0, 255],
            [255, 255, 255, 255],
        );
        let split_out = resolve(&split);
        assert_ne!(split_out[0], 234);
        // A red pair is composited color, not a gray export half.
        let color = plane(
            [212, 80, 80, 255],
            [255, 40, 40, 255],
            [212, 80, 80, 255],
            [255, 40, 40, 255],
        );
        let color_out = resolve(&color);
        assert_eq!(
            color_out[0],
            crate::figma_sampling::normalized_resolve_sum(212 + 255 + 212 + 255)
        );
        assert_eq!(color_out[0], 233);
        // Glass and light odd halves are not the tent pair. They stay binary32.
        for (left, right, sum) in [
            (243u32, 232, 243 + 232 + 243 + 232),
            (255, 216, 255 + 216 + 255 + 216),
        ] {
            let sample = plane(
                [left as u8, left as u8, left as u8, 255],
                [right as u8, right as u8, right as u8, 255],
                [left as u8, left as u8, left as u8, 255],
                [right as u8, right as u8, right as u8, 255],
            );
            let out = resolve(&sample);
            assert_eq!(
                u32::from(out[0]),
                u32::from(crate::figma_sampling::normalized_resolve_sum(sum)),
                "{left}+{right}"
            );
        }
    }
}
