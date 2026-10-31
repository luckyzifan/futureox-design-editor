//! Numeric stages of the measured SDR texture-capture path.
//!
//! This module consumes independently rendered RGBA8 attachments; it does not
//! substitute painted CPU pixels for GPU execution. Geometry/noise fields may
//! be shared, while every backend samples and composites its own attachments.
//! Scene routing and finite source-gradient interpolation are separate work.
use crate::{
    blend::{Pixel, Surface},
    figma_sampling::{encode_unorm8, fraction_q8, normalize_q4, sample_q8},
    math::Rect,
    texture_capture_plan::{Affine, Plan},
    texture_noise,
};

/// An owned CPU attachment. GPU backends create and render their own color
/// resources; this buffer is never a substitute for a GPU color pass.
pub(crate) struct ByteSurface {
    side: u32,
    pixels: Vec<u8>,
    _allocation: Option<crate::memory::Allocation>,
}

impl ByteSurface {
    pub(crate) fn new(template: &Surface, side: u32) -> Result<Self, String> {
        let count = (side as usize)
            .checked_mul(side as usize)
            .filter(|&n| side > 0 && n <= 16_777_216)
            .ok_or("Texture attachment exceeds 16 million pixels")?;
        let bytes = count
            .checked_mul(4)
            .ok_or("Texture attachment byte size overflow")?;
        let allocation = template.reserve_surface::<[u8; 4]>(count)?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(bytes)
            .map_err(|_| "Could not allocate texture attachment")?;
        pixels.resize(bytes, 0);
        Ok(Self {
            side,
            pixels,
            _allocation: allocation,
        })
    }

    pub(crate) fn pixels_mut(&mut self) -> &mut [u8] {
        &mut self.pixels
    }

    pub(crate) fn as_rgba8(&self) -> Rgba8<'_> {
        Rgba8 {
            side: self.side,
            pixels: &self.pixels,
        }
    }
}

/// A tightly packed, logical top-to-bottom RGBA8 attachment with clamp addressing.
#[derive(Clone, Copy)]
pub struct Rgba8<'a> {
    side: u32,
    pixels: &'a [u8],
}

impl<'a> Rgba8<'a> {
    pub fn new(side: u32, pixels: &'a [u8]) -> Result<Self, String> {
        let expected = (side as usize)
            .checked_mul(side as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("Texture capture attachment size overflow")?;
        if !(1..=16_384).contains(&side) || expected != pixels.len() {
            return Err("Invalid texture capture RGBA8 attachment".into());
        }
        Ok(Self { side, pixels })
    }

    pub fn side(self) -> u32 {
        self.side
    }

    fn texel(self, x: usize, y: usize) -> [u8; 4] {
        let k = (y * self.side as usize + x) * 4;
        self.pixels[k..k + 4]
            .try_into()
            .expect("Validated attachment")
    }

    /// Keep the normalized sample in binary32 until its actual destination
    /// store. Premature RGBA8 encoding changes ordinary copyback blending.
    pub fn sample(self, uv: [f32; 2]) -> Result<[f32; 4], String> {
        if uv.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite texture capture sample coordinate".into());
        }
        Ok(self.sample_finite(uv))
    }

    fn sample_finite(self, uv: [f32; 2]) -> [f32; 4] {
        // Clamp before converting to an integer. Finite but very distant UVs
        // must never overflow integer indices or invoke an unchecked cast.
        let p = uv.map(|v| (v.clamp(0., 1.) * self.side as f32 - 0.5).max(0.));
        let low = p.map(|v| (v.floor() as usize).min(self.side as usize - 1));
        let high = low.map(|v| (v + 1).min(self.side as usize - 1));
        let weight = std::array::from_fn::<_, 2, _>(|i| fraction_q8(p[i] - low[i] as f32));
        sample_q8(
            [
                self.texel(low[0], low[1]),
                self.texel(high[0], low[1]),
                self.texel(low[0], high[1]),
                self.texel(high[0], high[1]),
            ],
            weight[0],
            weight[1],
        )
    }
}

/// The four entries contain coordinates/displacement only, never paint colors.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub node_point: [f32; 2],
    pub displacement: [f32; 2],
}

/// Axis-aligned affine shader contract. General affine matrix contraction and
/// nested capture contexts remain outside this calibrated numeric path.
pub struct ShaderParameters {
    clipped: bool,
    scale: f32,
    capture_pixels: u32,
    original_pixels: Option<u32>,
    node_to_tile: Affine,
    tile_to_node: Affine,
    center: [f32; 2],
    frequency: [f32; 2],
    radius: f32,
}

