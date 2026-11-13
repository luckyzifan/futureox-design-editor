//! Background replay for a bounded, explicitly checked scene structure.
//!
//! The recipe contains primitive geometry and authored paint colours, never
//! rasterized CPU pixels. General groups, masks, transparency and paths remain
//! on the existing path until their replay semantics are independently checked.
use crate::{
    blend::{Pixel, Surface},
    capture_plan::{CaptureInput, compile},
    fidelity::SAMPLE_OFFSETS,
    math::{Point, Rect, Transform},
    scene::{Document, Effect, Node},
};
use serde::{Deserialize, Serialize};

pub const EXPORT_TILE_PIXELS: i32 = 512;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayPrimitive {
    pub transform: Transform,
    pub size: [f64; 2],
    pub color: [f32; 4],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replay {
    /// Device transform of the parent after ordinary scene composition.
    pub parent_matrix: Transform,
    /// Keep document and camera transforms separate for capture projection.
    /// Cancelling a large world translation in f64 first changes f32/Q8 edges.
    pub parent_world_transform: Transform,
    pub camera_matrix: Transform,
    pub parent_size: [f64; 2],
    /// Nominal device bounds before integer coverage or export-camera jitter.
    pub lens_bounds: [f64; 4],
    pub lens_rect: Rect,
    pub primitives: Vec<ReplayPrimitive>,
    pub effective_frost: f32,
    pub support: f32,
    pub side: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedPrimitive {
    pub rect: Rect,
    pub color: [f32; 4],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TilePlan {
    pub side: u32,
    pub origin: [i32; 2],
    pub density: f32,
    pub kernel_count: f32,
    pub bounds: [f32; 4],
    pub primitives: Vec<ProjectedPrimitive>,
}

/// Finite capture-pass geometry shared by independent pixel renderers.
/// Coordinates are in target pixels; gradient and source_origin are UV values.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterPlan {
    pub down_rect: Rect,
    pub blur_rect: Rect,
    pub origin: [f32; 2],
    pub gradient: [f32; 2],
    pub source_origin: [f32; 2],
}

fn plain_rect(node: &Node) -> bool {
    matches!(node.kind.as_str(), "rectangle" | "frame")
        && node.network.is_none()
        && node.derived_path.is_none()
        && node.radii == [0.; 4]
        && node.smoothing == 0.
        && node.opacity == 1.
        && node.composite_blend() == "normal"
        && !node.mask
        && node.strokes.iter().all(|p| !p.visible || p.width <= 0.)
        && node.effects.iter().all(|e| !e.visible)
}

fn opaque_colour(node: &Node) -> Option<[f32; 4]> {
    let paint = node.fills.iter().rev().find(|p| p.visible)?;
    if paint.kind != "solid" || paint.blend != "normal" || paint.opacity != 1. {
        return None;
    }
    Pixel::hex(&paint.color, 1.)
        .ok()
        .filter(|p| p.0[3] == 1.)
        .map(|p| p.0)
}

fn axis_aligned(matrix: Transform) -> bool {
    let m = matrix.0;
    m.iter().all(|v| v.is_finite()) && m[1] == 0. && m[2] == 0. && m[0] > 0. && m[3] > 0.
}

fn bounds(matrix: Transform, size: [f64; 2]) -> [f64; 4] {
    let a = matrix.point(Point::default());
    let b = matrix.point(Point::new(size[0], size[1]));
    [a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y)]
}

fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// Preserve the original frost for primitive inclusion. The minimum filter
/// radius is separate: r=0 excludes a just-touching neighbour; r>0 can include
/// the whole neighbour even when the effective filter is still one unit.
pub fn recipe(
    doc: &Document,
    node: &Node,
    matrix: Transform,
    effect: &Effect,
) -> Result<Option<Replay>, String> {
    let Some(glass) = effect.evaluated_glass() else {
        return Ok(None);
    };
    if doc.color_management.is_some()
        || node.opacity != 1.
        || node.mask
        || node.composite_blend() != "normal"
        || !node.children.is_empty()
        || node.effects.iter().filter(|e| e.visible).count() != 1
        || node.strokes.iter().any(|p| p.visible && p.width > 0.)
        || node.transform.0[..4] != [1., 0., 0., 1.]
        || crate::optics::GlassShape::from_node(node).is_none()
    {
        return Ok(None);
    }
    // This bound avoids the not-yet-identified extra corner/depth limiting
    // branch. It is structural and independent of reference case identities.
    if glass.bevel_size() != 1. || glass.depth > node.width.min(node.height) * 0.5 - node.radii[0] {
        return Ok(None);
    }
    let Some(parent) = doc
        .nodes
        .values()
        .find(|p| p.render_children().last() == Some(&node.id))
    else {
        return Ok(None);
    };
    if !plain_rect(parent)
        || !parent.clip
        || !doc
            .pages
            .iter()
            .any(|p| p.children.as_slice() == [parent.id.as_str()])
        || doc.mask_child(parent).is_some()
    {
        return Ok(None);
    }
    let Some(background) = opaque_colour(parent) else {
        return Ok(None);
    };
    let lens = bounds(node.transform, [node.width, node.height]);
    if lens[0] < 0. || lens[1] < 0. || lens[2] > parent.width || lens[3] > parent.height {
        return Ok(None);
    }
    let parent_matrix = matrix.concat(node.transform.inverse()?);
    let parent_world_transform = parent.transform;
    let camera_matrix = parent_matrix.concat(parent_world_transform.inverse()?);
    if !axis_aligned(parent_matrix)
        || !axis_aligned(parent_world_transform)
        || !axis_aligned(camera_matrix)
    {
        return Ok(None);
    }
    let mut query = bounds(node.transform, [node.width, node.height]);
    query[0] -= effect.radius;
    query[1] -= effect.radius;
    query[2] += effect.radius;
    query[3] += effect.radius;
    let mut primitives = vec![ReplayPrimitive {
        transform: Transform::default(),
        size: [parent.width, parent.height],
        color: background,
    }];
    for id in parent
        .render_children()
        .iter()
        .take(parent.render_children().len() - 1)
    {
        let child = &doc.nodes[id];
        if !child.visible || child.opacity <= 0. {
            continue;
        }
        if !plain_rect(child) || !child.children.is_empty() || !axis_aligned(child.transform) {
            return Ok(None);
        }
        let Some(color) = opaque_colour(child) else {
            return Ok(None);
        };
        if intersects(bounds(child.transform, [child.width, child.height]), query) {
            primitives.push(ReplayPrimitive {
                transform: child.transform,
                size: [child.width, child.height],
                color,
            });
        }
    }
    if primitives.len() > 4096 {
        return Err("Glass capture primitive budget exceeded".into());
    }
    let optical = (glass.depth as f32) * (glass.refraction as f32 + glass.chromatic_aberration());
    let frost = effect.backdrop_radius() as f32;
    let lens_device = bounds(matrix, [node.width, node.height]);
    let lens_rect = Rect::new(
        lens_device[0].floor() as i32,
        lens_device[1].floor() as i32,
        (lens_device[2].ceil() - lens_device[0].floor()) as u32,
        (lens_device[3].ceil() - lens_device[1].floor()) as u32,
    );
    Ok(Some(Replay {
        parent_matrix,
        parent_world_transform,
        camera_matrix,
        parent_size: [parent.width, parent.height],
        lens_bounds: lens_device,
        lens_rect,
        primitives,
        effective_frost: frost,
        support: frost + optical,
        side: if frost <= 4. && optical >= 10. {
            1024
        } else {
            512
        },
    }))
}

fn mul(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[1] * b[3],
        a[0] * b[1] + a[1] * b[4],
        (a[2] + a[0] * b[2]) + a[1] * b[5],
        a[3] * b[0] + a[4] * b[3],
        a[3] * b[1] + a[4] * b[4],
        (a[5] + a[3] * b[2]) + a[4] * b[5],
    ]
}
fn row_major(m: Transform) -> [f32; 6] {
    [
        m.0[0] as f32,
        m.0[2] as f32,
        m.0[4] as f32,
        m.0[1] as f32,
        m.0[3] as f32,
        m.0[5] as f32,
    ]
}
fn raster_rectangle(m: [f32; 6], size: [f64; 2], side: u32) -> Rect {
    let point = |x: f32, y: f32| {
        [
            ((m[0] * x + m[2]) + m[1] * y) * side as f32,
            ((m[3] * x + m[5]) + m[4] * y) * side as f32,
        ]
    };
    let a = point(0., 0.);
    let b = point(size[0] as f32, size[1] as f32);
    let edge = |v: f32| ((f64::from(v) * 256. + 0.5).floor() / 256. - 0.5).ceil() as i32;
    let x = edge(a[0].min(b[0]));
    let y = edge(a[1].min(b[1]));
    Rect::new(
        x,
        y,
        (edge(a[0].max(b[0])) - x).max(0) as u32,
        (edge(a[1].max(b[1])) - y).max(0) as u32,
    )
}

