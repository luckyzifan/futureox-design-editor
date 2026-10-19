use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::{Document, Node, Paint},
};
use base64::Engine;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
#[derive(Clone, Default)]
pub struct Images {
    cache: HashMap<String, CachedImage>,
    pixels: usize,
    settings: Option<crate::color::ColorSettings>,
    mips: bool,
}
/// Decoded asset plus its lazily materialized mip chain: `chain[i]` is level
/// `i + 1`. The chain shares the admission budget with the base so residency
/// stays bounded, and generation is deterministic per decode. Clone shares
/// the decoded bytes through Arc — the seam parallel tile rasterisation uses
/// to hand every worker the same asset residency.
#[derive(Clone)]
struct CachedImage {
    base: Arc<Surface>,
    chain: Vec<Arc<Surface>>,
}
impl CachedImage {
    fn resident_pixels(&self) -> usize {
        self.base.rect.pixels() + self.chain.iter().map(|l| l.rect.pixels()).sum::<usize>()
    }
}
impl Images {
    /// Keep only assets still authored by the next accepted document. Include
    /// latent component overrides, shared styles and animation poses: resolving
    /// a different mode/frame must not force unchanged images to decode again.
    pub fn retain_document(&mut self, doc: &Document) {
        if self.cache.is_empty() {
            return;
        }
        fn paints<'a>(out: &mut HashSet<&'a str>, values: impl Iterator<Item = &'a Paint>) {
            for p in values {
                if p.kind == "image"
                    && let Some(uri) = &p.image
                {
                    out.insert(uri);
                }
            }
        }
        fn json_paints<'a>(
            out: &mut HashSet<&'a str>,
            value: &'a serde_json::Value,
            strokes: bool,
        ) {
            if let Some(items) = value.as_array() {
                for value in items {
                    let p = if strokes { &value["paint"] } else { value };
                    if p["kind"] == "image"
                        && let Some(uri) = p["image"].as_str()
                    {
                        out.insert(uri);
                    }
                }
            }
        }
        let mut referenced = HashSet::new();
        for n in doc.nodes.values() {
            paints(
                &mut referenced,
                n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint)),
            );
            if let Some(instance) = &n.instance {
                for fields in instance.overrides.values() {
                    if let Some(value) = fields.get("fills") {
                        json_paints(&mut referenced, value, false);
                    }
                    if let Some(value) = fields.get("strokes") {
                        json_paints(&mut referenced, value, true);
                    }
                }
            }
        }
        if let Some(system) = &doc.design_system {
            for style in system.styles.values().filter(|s| s.kind == "paint") {
                json_paints(&mut referenced, &style.value, false);
            }
        }
        for clip in &doc.animations {
            for track in &clip.tracks {
                for key in &track.keyframes {
                    paints(
                        &mut referenced,
                        key.value
                            .fills
                            .iter()
                            .chain(key.value.strokes.iter().map(|s| &s.paint)),
                    );
                }
            }
        }
        let mut pixels = 0;
        self.cache.retain(|uri, image| {
            let keep = referenced.contains(uri.as_str());
            if keep {
                pixels += image.resident_pixels();
            }
            keep
        });
        self.pixels = pixels;
    }
    pub fn set_color_settings(&mut self, settings: Option<crate::color::ColorSettings>) {
        if self.settings != settings {
            self.clear();
            self.settings = settings;
        }
    }
    /// Enable or disable mip-chain materialization. The chain is derived data
    /// from the same decode, so toggling keeps cached surfaces valid.
    pub fn set_mip_enabled(&mut self, mips: bool) {
        self.mips = mips;
    }
    pub fn mips_enabled(&self) -> bool {
        self.mips
    }
    /// Decoded pixels currently resident, base surfaces plus materialized
    /// mip levels. Mirrors the admission accounting.
    pub fn resident_pixels(&self) -> usize {
        self.pixels
    }
    pub fn image(&mut self, data: &str) -> Result<Arc<Surface>, String> {
        self.image_at(data, 0)
    }
    /// Surface for `level`, materializing the chain on demand. Levels beyond
    /// the geometric chain clamp to the last level; requesting a level above
    /// zero while mips are disabled is an explicit error, never a silent
    /// resolution mismatch with compiled coordinates.
    pub fn image_at(&mut self, data: &str, level: u32) -> Result<Arc<Surface>, String> {
        if level == 0 {
            return Ok(self.base(data)?.base.clone());
        }
        if !self.mips {
            return Err("Image mip levels are disabled".into());
        }
        let level = {
            let cached = self.base(data)?;
            level.min(crate::image_mipmap::mip_levels([cached.base.rect.w, cached.base.rect.h]) - 1)
        };
        while {
            let cached = self.cache.get_mut(data).expect("decoded above");
            cached.chain.len() < level as usize
        } {
            let source = {
                let cached = self.cache.get_mut(data).expect("decoded above");
                cached.chain.last().unwrap_or(&cached.base).clone()
            };
            let down = if self.settings.is_some() {
                crate::image_mipmap::downsample_linear(&source)?
            } else {
                crate::image_mipmap::downsample_byte(&source)?
            };
            let count = down.rect.pixels();
            if self.pixels + count
                > if self.settings.is_some() {
                    8_388_608
                } else {
                    16_777_216
                }
            {
                return Err("Decoded image budget exceeded".into());
            }
            self.pixels += count;
            self.cache
                .get_mut(data)
                .expect("decoded above")
                .chain
                .push(Arc::new(down));
        }
        let cached = self.cache.get(data).expect("decoded above");
        Ok(cached
            .chain
            .get(level as usize - 1)
            .map_or(cached.base.clone(), |l| l.clone()))
    }
    fn base(&mut self, data: &str) -> Result<&mut CachedImage, String> {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.cache.entry(data.to_owned())
        {
            let (surface, count) = decode(data, self.settings, self.pixels)?;
            self.pixels += count;
            entry.insert(CachedImage {
                base: Arc::new(surface),
                chain: Vec::new(),
            });
        }
        Ok(self.cache.get_mut(data).expect("just inserted"))
    }
    pub fn clear(&mut self) {
        self.cache.clear();
        self.pixels = 0;
    }
}