fn axis_aligned(m: Affine) -> bool {
    m.iter().all(|v| v.is_finite()) && m[0] > 0. && m[4] > 0. && m[1] == 0. && m[3] == 0.
}

fn shader_point(m: Affine, p: [f32; 2]) -> [f32; 2] {
    [p[0].mul_add(m[0], m[2]), p[1].mul_add(m[4], m[5])]
}

fn forward_uv_finite(
    node_to_tile: Affine,
    scale: f32,
    clipped: bool,
    moved_node: [f32; 2],
) -> [f32; 2] {
    let diagonal = [node_to_tile[0], node_to_tile[4]];
    let translation = [node_to_tile[2], node_to_tile[5]];
    std::array::from_fn(|i| {
        // The independent natural shaders have different contraction graphs:
        // clipped reuses the forward transform; unclipped has a single use.
        // Neither graph is equivalent to first rounding the complete matrix
        // product and then subtracting 0.5. Preserve both rounding boundaries.
        let centered = if clipped {
            moved_node[i].mul_add(diagonal[i], translation[i] - 0.5)
        } else {
            moved_node[i].mul_add(diagonal[i], -0.5) + translation[i]
        };
        centered.mul_add(scale, 0.5)
    })
}

/// The measured axis-aligned forward lookup arithmetic, independently of
/// scene eligibility and source-paint interpolation. Negative diagonal values
/// are covered by synthetic GPU controls; general affine terms are not.
/// `moved_node` has already rounded the node-plus-displacement operation.
pub fn forward_uv(
    node_to_tile: Affine,
    scale: f32,
    clipped: bool,
    moved_node: [f32; 2],
) -> Result<[f32; 2], String> {
    if node_to_tile.iter().any(|v| !v.is_finite())
        || node_to_tile[0] == 0.
        || node_to_tile[4] == 0.
        || node_to_tile[1] != 0.
        || node_to_tile[3] != 0.
        || !scale.is_finite()
        || !(0. < scale && scale <= 1.)
        || moved_node.iter().any(|v| !v.is_finite())
    {
        return Err("Unsupported or invalid texture forward transform".into());
    }
    let result = forward_uv_finite(node_to_tile, scale, clipped, moved_node);
    if result.iter().any(|v| !v.is_finite()) {
        return Err("Texture forward transform exceeds binary32 range".into());
    }
    Ok(result)
}

impl ShaderParameters {
    pub fn new(plan: &Plan) -> Result<Self, String> {
        if !axis_aligned(plan.node_to_tile)
            || !axis_aligned(plan.tile_to_node)
            || !plan.scale.is_finite()
            || !(0. ..=1.).contains(&plan.scale)
            || plan.scale == 0.
            || !plan.radius.is_finite()
            || plan.radius < 0.
            || plan.node_center.iter().any(|v| !v.is_finite())
            || plan
                .noise_reciprocal
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
            || !(4..=16_384).contains(&plan.capture_pixels)
            || plan
                .original_pixels
                .is_some_and(|v| !(4..=plan.capture_pixels).contains(&v))
            || plan.use_expanded_only != plan.original_pixels.is_none()
            || (!plan.clipped && plan.original_pixels.is_some())
        {
            return Err("Unsupported or invalid texture capture shader parameters".into());
        }
        Ok(Self {
            clipped: plan.clipped,
            scale: plan.scale,
            capture_pixels: plan.capture_pixels,
            original_pixels: plan.original_pixels,
            node_to_tile: plan.node_to_tile,
            tile_to_node: plan.tile_to_node,
            center: plan.node_center,
            frequency: plan.noise_reciprocal,
            radius: plan.radius,
        })
    }