impl Replay {
    /// Validate the serialized geometry recipe before allocating a target or
    /// converting projected coordinates to the integer raster domain.
    pub fn validate(&self) -> Result<(), String> {
        const LIMIT: f64 = 16_777_216.;
        let valid_size =
            |size: [f64; 2]| size.iter().all(|v| v.is_finite() && *v > 0. && *v <= LIMIT);
        let valid_matrix =
            |matrix: Transform| axis_aligned(matrix) && matrix.0.iter().all(|v| v.abs() <= LIMIT);
        let valid_bounds = |rect: [f64; 4]| {
            rect.iter().all(|v| v.is_finite() && v.abs() <= LIMIT)
                && rect[0] < rect[2]
                && rect[1] < rect[3]
        };
        if !matches!(self.side, 512 | 1024)
            || !self.effective_frost.is_finite()
            || self.effective_frost < 1.
            || !self.support.is_finite()
            || self.support < self.effective_frost
            || !valid_matrix(self.parent_matrix)
            || !valid_matrix(self.parent_world_transform)
            || !valid_matrix(self.camera_matrix)
            || !valid_size(self.parent_size)
            || self.primitives.is_empty()
            || self.primitives.len() > 4096
        {
            return Err("Invalid glass capture replay".into());
        }
        let parent = bounds(self.parent_matrix, self.parent_size);
        if !valid_bounds(parent)
            || !valid_bounds(self.lens_bounds)
            || self.lens_rect.empty()
            || f64::from(self.lens_rect.x) != self.lens_bounds[0].floor()
            || f64::from(self.lens_rect.y) != self.lens_bounds[1].floor()
            || (i64::from(self.lens_rect.x) + i64::from(self.lens_rect.w)) as f64
                != self.lens_bounds[2].ceil()
            || (i64::from(self.lens_rect.y) + i64::from(self.lens_rect.h)) as f64
                != self.lens_bounds[3].ceil()
            || f64::from(self.lens_rect.x) < parent[0].floor()
            || f64::from(self.lens_rect.y) < parent[1].floor()
            || (i64::from(self.lens_rect.x) + i64::from(self.lens_rect.w)) as f64 > parent[2].ceil()
            || (i64::from(self.lens_rect.y) + i64::from(self.lens_rect.h)) as f64 > parent[3].ceil()
        {
            return Err("Invalid glass capture parent or lens bounds".into());
        }
        for primitive in &self.primitives {
            if !valid_matrix(primitive.transform)
                || !valid_size(primitive.size)
                || !valid_bounds(bounds(
                    self.parent_matrix.concat(primitive.transform),
                    primitive.size,
                ))
                || primitive.color[3] != 1.
                || primitive
                    .color
                    .iter()
                    .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
            {
                return Err("Invalid glass capture primitive".into());
            }
        }
        let background = &self.primitives[0];
        if background.transform != Transform::default() || background.size != self.parent_size {
            return Err("Glass capture requires its opaque parent background first".into());
        }
        Ok(())
    }

