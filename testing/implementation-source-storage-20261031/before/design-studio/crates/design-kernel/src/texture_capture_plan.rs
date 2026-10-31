//! Finite numeric planning for the measured SDR texture capture graph.
//!
//! Coordinates enter in normalized parent-tile space. This module preserves
//! the host's separate binary32 operations and explicit descriptor dimensions.
//! It does not choose a scene, render pixels, or establish external fidelity.
use serde::Serialize;

pub type Affine = [f32; 6];
pub type Bounds = [f32; 4];

#[derive(Clone, Copy, Debug)]
pub struct Input {
    /// Row-major caller view: [m00,m01,tx,m10,m11,ty].
    pub view: Affine,
    pub node_to_render: Affine,
    pub render_bounds: Bounds,
    /// Clipped capture's cached source AABB, before applying the caller view.
    /// Supply the real render-tree bound; deriving it from an already-viewed
    /// AABB would change matrix ordering and perform an extra bounding step.
    pub capture_source_bounds_render: Option<Bounds>,
    pub active_bounds: Bounds,
    pub radius: f32,
    pub noise_size: [f32; 2],
    pub node_center: [f32; 2],
    pub clipped: bool,
    /// Ordinary manager descriptor pixels (and parent pixels in this measured
    /// independent context). A nested physical attachment size is not a valid
    /// substitute for this descriptor's activation threshold.
    pub parent_pixels: u32,
    pub capture_pixels: u32,
    pub original_pixels: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub clipped: bool,
    pub parent_pixels: u32,
    pub capture_pixels: u32,
    pub original_pixels: Option<u32>,
    pub scale: f32,
    pub padding: f32,
    pub normalized_radius: f32,
    pub centered_expansion: Affine,
    pub capture_view: Affine,
    pub node_to_tile: Affine,
    pub tile_to_node: Affine,
    pub node_center: [f32; 2],
    pub noise_reciprocal: [f32; 2],
    pub radius: f32,
    pub use_expanded_only: bool,
    pub visible_bounds: Bounds,
    pub capture_bounds: Bounds,
    pub capture_rect: [i32; 4],
    pub effect_rect: [i32; 4],
    pub effect_quad: Bounds,
    pub original_rect: Option<[i32; 4]>,
    /// Both destination and source coordinates of the final blit use this box.
    pub copyback_quad: Bounds,
}

#[derive(Clone, Debug)]
pub enum Outcome {
    /// No part of the effect intersects this canonical tile.
    Empty,
    /// The host replays the child directly below the activation threshold.
    Passthrough,
    /// An active, valid effect has no representable replay source. The caller
    /// must use its existing rendering path for the whole node, not skip it.
    Unsupported,
    Capture(Box<Plan>),
}

pub fn product(a: Affine, b: Affine) -> Affine {
    [
        a[0] * b[0] + a[1] * b[3],
        a[0] * b[1] + a[1] * b[4],
        (a[2] + a[0] * b[2]) + a[1] * b[5],
        a[3] * b[0] + a[4] * b[3],
        a[3] * b[1] + a[4] * b[4],
        (a[5] + a[3] * b[2]) + a[4] * b[5],
    ]
}

pub fn point(m: Affine, p: [f32; 2]) -> [f32; 2] {
    [
        (m[2] + m[0] * p[0]) + m[1] * p[1],
        (m[5] + m[3] * p[0]) + m[4] * p[1],
    ]
}

pub fn inverse(m: Affine) -> Result<Affine, String> {
    let [a, b, c, d, e, f] = m;
    let determinant = a * e - b * d;
    if !m.iter().all(|v| v.is_finite()) || !determinant.is_finite() || determinant == 0. {
        return Err("Invalid texture capture transform".into());
    }
    let r = 1. / determinant;
    let result = [
        e * r,
        r * -b,
        r * (b * f - e * c),
        r * -d,
        r * a,
        r * (d * c - a * f),
    ];
    if result.iter().any(|v| !v.is_finite()) {
        return Err("Texture capture inverse exceeds binary32 range".into());
    }
    Ok(result)
}

pub fn transformed_bounds(m: Affine, r: Bounds) -> Bounds {
    let points = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(|p| point(m, p));
    [
        points.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min),
        points.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min),
        points
            .iter()
            .map(|p| p[0])
            .fold(f32::NEG_INFINITY, f32::max),
        points
            .iter()
            .map(|p| p[1])
            .fold(f32::NEG_INFINITY, f32::max),
    ]
}

fn ordered(r: Bounds) -> bool {
    r.iter().all(|v| v.is_finite()) && r[0] <= r[2] && r[1] <= r[3]
}

fn round_host(v: f32) -> f32 {
    (v + f32::from_bits(0x3effffff).copysign(v)).trunc()
}

fn pixel_rect(r: Bounds, side: u32) -> Result<[i32; 4], String> {
    let n = side as f32;
    let edges = [
        round_host(r[0] * n - 1.),
        round_host(r[1] * n - 1.),
        round_host(r[2] * n + 1.),
        round_host(r[3] * n + 1.),
    ];
    if edges.iter().any(|v| {
        !v.is_finite() || f64::from(*v) < f64::from(i32::MIN) || f64::from(*v) > f64::from(i32::MAX)
    }) {
        return Err("Texture capture pixel bounds overflow".into());
    }
    let e = edges.map(|v| v as i32);
    let width = e[2]
        .checked_sub(e[0])
        .filter(|v| *v >= 0)
        .ok_or("Invalid texture capture width")?;
    let height = e[3]
        .checked_sub(e[1])
        .filter(|v| *v >= 0)
        .ok_or("Invalid texture capture height")?;
    Ok([e[0], e[1], width, height])
}