    /// `uv` is the actual interpolated effect-quad coordinate. The caller must
    /// independently establish when fragment-center/N is an equivalent value.
    pub fn field(&self, uv: [f32; 2]) -> Result<Field, String> {
        if uv.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite texture capture field coordinate".into());
        }
        let node_point = shader_point(self.tile_to_node, uv);
        let q = std::array::from_fn(|i| node_point[i] - self.center[i]);
        let displacement =
            texture_noise::displacement_with_reciprocal(q, self.frequency, self.radius)
                .map_err(|e| e.to_string())?
                .offset;
        Ok(Field {
            node_point,
            displacement,
        })
    }

    fn expanded(&self, tile: [f32; 2]) -> [f32; 2] {
        tile.map(|v| (v - 0.5).mul_add(self.scale, 0.5))
    }

    fn displaced_uv(&self, node: [f32; 2]) -> [f32; 2] {
        forward_uv_finite(self.node_to_tile, self.scale, self.clipped, node)
    }

    /// Bind already-rendered child resources once, before visiting pixels.
    pub fn bind<'p, 'a>(
        &'p self,
        expanded: Rgba8<'a>,
        original: Option<Rgba8<'a>>,
    ) -> Result<Effect<'p, 'a>, String> {
        if expanded.side != self.capture_pixels || original.map(Rgba8::side) != self.original_pixels
        {
            return Err("Texture capture attachments disagree with their plan".into());
        }
        Ok(Effect {
            parameters: self,
            expanded,
            original,
        })
    }
}

pub struct Effect<'p, 'a> {
    parameters: &'p ShaderParameters,
    expanded: Rgba8<'a>,
    original: Option<Rgba8<'a>>,
}

impl Effect<'_, '_> {
    /// The effect target uses COPY; it never composites against a background.
    /// The attenuated resample falls back to the original when either alpha
    /// is zero, retaining the original's filtered (potentially fractional) alpha.
    pub fn shade(&self, uv: [f32; 2], field: Field) -> Result<[u8; 4], String> {
        if uv
            .iter()
            .chain(&field.node_point)
            .chain(&field.displacement)
            .any(|v| !v.is_finite())
        {
            return Err("Nonfinite texture capture field".into());
        }
        let p = self.parameters;
        let moved = std::array::from_fn(|i| field.node_point[i] + field.displacement[i]);
        let first = self.expanded.sample(p.displaced_uv(moved))?;
        let value = if p.clipped {
            let original = match self.original {
                Some(texture) => texture.sample(uv)?,
                None => self.expanded.sample(p.expanded(uv))?,
            };
            let weight = texture_noise::clip_weight::evaluate(original[3], first[3])
                .map_err(|e| e.to_string())?;
            let adjusted =
                std::array::from_fn(|i| field.displacement[i].mul_add(weight, field.node_point[i]));
            let adjusted = self.expanded.sample(p.displaced_uv(adjusted))?;
            if original[3] > 0. && adjusted[3] > 0. {
                adjusted
            } else {
                original
            }
        } else {
            first
        };
        Ok(value.map(encode_unorm8))
    }
}

/// Final ordinary source-over blit: retain Q4 sample precision through the
/// blend FMA, then perform the parent's single UNORM8 store. This is separate
/// from the four-pass export accumulator's constant-color interpolation.
pub fn copyback(effect: Rgba8<'_>, uv: [f32; 2], destination: [u8; 4]) -> Result<[u8; 4], String> {
    let source = effect.sample(uv)?;
    let inverse_alpha = 1. - source[3];
    Ok(std::array::from_fn(|i| {
        let destination = normalize_q4(u32::from(destination[i]) * 16);
        encode_unorm8(destination.mul_add(inverse_alpha, source[i]).clamp(0., 1.))
    }))
}

fn checked_edges(rect: Rect) -> Result<[i32; 4], String> {
    let right = i64::from(rect.x) + i64::from(rect.w);
    let bottom = i64::from(rect.y) + i64::from(rect.h);
    Ok([
        rect.x,
        rect.y,
        i32::try_from(right).map_err(|_| "Texture replay rectangle overflow")?,
        i32::try_from(bottom).map_err(|_| "Texture replay rectangle overflow")?,
    ])
}

/// Render the independent effect attachment within its integer destination
/// quad. The callback supplies the actual effect varying; choosing a finite
/// interpolation approximation remains the replay planner's responsibility.
pub(crate) fn render_effect(
    template: &Surface,
    plan: &Plan,
    expanded: &ByteSurface,
    original: Option<&ByteSurface>,
    mut coordinates: impl FnMut(u32, u32) -> Result<[f32; 2], String>,
) -> Result<ByteSurface, String> {
    let parameters = ShaderParameters::new(plan)?;
    let effect = parameters.bind(expanded.as_rgba8(), original.map(ByteSurface::as_rgba8))?;
    let [x, y, width, height] = plan.effect_rect;
    let width = u32::try_from(width).map_err(|_| "Negative texture effect width")?;
    let height = u32::try_from(height).map_err(|_| "Negative texture effect height")?;
    let [left, top, right, bottom] = checked_edges(Rect::new(x, y, width, height))?;
    let n = plan.capture_pixels as f32;
    let expected_quad = [
        left as f32 / n,
        top as f32 / n,
        right as f32 / n,
        bottom as f32 / n,
    ];
    if plan.effect_quad.map(f32::to_bits) != expected_quad.map(f32::to_bits) {
        return Err("Texture effect quad disagrees with its integer bounds".into());
    }
    let mut target = ByteSurface::new(template, plan.capture_pixels)?;
    let side = plan.capture_pixels as i32;
    for y in top.max(0)..bottom.min(side) {
        for x in left.max(0)..right.min(side) {
            let uv = coordinates(x as u32, y as u32)?;
            let field = parameters.field(uv)?;
            let rgba = effect.shade(uv, field)?;
            let offset = (y as usize * target.side as usize + x as usize) * 4;
            target.pixels[offset..offset + 4].copy_from_slice(&rgba);
        }
    }
    Ok(target)
}