    fn tile_anchor(&self) -> [i32; 2] {
        // Export tiling starts at the outward-rounded root-frame origin.
        // A cropped viewport must translate this grid with its camera rather
        // than start a new capture phase at the temporary viewport's zero.
        [
            self.parent_matrix.0[4].floor() as i32,
            self.parent_matrix.0[5].floor() as i32,
        ]
    }

    pub fn tiles(&self, region: Rect) -> Vec<([i32; 2], Rect)> {
        let region = region.intersect(self.lens_rect);
        if region.empty() {
            return Vec::new();
        }
        let anchor = self.tile_anchor();
        let mut tiles = Vec::new();
        for y in (region.y - anchor[1]).div_euclid(EXPORT_TILE_PIXELS)
            ..=(region.bottom() - 1 - anchor[1]).div_euclid(EXPORT_TILE_PIXELS)
        {
            for x in (region.x - anchor[0]).div_euclid(EXPORT_TILE_PIXELS)
                ..=(region.right() - 1 - anchor[0]).div_euclid(EXPORT_TILE_PIXELS)
            {
                let origin = [
                    anchor[0] + x * EXPORT_TILE_PIXELS,
                    anchor[1] + y * EXPORT_TILE_PIXELS,
                ];
                tiles.push((
                    origin,
                    Rect::new(origin[0], origin[1], 512, 512).intersect(region),
                ));
            }
        }
        tiles
    }
    pub fn tile(&self, origin: [i32; 2], sample: usize) -> Result<TilePlan, String> {
        self.validate()?;
        let anchor = self.tile_anchor();
        if origin.iter().zip(anchor).any(|(v, a)| {
            v.abs_diff(0) > 16_777_216
                || (i64::from(*v) - i64::from(a)) % i64::from(EXPORT_TILE_PIXELS) != 0
        }) {
            return Err("Invalid glass capture tile origin".into());
        }
        let &(sx, sy) = SAMPLE_OFFSETS.get(sample).ok_or("Invalid capture sample")?;
        let mut view = row_major(self.camera_matrix).map(|v| v / 512.);
        view[2] = (view[2] - origin[0] as f32 / 512.) + (0.5 - sx) as f32 / 512.;
        view[5] = (view[5] - origin[1] as f32 / 512.) + (0.5 - sy) as f32 / 512.;
        let normalized_parent = mul(view, row_major(self.parent_world_transform));
        let row_scale = (normalized_parent[0] * normalized_parent[0]
            + normalized_parent[1] * normalized_parent[1])
            .max(
                normalized_parent[3] * normalized_parent[3]
                    + normalized_parent[4] * normalized_parent[4],
            )
            .sqrt();
        let col_scale = (normalized_parent[0] * normalized_parent[0]
            + normalized_parent[3] * normalized_parent[3])
            .sqrt()
            .max(
                (normalized_parent[1] * normalized_parent[1]
                    + normalized_parent[4] * normalized_parent[4])
                    .sqrt(),
            );
        let parent = bounds(self.parent_matrix, self.parent_size);
        let rect = [
            ((self.lens_bounds[0].max(parent[0]) - f64::from(origin[0])) / 512.).max(0.) as f32,
            ((self.lens_bounds[1].max(parent[1]) - f64::from(origin[1])) / 512.).max(0.) as f32,
            ((self.lens_bounds[2].min(parent[2]) - f64::from(origin[0])) / 512.).min(1.) as f32,
            ((self.lens_bounds[3].min(parent[3]) - f64::from(origin[1])) / 512.).min(1.) as f32,
        ];
        let plan = compile(CaptureInput {
            normalized_support: self.support * row_scale,
            normalized_blur: self.effective_frost * col_scale,
            target_pixels: self.side,
            source_pixels: 1024,
            divisor: 1,
            transform: view,
            bounds: rect,
        })
        .map_err(|e| e.to_string())?;
        let full = Rect::new(0, 0, self.side, self.side);
        let clip = raster_rectangle(
            mul(plan.transform, row_major(self.parent_world_transform)),
            self.parent_size,
            self.side,
        )
        .intersect(full);
        let scissor = Rect::new(
            plan.pixel_bounds[0],
            plan.pixel_bounds[1],
            plan.pixel_bounds[2] as u32,
            plan.pixel_bounds[3] as u32,
        )
        .intersect(full);
        let primitives = self
            .primitives
            .iter()
            .map(|p| ProjectedPrimitive {
                rect: raster_rectangle(
                    mul(
                        plan.transform,
                        row_major(self.parent_world_transform.concat(p.transform)),
                    ),
                    p.size,
                    self.side,
                )
                .intersect(clip)
                .intersect(scissor),
                color: p.color,
            })
            .filter(|p| !p.rect.empty())
            .collect();
        Ok(TilePlan {
            side: self.side,
            origin,
            density: plan.density,
            kernel_count: plan.kernel_count * 0.5,
            bounds: plan.expanded_bounds,
            primitives,
        })
    }
}