/// Dimensions are explicit; ordinary export uses parent512, capture1024,
/// original512. Invalid inputs are errors even when an effect would be hidden.
pub fn compile(input: Input) -> Result<Outcome, String> {
    if [
        input.parent_pixels,
        input.capture_pixels,
        input.original_pixels,
    ]
    .iter()
    .any(|v| !(4..=16_384).contains(v))
        || input.original_pixels > input.capture_pixels
        || !ordered(input.render_bounds)
        || !ordered(input.active_bounds)
        || input.capture_source_bounds_render.is_some() != input.clipped
        || input
            .capture_source_bounds_render
            .is_some_and(|r| !ordered(r))
        || !input.radius.is_finite()
        || input.radius < 0.
        || input
            .noise_size
            .iter()
            .any(|v| !v.is_finite() || *v <= 0. || !(1. / *v).is_finite())
        || input.node_center.iter().any(|v| !v.is_finite())
    {
        return Err("Invalid texture capture plan input".into());
    }
    inverse(input.view)?;
    inverse(input.node_to_render)?;
    let node_to_tile = product(input.view, input.node_to_render);
    let tile_to_node = inverse(node_to_tile)?;
    let n = [
        input.render_bounds[0].max(input.active_bounds[0]),
        input.render_bounds[1].max(input.active_bounds[1]),
        input.render_bounds[2].min(input.active_bounds[2]),
        input.render_bounds[3].min(input.active_bounds[3]),
    ];
    if n[0] >= n[2] || n[1] >= n[3] {
        return Ok(Outcome::Empty);
    }
    let view = input.view;
    let axis = (view[0] * view[0] + view[3] * view[3])
        .sqrt()
        .max((view[1] * view[1] + view[4] * view[4]).sqrt());
    let m = input.radius * axis;
    if !m.is_finite() {
        return Err("Texture radius exceeds binary32 range".into());
    }
    if m < 1. / input.parent_pixels as f32 {
        return Ok(Outcome::Passthrough);
    }
    let size = input.capture_pixels as f32;
    let maximum = (input.capture_pixels / 2 - 1) as f32;
    // Keep m/denominator distinct from reciprocal(denominator)*m.
    let mut padding = ((m / ((m + m) + 1.)) * size).min(maximum) / size;
    let mut scale = padding / m;
    if scale > 2. / size {
        scale = round_host(scale * size) / size;
        padding = ((m * scale) * size).min(maximum) / size;
    }
    if !scale.is_finite() || scale <= 0. || !padding.is_finite() || padding <= 0. {
        return Err("Texture capture scale exceeds binary32 range".into());
    }
    let translation = (0.5 + (-0.5 * scale)) + 0. * -0.5;
    let centered_expansion = [scale, 0., translation, 0., scale, translation];
    let capture_view = product(centered_expansion, view);
    if capture_view.iter().any(|v| !v.is_finite()) {
        return Err("Texture capture matrix overflow".into());
    }
    let bounds = transformed_bounds(centered_expansion, n);
    let mut capture_bounds = [
        bounds[0] - padding,
        bounds[1] - padding,
        padding + bounds[2],
        padding + bounds[3],
    ];
    if let Some(source) = input.capture_source_bounds_render {
        let source = transformed_bounds(capture_view, source);
        if !ordered(source) {
            return Err("Texture capture source bounds overflow".into());
        }
        capture_bounds = [
            capture_bounds[0].max(source[0]),
            capture_bounds[1].max(source[1]),
            capture_bounds[2].min(source[2]),
            capture_bounds[3].min(source[3]),
        ];
        if capture_bounds[0] >= capture_bounds[2] || capture_bounds[1] >= capture_bounds[3] {
            // The host still pushes the source/effect targets for this case;
            // extra-original clipping can then fall back to the original.
            // Do not misrepresent it as an invisible effect that may be skipped.
            return Ok(Outcome::Unsupported);
        }
    }
    let capture_rect = pixel_rect(capture_bounds, input.capture_pixels)?;
    let effect_rect = pixel_rect(n, input.capture_pixels)?;
    let extra = input.clipped && scale < input.original_pixels as f32 / size;
    Ok(Outcome::Capture(Box::new(Plan {
        clipped: input.clipped,
        parent_pixels: input.parent_pixels,
        capture_pixels: input.capture_pixels,
        original_pixels: extra.then_some(input.original_pixels),
        scale,
        padding,
        normalized_radius: m,
        centered_expansion,
        capture_view,
        node_to_tile,
        tile_to_node,
        node_center: input.node_center,
        noise_reciprocal: input.noise_size.map(|v| 1. / v),
        radius: input.radius,
        use_expanded_only: !extra,
        visible_bounds: n,
        capture_bounds,
        capture_rect,
        effect_rect,
        effect_quad: [
            effect_rect[0] as f32 / size,
            effect_rect[1] as f32 / size,
            (effect_rect[0] + effect_rect[2]) as f32 / size,
            (effect_rect[1] + effect_rect[3]) as f32 / size,
        ],
        original_rect: extra
            .then(|| pixel_rect(n, input.original_pixels))
            .transpose()?,
        copyback_quad: n,
    })))
}