/// Composite onto an already RGBA8-normalized CPU parent. The caller supplies
/// the clipped destination coverage and the independently planned varying.
/// All pixels are staged under the frame memory budget before any parent
/// mutation, so a coordinate/domain error cannot leave a partially written
/// parent available to a fallback renderer.
pub(crate) fn copyback_surface(
    parent: &mut Surface,
    effect: Rgba8<'_>,
    region: Rect,
    mut coordinates: impl FnMut(i32, i32) -> Result<[f32; 2], String>,
) -> Result<(), String> {
    let [px, py, pr, pb] = checked_edges(parent.rect)?;
    let expected = (parent.rect.w as usize)
        .checked_mul(parent.rect.h as usize)
        .ok_or("Texture parent storage size overflow")?;
    if expected != parent.pixels.len() {
        return Err("Texture parent storage disagrees with its bounds".into());
    }
    let [x, y, right, bottom] = checked_edges(region)?;
    let left = x.max(px);
    let top = y.max(py);
    let right = right.min(pr);
    let bottom = bottom.min(pb);
    if left >= right || top >= bottom {
        return Ok(());
    }
    let width = (i64::from(right) - i64::from(left)) as usize;
    let height = (i64::from(bottom) - i64::from(top)) as usize;
    let count = width
        .checked_mul(height)
        .ok_or("Texture copyback staging size overflow")?;
    let _allocation = parent.reserve_scratch::<[u8; 4]>(count)?;
    let byte_count = count
        .checked_mul(4)
        .ok_or("Texture copyback byte size overflow")?;
    let mut staged = Vec::new();
    staged
        .try_reserve_exact(byte_count)
        .map_err(|_| "Could not allocate texture copyback staging")?;
    for y in top..bottom {
        for x in left..right {
            let index = (i64::from(y) - i64::from(py)) as usize * parent.rect.w as usize
                + (i64::from(x) - i64::from(px)) as usize;
            let value = parent.pixels[index].0;
            if value
                .iter()
                .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
            {
                return Err("Invalid texture copyback destination color".into());
            }
            let bytes = value.map(encode_unorm8);
            if std::array::from_fn::<_, 4, _>(|i| normalize_q4(u32::from(bytes[i]) * 16))
                .map(f32::to_bits)
                != value.map(f32::to_bits)
            {
                return Err("Texture copyback requires an RGBA8-normalized parent".into());
            }
            staged.extend_from_slice(&copyback(effect, coordinates(x, y)?, bytes)?);
        }
    }
    for (row, y) in (top..bottom).enumerate() {
        for (column, x) in (left..right).enumerate() {
            let index = (i64::from(y) - i64::from(py)) as usize * parent.rect.w as usize
                + (i64::from(x) - i64::from(px)) as usize;
            let source = (row * width + column) * 4;
            parent.pixels[index] = Pixel(std::array::from_fn(|i| {
                normalize_q4(u32::from(staged[source + i]) * 16)
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod replay_tests {
    use super::*;
    use crate::{memory::Budget, texture_capture_plan};

    #[test]
    fn owned_bytes_charge_storage_and_release_the_live_reservation() {
        let budget = Budget::new(32);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        assert!(ByteSurface::new(&template, 0).is_err());
        assert!(ByteSurface::new(&template, 4097).is_err());
        let bytes = ByteSurface::new(&template, 2).unwrap();
        assert_eq!(bytes.as_rgba8().side(), 2);
        assert_eq!(bytes.as_rgba8().pixels.len(), 16);
        assert_eq!(budget.usage().live_bytes, 32);
        assert_eq!(budget.usage().allocated_surface_pixels, 5);
        assert!(ByteSurface::new(&template, 1).is_err());
        drop(bytes);
        assert_eq!(budget.usage().live_bytes, 16);
        assert_eq!(budget.usage().live_surface_pixels, 1);
        assert_eq!(budget.usage().allocated_surface_pixels, 5);
    }

    #[test]
    fn copyback_errors_are_atomic_and_staging_is_budgeted() {
        let budget = Budget::new(80);
        let mut parent = Surface::new_in(Rect::new(10, 20, 2, 2), &budget).unwrap();
        parent.pixels.fill(Pixel([1.; 4]));
        let before = parent.pixels.clone();
        let source = Rgba8::new(1, &[64, 32, 16, 128]).unwrap();
        let region = parent.rect;
        assert!(
            copyback_surface(&mut parent, source, region, |x, y| {
                if (x, y) == (11, 21) {
                    Err("Synthetic late coordinate failure".into())
                } else {
                    Ok([0.5; 2])
                }
            })
            .is_err()
        );
        assert_eq!(parent.pixels, before);
        assert_eq!(budget.usage().live_bytes, 64);
        assert_eq!(budget.usage().peak_bytes, 80);
        assert_eq!(budget.usage().allocated_surface_pixels, 4);

        copyback_surface(&mut parent, source, region, |_, _| Ok([0.5; 2])).unwrap();
        let expected = copyback(source, [0.5; 2], [255; 4]).unwrap();
        for pixel in &parent.pixels {
            assert_eq!(pixel.0.map(encode_unorm8), expected);
        }
        parent.pixels[3] = Pixel([0.5; 4]);
        let before = parent.pixels.clone();
        assert!(copyback_surface(&mut parent, source, region, |_, _| Ok([0.5; 2])).is_err());
        assert_eq!(parent.pixels, before, "No hidden destination quantization");

        let limited = Budget::new(79);
        let mut parent = Surface::new_in(Rect::new(0, 0, 2, 2), &limited).unwrap();
        assert!(
            copyback_surface(&mut parent, source, Rect::new(0, 0, 2, 2), |_, _| {
                panic!("Budget admission precedes coordinate evaluation")
            })
            .is_err()
        );
        assert_eq!(limited.usage().live_bytes, 64);
    }

    #[test]
    fn effect_render_validates_resources_and_integer_quad_before_iteration() {
        let texture_capture_plan::Outcome::Capture(mut plan) =
            texture_capture_plan::compile(texture_capture_plan::Input {
                view: [1., 0., 0., 0., 1., 0.],
                node_to_render: [1., 0., 0., 0., 1., 0.],
                render_bounds: [0., 0., 1., 1.],
                capture_source_bounds_render: None,
                active_bounds: [0., 0., 1., 1.],
                radius: 0.25,
                noise_size: [8.; 2],
                node_center: [0.5; 2],
                clipped: false,
                parent_pixels: 4,
                capture_pixels: 8,
                original_pixels: 4,
            })
            .unwrap()
        else {
            panic!("Expected active capture")
        };
        // Zero radius isolates resource traversal while retaining a valid
        // captured plan. Effect field and source sampling still execute.
        plan.radius = 0.;
        let budget = Budget::new(1024);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        let mut source = ByteSurface::new(&template, 8).unwrap();
        for pixel in source.pixels_mut().chunks_exact_mut(4) {
            pixel.copy_from_slice(&[17, 23, 42, 255]);
        }
        let rendered = render_effect(&template, &plan, &source, None, |x, y| {
            Ok([(x as f32 + 0.5) / 8., (y as f32 + 0.5) / 8.])
        })
        .unwrap();
        assert!(
            rendered
                .pixels
                .chunks_exact(4)
                .all(|p| p == [17, 23, 42, 255])
        );
        drop(rendered);
        let live = budget.usage().live_bytes;
        assert!(
            render_effect(&template, &plan, &source, None, |_, _| Err(
                "coordinate".into()
            ))
            .is_err()
        );
        assert_eq!(budget.usage().live_bytes, live);
        plan.effect_quad[0] += 0.125;
        assert!(
            render_effect(&template, &plan, &source, None, |_, _| panic!(
                "Invalid quad"
            ))
            .is_err()
        );
        plan.effect_rect[2] = -1;
        assert!(
            render_effect(&template, &plan, &source, None, |_, _| panic!(
                "Negative width"
            ))
            .is_err()
        );
    }
}