pub fn sample(input: &Surface, p: [f32; 2]) -> Pixel {
    sample_with_raster(input, p, false)
}

pub fn sample_with_raster(input: &Surface, p: [f32; 2], software: bool) -> Pixel {
    let q = p.map(|v| v - 0.5);
    let base = q.map(|v| v.floor() as i32);
    let wx = crate::figma_sampling::fraction_q8(q[0] - q[0].floor());
    let wy = crate::figma_sampling::fraction_q8(q[1] - q[1].floor());
    let at = |dx: i32, dy: i32| {
        input
            .at(
                (base[0] + dx).clamp(0, input.rect.w as i32 - 1),
                (base[1] + dy).clamp(0, input.rect.h as i32 - 1),
            )
            .0
            .map(|v| (v * 255.).round_ties_even() as u8)
    };
    // The separable software sample was a code off the Chrome export on the
    // finished capture. Both profiles read that texture with the joint Q4 sampler.
    let _ = software;
    let sampler = crate::figma_sampling::sample_q8;
    Pixel(sampler([at(0, 0), at(1, 0), at(0, 1), at(1, 1)], wx, wy))
}
fn encoded(pixel: [f32; 4]) -> [u8; 4] {
    pixel.map(|v| crate::figma_sampling::encode_unorm8(v.clamp(0., 1.)))
}