/// Decode an asset to its resident surface, applying the same admission and
/// allocation limits the inline decode historically enforced. Returns the
/// surface and the pixel count to charge against the resident budget.
fn decode(
    data: &str,
    settings: Option<crate::color::ColorSettings>,
    resident: usize,
) -> Result<(Surface, usize), String> {
    if data.len() > 12 * 1024 * 1024 {
        return Err("Image exceeds 12 MB encoded limit".into());
    }
    let (_, b64) = data.split_once(',').ok_or("Invalid image URI")?;
    if ![
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ]
    .iter()
    .any(|p| data.starts_with(p))
    {
        return Err("Unsupported image URI".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "Invalid image data")?;
    let space = crate::image_color::png_space(&bytes)?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    // One 8192² RGBA8 decode is ~268 MB; admitting it lets the display-side
    // cap below downsample oversized assets instead of rejecting the whole
    // document (a 6000×4000 camera JPEG otherwise fails the pixel budget).
    limits.max_alloc = Some(320 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let profile = if space.is_none() {
        crate::image_color::icc(&mut decoder)?
    } else {
        None
    };
    let orientation = crate::image_color::orientation(&mut decoder)?;
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    decoded.apply_orientation(orientation);
    // Display-side import cap, Figma parity: an asset larger than the resident
    // budget joins the cache at the largest dimensions that fit instead of
    // failing the render. The box budget is per image; cumulative residency
    // keeps its own error below. Triangle is the deterministic scalar filter,
    // so every backend and the CPU reference sample identical texels.
    let allowance = if settings.is_some() {
        8_388_608u64
    } else {
        16_777_216u64
    };
    let pixels = decoded.width() as u64 * decoded.height() as u64;
    if pixels > allowance {
        let scale = (allowance as f64 / pixels as f64).sqrt();
        let target = |v: u32| ((v as f64 * scale).floor() as u32).max(1);
        let (capped_w, capped_h) = (target(decoded.width()), target(decoded.height()));
        decoded = image::DynamicImage::ImageRgba8(image::imageops::resize(
            &decoded.into_rgba8(),
            capped_w,
            capped_h,
            image::imageops::FilterType::Triangle,
        ));
    }
    let count = decoded.width() as usize * decoded.height() as usize;
    if resident + count
        > if settings.is_some() {
            8_388_608
        } else {
            16_777_216
        }
    {
        return Err("Decoded image budget exceeded".into());
    }
    // Preserve 16-bit/float input in managed documents. Untagged bitmap
    // samples are sRGB, independently of the document's vector palette.
    let mut image = if settings.is_some() || space.is_some() || profile.is_some() {
        decoded.into_rgba32f()
    } else {
        image::DynamicImage::ImageRgba8(decoded.into_rgba8()).into_rgba32f()
    };
    if let Some(settings) = settings {
        crate::image_color::to_working(&mut image, settings, space, profile.as_deref())?;
    } else if space.is_some() || profile.is_some() {
        crate::image_color::to_sdr(&mut image, space, profile.as_deref())?;
    }
    let size = image.width() as usize * image.height() as usize;
    if resident + size > 16_777_216 {
        return Err("Decoded image budget exceeded".into());
    }
    let mut surface = Surface::new(Rect::new(0, 0, image.width(), image.height()))?;
    for (out, p) in surface.pixels.iter_mut().zip(image.pixels()) {
        let pixel = Pixel::rgba(p[0], p[1], p[2], p[3]);
        // SDR assets are premultiplied RGBA8 textures on both GPU APIs.
        // Keep the same decode boundary before filtering on the CPU.
        *out = if settings.is_none() {
            pixel.rgba8_quantized()
        } else {
            pixel
        };
    }
    Ok((surface, size))
}
struct ImageCoordinates {
    inverse: Transform,
    paint_inverse: Option<Transform>,
    size: [f64; 2],
    image: [f64; 2],
    fit: String,
    /// Active pattern tiling: replaces the fit placement with
    /// the repeating UV chain. `None` covers absent and `mode: none`.
    pattern: Option<crate::pattern_fill::PatternTile>,
}
impl ImageCoordinates {
    fn new(
        paint: &Paint,
        size: [f64; 2],
        matrix: Transform,
        bounds: Rect,
        image: [u32; 2],
    ) -> Result<Self, String> {
        Ok(Self {
            inverse: matrix.inverse_composed(bounds)?,
            paint_inverse: paint.transform.map(|m| m.inverse()).transpose()?,
            size,
            image: image.map(f64::from),
            fit: paint.fit.clone(),
            pattern: paint.tile.clone().filter(|t| t.is_active()),
        })
    }
    /// Pattern-fill phase for a device point, as texture UV in
    /// [0,1)². `Paint.transform` composes before the chain — the paired
    /// vertex shader feeds `_coord2 = paintTransform·position2`
    /// into the tiling math, so the transform scales/rotates the whole
    /// pattern rather than the single placement.
    fn pattern_uv(&self, device: Point) -> Point {
        let p = self.inverse.point(device);
        let q = self.paint_inverse.map_or(p, |m| {
            let uv = m.point(Point::new(p.x / self.size[0], p.y / self.size[1]));
            Point::new(uv.x * self.size[0], uv.y * self.size[1])
        });
        let pattern = self.pattern.as_ref().expect("caller checks pattern");
        crate::pattern_fill::tile_uv(pattern, q, pattern.resolve(self.image))
    }
    // The byte paint path works relative to the first texel centre before
    // division, then rounds the complete clamped index exactly once to f32.
    // Keep this order shared with GPU metadata; reassociation changes half bytes.
    fn byte_point(&self, device: Point) -> Point {
        let p = self.inverse.point(device);
        if self.pattern.is_some() {
            // Pattern phase follows the transform branch's first-texel-centre
            // convention (q = uv·extent − 0.5); the contain margin never
            // applies because fract(g) stays inside [0,1) by construction.
            let uv = self.pattern_uv(device);
            let (iw, ih) = (self.image[0], self.image[1]);
            return Point::new(uv.x * iw - 0.5, uv.y * ih - 0.5);
        }
        let (iw, ih) = (self.image[0], self.image[1]);
        // Work relative to the first texel center before division. Dividing a
        // coordinate and then subtracting 0.5 loses the fractional bits that
        // decide half-byte interpolation, especially at contain/cover edges.
        let mut q = Point::new(
            (p.x * iw - self.size[0] * 0.5) / self.size[0],
            (p.y * ih - self.size[1] * 0.5) / self.size[1],
        );
        if let Some(transform) = self.paint_inverse {
            let uv = transform.point(Point::new(p.x / self.size[0], p.y / self.size[1]));
            q = Point::new(uv.x * iw - 0.5, uv.y * ih - 0.5);
        } else if self.fit != "stretch" {
            let ratio = if self.fit == "contain" {
                (self.size[0] / iw).min(self.size[1] / ih)
            } else {
                (self.size[0] / iw).max(self.size[1] / ih)
            };
            q = Point::new(
                (p.x - (self.size[0] - (iw - 1.) * ratio) * 0.5) / ratio,
                (p.y - (self.size[1] - (ih - 1.) * ratio) * 0.5) / ratio,
            );
        }
        q
    }
    fn independent_byte_axis(&self, point: Point, axis: usize) -> Option<(f32, f32)> {
        // Pattern tiling is not per-axis separable — the stagger shift
        // couples x to y — and the fract wrap defeats the affine stride
        // certification. Returning None routes the compact field to the
        // dense grid, which is the exact oracle for this mapping.
        if self.pattern.is_some() {
            return None;
        }
        let coordinate = if axis == 0 { point.x } else { point.y };
        let diagonal = if axis == 0 { 0 } else { 3 };
        let primary = self.inverse.0[diagonal] * coordinate;
        // Adding the other axis's signed zero to a finite nonzero product
        // preserves every binary64 bit. Uncertain signed-zero/overflow cases
        // retain the original dense representation.
        if !primary.is_finite() || primary == 0. {
            return None;
        }
        if let Some(paint) = self.paint_inverse {
            let local = self.inverse.point(point);
            let uv = if axis == 0 {
                local.x / self.size[0]
            } else {
                local.y / self.size[1]
            };
            let product = paint.0[diagonal] * uv;
            if !product.is_finite() || product == 0. {
                return None;
            }
        }
        let raw = self.byte_point(point);
        let q = if axis == 0 { raw.x } else { raw.y };
        let extent = self.image[axis];
        let value = q.clamp(0., extent - 1.) as f32;
        if !value.is_finite() {
            return None;
        }
        let valid = self.fit != "contain" || (q >= -0.5 && q < extent - 0.5);
        Some((value, f32::from(valid)))
    }
    fn linear_axis(&self, point: Point, axis: usize) -> Option<(f64, i8)> {
        if self.pattern.is_some() { return None; }
        let raw = self.linear_point(point);
        let q = if axis == 0 { raw.x } else { raw.y };
        if !q.is_finite() { return None; }
        let region = if self.fit != "contain" { 0 } else if q < 0. { -1 } else if q >= self.image[axis] { 1 } else { 0 };
        Some((q.clamp(0.5, self.image[axis] - 0.5), region))
    }
    fn byte_index_at(&self, device: Point) -> Option<[f32; 2]> {
        let q = self.byte_point(device);
        let (iw, ih) = (self.image[0], self.image[1]);
        if self.fit == "contain" && (q.x < -0.5 || q.y < -0.5 || q.x >= iw - 0.5 || q.y >= ih - 0.5)
        {
            return None;
        }
        Some([q.x.clamp(0., iw - 1.) as f32, q.y.clamp(0., ih - 1.) as f32])
    }
    fn at(&self, device: Point) -> Option<Point> {
        if self.pattern.is_some() {
            // Pattern fill with tileSizePixels == patternTexSizePixels: the
            // sampled window is the full texture (i = 1) and the `j` clamp
            // is exactly the half-texel bilinear edge below. There is no
            // contain margin — fract(g) ∈ [0,1) always lands inside.
            let uv = self.pattern_uv(device);
            let (iw, ih) = (self.image[0], self.image[1]);
            return Some(Point::new(
                (uv.x * iw).clamp(0.5, iw - 0.5),
                (uv.y * ih).clamp(0.5, ih - 0.5),
            ));
        }
        let p = self.linear_point(device);
        let (iw, ih) = (self.image[0], self.image[1]);
        if self.fit == "contain" && (p.x < 0. || p.y < 0. || p.x >= iw || p.y >= ih) {
            None
        } else {
            Some(Point::new(p.x.clamp(0.5, iw - 0.5), p.y.clamp(0.5, ih - 0.5)))
        }
    }
    fn linear_point(&self, device: Point) -> Point {
        let p = self.inverse.point(device);
        let uv = Point::new(p.x / self.size[0], p.y / self.size[1]);
        let uv = self.paint_inverse.map_or(uv, |m| m.point(uv));
        let (iw, ih) = (self.image[0], self.image[1]);
        let (mut x, mut y) = (uv.x * iw, uv.y * ih);
        if self.paint_inverse.is_none() && self.fit != "stretch" {
            let ratio = if self.fit == "contain" {
                (self.size[0] / iw).min(self.size[1] / ih)
            } else {
                (self.size[0] / iw).max(self.size[1] / ih)
            };
            x = (p.x - (self.size[0] - iw * ratio) / 2.) / ratio;
            y = (p.y - (self.size[1] - ih * ratio) / 2.) / ratio;
        }
        Point::new(x, y)
    }
}
/// Minification-driven mip level for an image fill, the geometric half of
/// Sketch's `tileLevelWithScale`/`CGImageAtMipmapLevel` selection. The ratio
/// is the per-axis texel stride of the device→texel mapping, measured as
/// finite differences of the unclamped byte coordinates (every branch of the
/// mapping is affine, so differences are exact). `floor(log2(ratio))` picks
/// the coarsest level whose texels still cover a device pixel; callers clamp
/// against the chain length (`image_mipmap::mip_levels`).
pub fn image_mip_level(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
) -> Result<u32, String> {
    if image.contains(&0) || size.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid image sampling geometry".into());
    }
    if let Some(pattern) = paint.tile.as_ref().filter(|t| t.is_active()) {
        // fract/stagger make byte_point non-affine: a 1px finite difference
        // can straddle a tile seam and misreport the stride. The grid
        // mapping's texel density is image/size per axis (the stagger's
        // half-tile shift changes phase, not density), which is what the
        // affine difference measures for ordinary fills.
        let resolved = pattern.resolve(image.map(f64::from));
        let ratio = (f64::from(image[0]) / resolved[0]).max(f64::from(image[1]) / resolved[1]);
        if !ratio.is_finite() || ratio <= 1. {
            return Ok(0);
        }
        return Ok((ratio.log2().floor() as u32).min(u32::MAX - 1));
    }
    let coordinates = ImageCoordinates::new(paint, size, matrix, rect, image)?;
    let center = Point::new(
        f64::from(rect.x) + f64::from(rect.w) * 0.5,
        f64::from(rect.y) + f64::from(rect.h) * 0.5,
    );
    let base = coordinates.byte_point(center);
    let dx = coordinates.byte_point(Point::new(center.x + 1., center.y));
    let dy = coordinates.byte_point(Point::new(center.x, center.y + 1.));
    let stride_x = (dx.x - base.x).hypot(dx.y - base.y);
    let stride_y = (dy.x - base.x).hypot(dy.y - base.y);
    let ratio = stride_x.max(stride_y);
    if !ratio.is_finite() || ratio <= 1. {
        return Ok(0);
    }
    Ok((ratio.log2().floor() as u32).min(u32::MAX - 1))
}
/// Shared binary64 coordinate compilation; GPU samples its own decoded colors.
pub fn image_sampling_grid(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
) -> Result<Vec<f32>, String> {
    image_sampling_grid_at_level(rect, matrix, size, image, paint, sample, 0)
}
/// `image_sampling_grid` compiled against a mip level's dimensions. Level 0 is
/// bit-identical to the historical entry point; callers pass the surface that
/// `Images::image_at(uri, level)` returns.
pub fn image_sampling_grid_at_level(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
) -> Result<Vec<f32>, String> {
    image_sampling_grid_placed(rect, matrix, size, image, paint, sample, level, [0, 0])
}
/// Level-selected grid emitted into an atlas page: every texel cell index is
/// shifted by `origin` so the shader fetches from the page slot; out-of-range
/// markers stay unshifted. Zero padding around slots keeps byte output
/// identical to a standalone texture (out-of-bounds fetches read zero either
/// way), so atlas packing is a pure residency optimization.
#[allow(clippy::too_many_arguments)]
pub fn image_sampling_grid_placed(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
    origin: [i32; 2],
) -> Result<Vec<f32>, String> {
    if image.contains(&0) || size.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid image sampling geometry".into());
    }
    let level = level.min(crate::image_mipmap::mip_levels(image) - 1);
    let image = crate::image_mipmap::level_dimensions(image, level);
    let offset = match sample {
        Some(i) => *crate::fidelity::SAMPLE_OFFSETS
            .get(i)
            .ok_or("Invalid image sample index")?,
        None => (0.5, 0.5),
    };
    let coordinates = ImageCoordinates::new(paint, size, matrix, rect, image)?;
    let mut values =
        crate::sampling::coordinate_grid(rect, Rect::new(0, 0, image[0], image[1]), |x, y| {
            coordinates.at(Point::new(f64::from(x) + offset.0, f64::from(y) + offset.1))
        })?;
    // Atlas placement shifts emitted texel cells into page space. Valid
    // coordinates are >= -1, so the -2 marker is unambiguous; integer shifts
    // stay exact in f32 at page sizes.
    if origin != [0, 0] {
        for value in values.chunks_exact_mut(4) {
            if value[0] != -2. {
                value[0] += origin[0] as f32;
                value[1] += origin[1] as f32;
            }
        }
    }
    Ok(values)
}
/// Exact compact linear-image coordinates. W=-1 tags two independent rows;
/// X/Y/Z contain cell, fractional part and validity. Empty means the caller
/// must use the dense grid. No colors or resampled pixels are stored here.
#[allow(clippy::too_many_arguments)]
pub fn image_sampling_axes_placed(
    rect: Rect, matrix: Transform, size: [f64; 2], image: [u32; 2],
    paint: &Paint, sample: Option<usize>, level: u32, origin: [i32; 2],
) -> Result<Vec<f32>, String> {
    if rect.w > i32::MAX as u32 || rect.h > i32::MAX as u32
        || i64::from(rect.x) + i64::from(rect.w) > i64::from(i32::MAX)
        || i64::from(rect.y) + i64::from(rect.h) > i64::from(i32::MAX) {
        return Err("Image coordinate bounds exceed integer range".into());
    }
    if image.contains(&0) || size.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid image sampling geometry".into());
    }
    let level = level.min(crate::image_mipmap::mip_levels(image) - 1);
    let dimensions = crate::image_mipmap::level_dimensions(image, level);
    let coordinates = ImageCoordinates::new(paint, size, matrix, rect, dimensions)?;
    let axis_aligned = |m: Transform| m.0[1] == 0. && m.0[2] == 0.;
    if rect.w <= 2 || rect.h <= 2 || coordinates.pattern.is_some()
        || coordinates.paint_inverse.is_some_and(|m| !axis_aligned(m)) {
        return Ok(Vec::new());
    }
    let offset = match sample {
        Some(i) => *crate::fidelity::SAMPLE_OFFSETS.get(i).ok_or("Invalid image sample index")?,
        None => (0.5, 0.5),
    };
    let span = rect.w.max(rect.h) as usize;
    let count = span.checked_mul(8).ok_or("Sampling coordinate size overflow")?;
    if count > 16_777_216 { return Err("Sampling coordinate field exceeds 64 MiB".into()); }
    // With no cross-axis paint transform, each coordinate is monotone in the
    // other device axis. Certify BOTH endpoint cell/fraction bits for every
    // row/column and sample plane, without zeroing tiny rotation coefficients.
    // Equal endpoint cells and rounded fractions imply identical interior
    // metadata. Contain's below/inside/above class prevents two invalid ends
    // from hiding a valid interior (notably for one-texel images).
    let signature = |point: Point, axis| coordinates.linear_axis(point, axis).map(|(value, region)| {
        let q = value - 0.5; let cell = q.floor();
        (cell.to_bits(), ((q - cell) as f32).to_bits(), region)
    });
    for phase in crate::fidelity::SAMPLE_OFFSETS.into_iter().chain([(0.5, 0.5)]) {
        for axis in 0..2 {
            let length = if axis == 0 { rect.w } else { rect.h };
            for index in 0..length {
                let x = rect.x + if axis == 0 { index as i32 } else { 0 };
                let y = rect.y + if axis == 1 { index as i32 } else { 0 };
                let first = Point::new(f64::from(x) + phase.0, f64::from(y) + phase.1);
                let last = if axis == 0 { Point::new(first.x, f64::from(rect.bottom() - 1) + phase.1) }
                    else { Point::new(f64::from(rect.right() - 1) + phase.0, first.y) };
                let a = signature(first, axis);
                if a.is_none() || a != signature(last, axis) {
                    return Ok(Vec::new());
                }
            }
        }
    }
    let mut values = Vec::new();
    values.try_reserve_exact(count).map_err(|_| "Sampling coordinate allocation failed")?;
    values.resize(count, 0.);
    for (axis, shift) in origin.iter().enumerate() {
        let length = if axis == 0 { rect.w } else { rect.h };
        for index in 0..length {
            let x = rect.x + if axis == 0 { index as i32 } else { 0 };
            let y = rect.y + if axis == 1 { index as i32 } else { 0 };
            let (point, region) = coordinates.linear_axis(Point::new(f64::from(x) + offset.0, f64::from(y) + offset.1), axis)
                .expect("all supported phases certified above");
            let q = point - 0.5;
            let cell = q.floor();
            let start = (axis * span + index as usize) * 4;
            values[start..start + 4].copy_from_slice(&[cell as f32 + *shift as f32, (q - cell) as f32, f32::from(region == 0), -1.]);
        }
    }
    Ok(values)
}
/// Colour-independent byte-image indices. Unlike the linear sampler's cell +
/// fraction representation, SDR rounds each complete first-centre index to f32.
/// Z is a validity flag so contain margins never fetch an arbitrary border texel.
pub fn image_byte_sampling_grid(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
) -> Result<Vec<f32>, String> {
    image_byte_sampling_grid_placed(rect, matrix, size, image, paint, sample, 0, [0, 0])
}
pub fn image_byte_sampling_grid_at_level(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
) -> Result<Vec<f32>, String> {
    image_byte_sampling_grid_placed(rect, matrix, size, image, paint, sample, level, [0, 0])
}
/// Dense byte grid with level selection and an atlas page offset. Valid
/// indices shift by `origin`; invalid pixels keep their zero markers.
#[allow(clippy::too_many_arguments)]
pub fn image_byte_sampling_grid_placed(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
    origin: [i32; 2],
) -> Result<Vec<f32>, String> {
    if rect.w > i32::MAX as u32
        || rect.h > i32::MAX as u32
        || i64::from(rect.x) + i64::from(rect.w) > i64::from(i32::MAX)
        || i64::from(rect.y) + i64::from(rect.h) > i64::from(i32::MAX)
    {
        return Err("Image coordinate bounds exceed integer range".into());
    }
    if image.contains(&0) || size.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid image sampling geometry".into());
    }
    let level = level.min(crate::image_mipmap::mip_levels(image) - 1);
    let image = crate::image_mipmap::level_dimensions(image, level);
    let offset = match sample {
        Some(i) => *crate::fidelity::SAMPLE_OFFSETS
            .get(i)
            .ok_or("Invalid image sample index")?,
        None => (0.5, 0.5),
    };
    let count = rect
        .pixels()
        .checked_mul(4)
        .ok_or("Sampling coordinate size overflow")?;
    if count > 16_777_216 {
        return Err("Sampling coordinate field exceeds 64 MiB".into());
    }
    let coordinates = ImageCoordinates::new(paint, size, matrix, rect, image)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| "Sampling coordinate allocation failed")?;
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            match coordinates
                .byte_index_at(Point::new(f64::from(x) + offset.0, f64::from(y) + offset.1))
            {
                Some([x, y]) if x.is_finite() && y.is_finite() => {
                    values.extend([x + origin[0] as f32, y + origin[1] as f32, 1., 0.])
                }
                Some(_) => return Err("Non-finite image sampling coordinate".into()),
                None => values.extend([0., 0., 0., 0.]),
            }
        }
    }
    Ok(values)
}
/// Exact compact representation for independent image axes. Dense affine
/// fields remain the oracle/fallback. W=1 tags two rows: row 0 stores X index
/// and X validity, row 1 stores Y index and Y validity (in X and Z channels).
/// Shader callers combine both validities; an invalid other axis must not erase
/// the useful coordinate while this metadata is being constructed.
pub fn image_byte_sampling_field(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
) -> Result<Vec<f32>, String> {
    image_byte_sampling_field_placed(rect, matrix, size, image, paint, sample, 0, [0, 0])
}
pub fn image_byte_sampling_field_at_level(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
) -> Result<Vec<f32>, String> {
    image_byte_sampling_field_placed(rect, matrix, size, image, paint, sample, level, [0, 0])
}
/// Compact byte field with level selection and an atlas page offset. Row
/// indices shift by the per-axis origin; validity flags are unchanged.
#[allow(clippy::too_many_arguments)]
pub fn image_byte_sampling_field_placed(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    image: [u32; 2],
    paint: &Paint,
    sample: Option<usize>,
    level: u32,
    origin: [i32; 2],
) -> Result<Vec<f32>, String> {
    if rect.w > i32::MAX as u32
        || rect.h > i32::MAX as u32
        || i64::from(rect.x) + i64::from(rect.w) > i64::from(i32::MAX)
        || i64::from(rect.y) + i64::from(rect.h) > i64::from(i32::MAX)
    {
        return Err("Image coordinate bounds exceed integer range".into());
    }
    if image.contains(&0) || size.iter().any(|v| !v.is_finite() || *v <= 0.) {
        return Err("Invalid image sampling geometry".into());
    }
    let level = level.min(crate::image_mipmap::mip_levels(image) - 1);
    let level_image = crate::image_mipmap::level_dimensions(image, level);
    let coordinates = ImageCoordinates::new(paint, size, matrix, rect, level_image)?;
    let axis_aligned = |m: Transform| m.0[1] == 0. && m.0[2] == 0.;
    if rect.w <= 2
        || rect.h <= 2
        || !axis_aligned(coordinates.inverse)
        || coordinates.paint_inverse.is_some_and(|m| !axis_aligned(m))
    {
        return image_byte_sampling_grid_placed(
            rect, matrix, size, image, paint, sample, level, origin,
        );
    }
    let offset = match sample {
        Some(i) => *crate::fidelity::SAMPLE_OFFSETS
            .get(i)
            .ok_or("Invalid image sample index")?,
        None => (0.5, 0.5),
    };
    let span = rect.w.max(rect.h) as usize;
    let count = span
        .checked_mul(8)
        .ok_or("Sampling coordinate size overflow")?;
    if count > 16_777_216 {
        return Err("Sampling coordinate field exceeds 64 MiB".into());
    }
    // Certify every supported sample phase up front. The layout is therefore
    // stable when a renderer rewrites one texture for successive sample planes.
    for phase in crate::fidelity::SAMPLE_OFFSETS
        .into_iter()
        .chain([(0.5, 0.5)])
    {
        for axis in 0..2 {
            let length = if axis == 0 { rect.w } else { rect.h };
            for index in 0..length {
                let x = rect.x + if axis == 0 { index as i32 } else { 0 };
                let y = rect.y + if axis == 1 { index as i32 } else { 0 };
                if coordinates
                    .independent_byte_axis(
                        Point::new(f64::from(x) + phase.0, f64::from(y) + phase.1),
                        axis,
                    )
                    .is_none()
                {
                    return image_byte_sampling_grid_placed(
                        rect, matrix, size, image, paint, sample, level, origin,
                    );
                }
            }
        }
    }
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| "Sampling coordinate allocation failed")?;
    values.resize(count, 0.);
    for (axis, shift) in origin.iter().enumerate() {
        let length = if axis == 0 { rect.w } else { rect.h };
        for index in 0..length {
            // Evaluate the original two separate affine stages. Do not compose
            // matrices or replace first-texel-centre division with UV subtraction.
            let x = rect.x + if axis == 0 { index as i32 } else { 0 };
            let y = rect.y + if axis == 1 { index as i32 } else { 0 };
            let point = Point::new(f64::from(x) + offset.0, f64::from(y) + offset.1);
            let (value, valid) = coordinates
                .independent_byte_axis(point, axis)
                .expect("all supported phases certified above");
            let placed = value + *shift as f32;
            let start = (axis * span + index as usize) * 4;
            values[start..start + 4].copy_from_slice(&[placed, 0., valid, 1.]);
        }
    }
    Ok(values)
}
struct GradientCoordinates {
    kind: String,
    inverse: Transform,
    w: f64,
    h: f64,
    angle: f64,
    paint_inverse: Option<Transform>,
    fixed_gradient: Option<crate::fixed_gradient::FixedGradient>,
    offsets: Vec<f64>,
}
impl GradientCoordinates {
    fn new(paint: &Paint, size: [f64; 2], matrix: Transform, bounds: Rect) -> Result<Self, String> {
        let inverse = matrix.inverse_composed(bounds)?;
        let mut offsets: Vec<f64> = paint.stops.iter().map(|s| s.offset).collect();
        offsets.sort_by(f64::total_cmp);
        Ok(Self {
            kind: paint.kind.clone(),
            inverse,
            w: size[0],
            h: size[1],
            angle: paint.angle.to_radians(),
            paint_inverse: paint.transform.map(|m| m.inverse()).transpose()?,
            fixed_gradient: crate::fixed_gradient::FixedGradient::new(
                paint, inverse, size, bounds,
            )?,
            offsets,
        })
    }
    fn locate(&self, device: Point) -> Option<(usize, usize, f32)> {
        if self.offsets.is_empty() {
            return None;
        }
        let local = self.inverse.point(device);
        let uv = Point::new(local.x / self.w, local.y / self.h);
        let uv = self.paint_inverse.map_or(uv, |m| m.point(uv));
        let t = self
            .fixed_gradient
            .as_ref()
            .map_or_else(
                || self.gradient_t(uv.x, uv.y),
                |g| f64::from(g.parameter(device)),
            )
            .clamp(0., 1.);
        let index = self.offsets.partition_point(|offset| *offset < t);
        if index == 0 {
            Some((0, 0, 0.))
        } else if index == self.offsets.len() {
            Some((index - 1, index - 1, 0.))
        } else {
            // partition_point gives left < t <= right, hence a strictly
            // positive denominator even when duplicate stops exist. An
            // epsilon here stretches valid adjacent binary64 stop intervals.
            Some((
                index - 1,
                index,
                ((t - self.offsets[index - 1]) / (self.offsets[index] - self.offsets[index - 1]))
                    as f32,
            ))
        }
    }
    fn gradient_t(&self, u: f64, v: f64) -> f64 {
        if self.kind == "linear" {
            let (s, c) = self.angle.sin_cos();
            if self.paint_inverse.is_some() {
                u
            } else {
                ((u - 0.5) * c + (v - 0.5) * s) / (c.abs() + s.abs()).max(1e-12) + 0.5
            }
        } else if self.kind == "angular" {
            ((v - 0.5).atan2(u - 0.5) - self.angle).rem_euclid(std::f64::consts::TAU)
                / std::f64::consts::TAU
        } else if self.kind == "diamond" {
            let (s, c) = self.angle.sin_cos();
            (c * (u - 0.5) + s * (v - 0.5))
                .abs()
                .max((-s * (u - 0.5) + c * (v - 0.5)).abs())
                * 2.
        } else {
            ((u - 0.5) * 2.).hypot((v - 0.5) * 2.)
        }
    }
}
/// Color-independent gradient stop selection and interpolation weights. Stop
/// colors remain shader constants and are shaded on the GPU.
pub fn gradient_sampling_grid(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    paint: &Paint,
    sample: Option<usize>,
) -> Result<Vec<f32>, String> {
    let coordinates = GradientCoordinates::new(paint, size, matrix, rect)?;
    let offset = match sample {
        Some(i) => *crate::fidelity::SAMPLE_OFFSETS
            .get(i)
            .ok_or("Invalid gradient sample index")?,
        None => (0.5, 0.5),
    };
    crate::sampling::parameter_grid(rect, |x, y| {
        Ok(coordinates
            .locate(Point::new(f64::from(x) + offset.0, f64::from(y) + offset.1))
            .map_or([-1., -1., 0., 0.], |(a, b, k)| [a as f32, b as f32, k, 0.]))
    })
}
pub struct Sampler {
    linear_sampling: bool,
    image_coordinates: Option<ImageCoordinates>,
    kind: String,
    base: Pixel,
    stops: Vec<(f64, Pixel)>,
    byte_stops: Vec<[f32; 4]>,
    image: Option<Arc<Surface>>,
    opacity: f32,
    gradient_coordinates: Option<GradientCoordinates>,
    /// Authored image adjustments; `None` covers absent and identity. The
    /// storage domain flag (managed = linear working space, else sRGB bytes)
    /// selects the image-adjust bookend variant — captured before
    /// `prepare_sampled` can flip `linear_sampling`.
    adjust: Option<(crate::image_adjust::ImageAdjust, bool)>,
}
impl Sampler {
    pub fn solid(&self) -> Option<Pixel> {
        (self.kind == "solid").then(|| self.base.opacity(self.opacity))
    }
    /// Apply authored image adjustments to a sampled premultiplied texel:
    /// unpremultiply (the shader adjusts straight RGB), run the ported math in
    /// the texel's storage domain, premultiply again.
    fn adjusted(&self, pixel: Pixel) -> Pixel {
        let Some((adjust, linear)) = &self.adjust else {
            return pixel;
        };
        let alpha = pixel.0[3];
        if alpha <= 0. {
            return pixel;
        }
        let straight = [pixel.0[0] / alpha, pixel.0[1] / alpha, pixel.0[2] / alpha];
        let straight = if *linear {
            adjust.apply_linear(straight)
        } else {
            adjust.apply_srgb(straight)
        };
        Pixel([straight[0] * alpha, straight[1] * alpha, straight[2] * alpha, alpha])
    }
    pub fn solid_rgba8(&self) -> Option<Pixel> {
        (self.kind == "solid").then(|| premultiply_byte_color(self.base, self.opacity))
    }
    pub fn new(
        p: &Paint,
        n: &Node,
        m: Transform,
        samples: Rect,
        images: &mut Images,
    ) -> Result<Self, String> {
        if !p.opacity.is_finite() || !p.angle.is_finite() {
            return Err("Invalid paint".into());
        }
        let mut stops = p
            .stops
            .iter()
            .map(|s| {
                Ok((
                    s.offset,
                    crate::color::pixel(images.settings, &s.color, 1.)?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        if stops.iter().any(|s| !s.0.is_finite()) {
            return Err("Invalid gradient stop".into());
        }
        stops.sort_by(|a, b| a.0.total_cmp(&b.0));
        let image = if p.kind == "image" {
            let uri = p.image.as_deref().ok_or("Image fill has no asset")?;
            let base = images.image(uri)?;
            // Coordinate compilation and surface must agree on the level, so
            // the selection stays inside the same pure geometry the exported
            // grid compilers use.
            let level = if images.mips_enabled() {
                image_mip_level(
                    samples,
                    m,
                    [n.width, n.height],
                    [base.rect.w, base.rect.h],
                    p,
                )?
                .min(crate::image_mipmap::mip_levels([base.rect.w, base.rect.h]) - 1)
            } else {
                0
            };
            Some(images.image_at(uri, level)?)
        } else {
            None
        };
        let image_coordinates = image
            .as_ref()
            .map(|image| {
                ImageCoordinates::new(
                    p,
                    [n.width, n.height],
                    m,
                    samples,
                    [image.rect.w, image.rect.h],
                )
            })
            .transpose()?;
        let gradient_coordinates =
            if matches!(p.kind.as_str(), "linear" | "radial" | "angular" | "diamond") {
                Some(GradientCoordinates::new(
                    p,
                    [n.width, n.height],
                    m,
                    samples,
                )?)
            } else {
                None
            };
        // Preserve validation even for constant paints without coordinate fields.
        m.inverse_composed(samples)?;
        p.transform.map(|m| m.inverse()).transpose()?;
        Ok(Self {
            gradient_coordinates,
            image_coordinates,
            linear_sampling: images.settings.is_some(),
            kind: p.kind.clone(),
            base: crate::color::pixel(images.settings, &p.color, 1.)?,
            byte_stops: stops
                .iter()
                .map(|(_, p)| p.0.map(|v| (v * 255.).round_ties_even()))
                .collect(),
            stops,
            image,
            opacity: p.opacity.clamp(0., 1.) as f32,
            adjust: p
                .adjust
                .filter(|a| !a.is_identity())
                .map(|a| (a, images.settings.is_some())),
        })
    }
    pub(crate) fn prepare_sampled(
        &mut self,
        _paint: &Paint,
        _bounds: Rect,
        floating: bool,
    ) -> Result<(), String> {
        self.linear_sampling |= floating;
        Ok(())
    }
    pub fn at_rgba8(&self, device: Point) -> Pixel {
        let Some(image) = &self.image else {
            if self.stops.is_empty()
                || !matches!(
                    self.kind.as_str(),
                    "linear" | "radial" | "angular" | "diamond"
                )
            {
                return self.at(device);
            }
            let Some((left, right, k)) = self
                .gradient_coordinates
                .as_ref()
                .and_then(|g| g.locate(device))
            else {
                return self.at(device);
            };
            let value = if left == right {
                self.byte_stops[left]
            } else {
                std::array::from_fn(|c| {
                    (self.byte_stops[right][c] - self.byte_stops[left][c])
                        .mul_add(k, self.byte_stops[left][c])
                })
            };
            return Pixel(value.map(|v| (v * self.opacity).round_ties_even() / 255.));
        };
        let Some([x, y]) = self
            .image_coordinates
            .as_ref()
            .and_then(|c| c.byte_index_at(device))
        else {
            return Pixel::default();
        };
        let sampled = image.sample_rgba8_index(x, y, if self.adjust.is_some() { 1. } else { self.opacity });
        if self.adjust.is_none() {
            return sampled;
        }
        // Byte path: adjustments run on the unpremultiplied f32 texel, then
        // paint opacity re-quantizes once, mirroring the sampling boundary.
        let adjusted = self.adjusted(sampled);
        Pixel(adjusted.0.map(|v| ((v * 255.) * self.opacity).round_ties_even() / 255.))
    }
    pub fn at(&self, device: Point) -> Pixel {
        let color = if let Some(image) = &self.image {
            match self.image_coordinates.as_ref().and_then(|c| c.at(device)) {
                None => Pixel::default(),
                Some(q) => {
                    let sampled = if self.linear_sampling {
                        image.sample_linear(q.x, q.y)
                    } else {
                        image.sample(q.x, q.y)
                    };
                    self.adjusted(sampled)
                }
            }
        } else if let Some(g) = &self.gradient_coordinates {
            match g.locate(device) {
                None => self.base,
                Some((left, right, k)) => {
                    if left == right {
                        self.stops[left].1
                    } else {
                        let a = self.stops[left].1;
                        let b = self.stops[right].1;
                        Pixel(std::array::from_fn(|c| a.0[c] + (b.0[c] - a.0[c]) * k))
                    }
                }
            }
        } else {
            self.base
        };
        color.opacity(self.opacity)
    }
}

pub fn solid_rgba8(color: &str, opacity: f32) -> Result<Pixel, String> {
    Ok(premultiply_byte_color(Pixel::hex(color, 1.)?, opacity))
}
fn premultiply_byte_color(color: Pixel, opacity: f32) -> Pixel {
    Pixel(
        color.0.map(|v| {
            ((v * 255.).round_ties_even() * opacity.clamp(0., 1.)).round_ties_even() / 255.
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_uri(width: u32, height: u32) -> String {
        let mut buffer = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        }))
        .write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::Png)
        .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(buffer)
        )
    }

    #[test]
    fn oversized_assets_downsample_to_the_resident_budget_instead_of_failing() {
        // 20 MP exceeds the 16.7 MP SDR allowance; a camera-sized asset must
        // join the cache capped, not reject the document.
        let uri = png_uri(5000, 4000);
        let mut images = Images::default();
        let surface = images.image(&uri).expect("capped decode succeeds");
        let pixels = (surface.rect.w as u64) * (surface.rect.h as u64);
        assert!(pixels <= 16_777_216, "capped pixels {pixels}");
        assert!(surface.rect.w >= 4500 && surface.rect.h >= 3600);
        assert_eq!(images.resident_pixels() as u64, pixels);
    }

    #[test]
    fn within_budget_assets_keep_their_native_dimensions() {
        let uri = png_uri(100, 80);
        let mut images = Images::default();
        let surface = images.image(&uri).expect("decode succeeds");
        assert_eq!((surface.rect.w, surface.rect.h), (100, 80));
    }
}