#[inline]
fn encoded_with_raster<const SOFTWARE: bool>(pixel: [f32; 4]) -> [u8; 4] {
    if SOFTWARE {
        pixel.map(|v| crate::software_raster::encode_unorm8(v.clamp(0., 1.)))
    } else {
        encoded(pixel)
    }
}

#[inline]
fn normalized_byte<const SOFTWARE: bool>(value: u8, normal: &[f32; 4081]) -> f32 {
    if SOFTWARE {
        crate::software_raster::normalize_byte(value)
    } else {
        normal[usize::from(value) * 16]
    }
}

struct ByteSurface {
    pixels: Vec<[u8; 4]>,
    _allocation: Option<crate::memory::Allocation>,
}
impl ByteSurface {
    fn new(template: &Surface, count: usize) -> Result<Self, String> {
        if count > 16_777_216 {
            return Err("Layer surface exceeds 16 million pixels".into());
        }
        let allocation = template.reserve_surface::<[u8; 4]>(count)?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(count)
            .map_err(|_| "Could not allocate capture bytes")?;
        pixels.resize(count, [0; 4]);
        Ok(Self {
            pixels,
            _allocation: allocation,
        })
    }
}

#[derive(Clone, Copy)]
struct AxisSample {
    low: usize,
    high: usize,
    weight: u32,
}
impl AxisSample {
    fn new(position: f32, side: usize) -> Self {
        let q = position - 0.5;
        let base = q.floor();
        Self {
            low: base.clamp(0., (side - 1) as f32) as usize,
            high: (base + 1.).clamp(0., (side - 1) as f32) as usize,
            weight: crate::figma_sampling::fraction_q8(q - base),
        }
    }
}
#[derive(Clone, Copy)]
struct PairedTap {
    left: AxisSample,
    right: AxisSample,
    weight: f32,
}
struct AxisProgram {
    taps: Vec<PairedTap>,
    count: usize,
    center_weight: f32,
    reciprocal: f32,
    _allocation: Option<crate::memory::Allocation>,
}
impl AxisProgram {
    fn new(template: &Surface, side: usize, count: f32) -> Result<Self, String> {
        // Kernel weights do not depend on the pixel. Preserve the original
        // separate f32 operations, including the order of weight accumulation.
        let mut kernel = [[0.; 5]; 32];
        let mut length = 0;
        let mut weight = count;
        for k in (1..64).step_by(2) {
            if k as f32 > count {
                break;
            }
            let a = k as f32;
            let b = ((k + 1) as f32).min(count);
            let wa = count - a;
            let wb = count - b;
            let pair = wa + wb;
            if pair == 0. {
                continue;
            }
            kernel[length] = [a, b, wa, wb, pair];
            length += 1;
            weight += 2. * pair;
        }
        let allocation = template.reserve_scratch::<PairedTap>(side * length)?;
        let mut taps = Vec::new();
        taps.try_reserve_exact(side * length)
            .map_err(|_| "Could not allocate capture taps")?;
        let delta = 1. / side as f32;
        for x in 0..side {
            let p = (x as f32 + 0.5) / side as f32;
            for &[a, b, wa, wb, pair] in &kernel[..length] {
                let left = ((p - delta * a) * wa + (p - delta * b) * wb) / pair;
                let right = ((p + delta * a) * wa + (p + delta * b) * wb) / pair;
                taps.push(PairedTap {
                    left: AxisSample::new(left * side as f32, side),
                    right: AxisSample::new(right * side as f32, side),
                    weight: pair,
                });
            }
        }
        Ok(Self {
            taps,
            count: length,
            center_weight: count,
            reciprocal: 1. / weight,
            _allocation: allocation,
        })
    }
}

#[inline]
fn sample_axis<const SOFTWARE: bool>(
    pixels: &[[u8; 4]],
    base: usize,
    stride: usize,
    at: AxisSample,
    normal: &[f32; 4081],
) -> [f32; 4] {
    let a = pixels[base + at.low * stride];
    let b = pixels[base + at.high * stride];
    std::array::from_fn(|c| {
        let _ = SOFTWARE;
        // Both export profiles sample the filter axis with the joint Q4 weight.
        // The separable byte lerp was a code high against the Chrome glass
        // export that this reduction already matches. Downsample and the
        // filter store stay on the software byte contract when SOFTWARE is set.
        // The other axis is exactly at its texel centre. Reducing the full
        // Q8xQ8 numerator cancels a factor256 before the Q4 rounding step.
        normal[((u32::from(a[c]) * (256 - at.weight) + u32::from(b[c]) * at.weight + 8) >> 4)
            as usize]
    })
}

fn filter_axis<const SOFTWARE: bool>(
    input: &ByteSurface,
    side: usize,
    program: &AxisProgram,
    normal: &[f32; 4081],
    axis: usize,
    region: Rect,
    mut store: impl FnMut(usize, [u8; 4]),
) {
    for y in region.y as usize..region.bottom() as usize {
        for x in region.x as usize..region.right() as usize {
            let index = y * side + x;
            let position = if axis == 0 { x } else { y };
            let (base, stride) = if axis == 0 { (y * side, 1) } else { (x, side) };
            let mut sum = input.pixels[index]
                .map(|v| normalized_byte::<SOFTWARE>(v, normal) * program.center_weight);
            for tap in &program.taps[position * program.count..(position + 1) * program.count] {
                let left = sample_axis::<SOFTWARE>(&input.pixels, base, stride, tap.left, normal);
                let right = sample_axis::<SOFTWARE>(&input.pixels, base, stride, tap.right, normal);
                for c in 0..4 {
                    sum[c] = tap.weight.mul_add(left[c] + right[c], sum[c]);
                }
            }
            store(
                index,
                encoded_with_raster::<SOFTWARE>(sum.map(|v| v * program.reciprocal)),
            );
        }
    }
}

/// Replays each included opaque primitive in order into a clear RGBA target.
/// Each downsample/filter pass writes only its finite planned region into an
/// otherwise clear RGBA target. No renderer supplies pixels to another backend.
pub fn render(template: &Surface, plan: &TilePlan) -> Result<Surface, String> {
    render_impl::<false>(template, plan)
}

/// Select byte arithmetic explicitly; geometry, finite pass regions, filter
/// accumulation order and allocation admission are shared with the legacy path.
pub fn render_with_raster(
    template: &Surface,
    plan: &TilePlan,
    software: bool,
) -> Result<Surface, String> {
    if software {
        render_impl::<true>(template, plan)
    } else {
        render_impl::<false>(template, plan)
    }
}

fn render_impl<const SOFTWARE: bool>(
    template: &Surface,
    plan: &TilePlan,
) -> Result<Surface, String> {
    // Public callers can construct a TilePlan without going through Replay.
    // Validate before allocating or converting floats to sampler indices.
    // Production capture targets are 512/1024; smaller targets are useful for
    // independent numerical controls and obey exactly the same filter graph.
    if plan.side == 0
        || plan.side > 1024
        || !plan.kernel_count.is_finite()
        || plan.kernel_count <= 0.
        || plan.kernel_count > 32.
        || !(1. / plan.kernel_count).is_finite()
        || plan.primitives.len() > 4096
    {
        return Err("Invalid glass capture surface or kernel".into());
    }
    for primitive in &plan.primitives {
        let rect = primitive.rect;
        if rect.x < 0
            || rect.y < 0
            || i64::from(rect.x) + i64::from(rect.w) > i64::from(plan.side)
            || i64::from(rect.y) + i64::from(rect.h) > i64::from(plan.side)
            || primitive
                .color
                .iter()
                .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
        {
            return Err("Invalid glass capture projected primitive".into());
        }
    }
    let filter = plan.filter_plan()?;
    let rect = Rect::new(0, 0, plan.side, plan.side);
    let side = plan.side as usize;
    let count = side
        .checked_mul(side)
        .ok_or("Capture surface size overflow")?;
    if filter.down_rect.empty() {
        return template.new_like(rect);
    }
    let mut source = ByteSurface::new(template, count)?;
    for p in &plan.primitives {
        if p.rect.empty() {
            continue;
        }
        let color = encoded_with_raster::<SOFTWARE>(p.color);
        for y in p.rect.y..p.rect.bottom() {
            let start = rect.index(p.rect.x, y).expect("capture primitive");
            source.pixels[start..start + p.rect.w as usize].fill(color);
        }
    }
    let _normal_allocation = template.reserve_scratch::<f32>(4081)?;
    let normal: [f32; 4081] =
        std::array::from_fn(|q| crate::figma_sampling::normalize_q4(q as u32));
    let coordinate_count = filter.down_rect.w as usize + filter.down_rect.h as usize;
    let _coordinates_allocation = template.reserve_scratch::<AxisSample>(coordinate_count)?;
    let mut coordinates = Vec::new();
    coordinates
        .try_reserve_exact(coordinate_count)
        .map_err(|_| "Could not allocate capture coordinates")?;
    for (axis, start, length) in [
        (0, filter.down_rect.x, filter.down_rect.w),
        (1, filter.down_rect.y, filter.down_rect.h),
    ] {
        for p in start..start + length as i32 {
            let distance = (p as f32 + 0.5) - filter.origin[axis];
            let uv = distance.mul_add(filter.gradient[axis], filter.source_origin[axis]);
            coordinates.push(AxisSample::new(uv * plan.side as f32, side));
        }
    }
    let (x_coordinates, y_coordinates) = coordinates.split_at(filter.down_rect.w as usize);
    let mut down = ByteSurface::new(template, count)?;
    for (row, &v) in y_coordinates.iter().enumerate() {
        let y = filter.down_rect.y as usize + row;
        for (column, &u) in x_coordinates.iter().enumerate() {
            let x = filter.down_rect.x as usize + column;
            let pixels = [
                source.pixels[v.low * side + u.low],
                source.pixels[v.low * side + u.high],
                source.pixels[v.high * side + u.low],
                source.pixels[v.high * side + u.high],
            ];
            if SOFTWARE {
                // A byte is materialized after each interpolation axis. The
                // following RGBA8 write is exact for every sampled byte.
                down.pixels[y * side + x] =
                    crate::software_raster::sample_bytes(pixels, u.weight, v.weight);
                continue;
            }
            let weights = [
                (256 - u.weight) * (256 - v.weight),
                u.weight * (256 - v.weight),
                (256 - u.weight) * v.weight,
                u.weight * v.weight,
            ];
            down.pixels[y * side + x] = std::array::from_fn(|c| {
                let numerator: u32 = (0..4).map(|i| u32::from(pixels[i][c]) * weights[i]).sum();
                crate::figma_sampling::encode_unorm8(normal[((numerator + 2048) >> 12) as usize])
            });
        }
    }
    drop(source);
    drop(coordinates);
    drop(_coordinates_allocation);
    let program = AxisProgram::new(template, side, plan.kernel_count)?;
    let mut horizontal = ByteSurface::new(template, count)?;
    filter_axis::<SOFTWARE>(
        &down,
        side,
        &program,
        &normal,
        0,
        filter.blur_rect,
        |i, pixel| horizontal.pixels[i] = pixel,
    );
    drop(down);
    // Store the last materialized byte result directly in the required Surface
    // representation. This is the fourth surface stage, not an extra fifth image.
    let mut result = template.new_like(rect)?;
    filter_axis::<SOFTWARE>(
        &horizontal,
        side,
        &program,
        &normal,
        1,
        filter.blur_rect,
        |i, pixel| {
            result.pixels[i] = Pixel(pixel.map(|v| normalized_byte::<SOFTWARE>(v, &normal)));
        },
    );
    Ok(result)
}

impl TilePlan {
    /// Compile the calibrated finite-quad interpolation contract without
    /// allocating or rendering pixels. All ordinary arithmetic rounds to f32;
    /// only the final interpolation multiply/add is contracted by renderers.
    pub fn filter_plan(&self) -> Result<FilterPlan, String> {
        if self.side == 0
            || self.side > 1024
            || self.bounds.iter().any(|v| !v.is_finite())
            || self.bounds[0] > self.bounds[2]
            || self.bounds[1] > self.bounds[3]
        {
            return Err("Invalid glass filter bounds or target".into());
        }
        let side = self.side as f32;
        let destination = self.bounds.map(|v| 0.25 + v * 0.5);
        let mut quad = [0.; 4];
        let mut coverage = [0; 4];
        let mut blur_edges = [0; 4];
        let integer = |value: f64| -> Result<i32, String> {
            if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
                Err("Glass filter pixel bounds overflow".into())
            } else {
                Ok(value as i32)
            }
        };
        for i in 0..4 {
            let clip = destination[i] * 2. - 1.;
            let screen = (clip * 0.5 + 0.5) * side;
            quad[i] = ((f64::from(screen) * 256. + 0.5).floor() / 256.) as f32;
            coverage[i] = integer((f64::from(quad[i]) - 0.5).ceil())?;
            let expanded = destination[i] * side + if i < 2 { -1. } else { 1. };
            let rounded = (expanded + f32::from_bits(0x3eff_ffff).copysign(expanded)).trunc();
            blur_edges[i] = integer(f64::from(rounded))?;
        }
        let clipped = |edges: [i32; 4]| {
            let [left, top, right, bottom] = edges.map(|v| v.clamp(0, self.side as i32));
            Rect::new(
                left,
                top,
                (right - left).max(0) as u32,
                (bottom - top).max(0) as u32,
            )
        };
        let down_rect = clipped(coverage);
        let empty = Rect::new(0, 0, 0, 0);
        let mut filter = FilterPlan {
            down_rect,
            blur_rect: clipped(blur_edges),
            origin: [quad[0], quad[1]],
            gradient: [0.; 2],
            source_origin: [self.bounds[0], self.bounds[1]],
        };
        // A valid small quad can collapse after Q8 snapping, or cover no pixel
        // centres. Its transparent result must not require an infinite reciprocal.
        if down_rect.empty() {
            filter.down_rect = empty;
            filter.blur_rect = empty;
            return Ok(filter);
        }
        let span = [quad[2] - quad[0], quad[3] - quad[1]];
        let area = span[0] * span[1];
        let reciprocal = 1. / area;
        if !area.is_finite() || area <= 0. || !reciprocal.is_finite() || reciprocal <= 0. {
            return Err("Glass filter interpolation exceeds numeric range".into());
        }
        for axis in 0..2 {
            let source_delta = self.bounds[axis + 2] - self.bounds[axis];
            filter.gradient[axis] = source_delta * (span[1 - axis] * reciprocal);
            if !filter.gradient[axis].is_finite() {
                return Err("Glass filter interpolation exceeds numeric range".into());
            }
            let endpoints = if axis == 0 {
                [down_rect.x, down_rect.right() - 1]
            } else {
                [down_rect.y, down_rect.bottom() - 1]
            };
            for pixel in endpoints {
                let distance = (pixel as f32 + 0.5) - filter.origin[axis];
                let position =
                    distance.mul_add(filter.gradient[axis], filter.source_origin[axis]) * side;
                if !position.is_finite() {
                    return Err("Glass filter sample exceeds numeric range".into());
                }
            }
        }
        Ok(filter)
    }

    pub fn coordinate(&self, p: [f32; 2]) -> [f32; 2] {
        std::array::from_fn(|i| {
            // The centered capture transform contracts this multiply/add.
            // Rounding its product first can move a ray across a Q8 sampler
            // midpoint. Preserve the separate surrounding operations.
            let centered = (p[i] - self.origin[i] as f32) / 512. - 0.5;
            centered.mul_add(self.density * 0.5, 0.5) * self.side as f32
        })
    }
}
