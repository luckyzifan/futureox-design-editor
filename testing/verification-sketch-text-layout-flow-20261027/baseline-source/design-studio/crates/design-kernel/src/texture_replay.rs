//! Bounded SDR texture-source replay, independent of authored sample identities.
//!
//! Only translated rectangular leaves under one clipped root frame are
//! routed here. The finite-quad coefficient setup is a general approximation:
//! its g32/c32 model matches the measured texture controls, but independent
//! geometry controls disprove universal agreement with hardware interpolation.
//! It must never be described as an exact hardware coefficient implementation.
//! Active replay is additionally limited to 65,536 canonical tiles over the
//! complete node/root intersection. Larger valid geometry uses the existing
//! renderer; a viewport crop cannot change this structural routing decision.
#![forbid(unsafe_code)]

use crate::{
    blend::{Pixel, Surface},
    fidelity::SAMPLE_OFFSETS,
    figma_gradient,
    figma_sampling::encode_unorm8,
    math::{Point, Rect, Transform},
    scene::{Document, Effect, Node, Paint},
    texture_capture::{self, ByteSurface},
    texture_capture_plan::{self as planning, Affine, Bounds, Input, Outcome, Plan},
};
use serde::{Deserialize, Serialize};

const TILE: i32 = 512;
const LIMIT: f64 = 16_777_216.;

/// A bounded scratch owner for GPU callers outside the kernel crate. Upload
/// and drop one parameter grid before building the next; GPU attachments keep
/// their own frame accounting. The internal Budget type remains private.
pub fn parameter_template() -> Result<Surface, String> {
    let budget = crate::memory::Budget::new(32 * 1024 * 1024);
    Surface::new_in(Rect::new(0, 0, 1, 1), &budget)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replay {
    pub parent_matrix: Transform,
    pub parent_world_transform: Transform,
    pub camera_matrix: Transform,
    pub parent_size: [f64; 2],
    pub node_transform: Transform,
    pub node_size: [f64; 2],
    pub paint: Paint,
    pub radius: f32,
    pub noise_size: [f32; 2],
    pub clipped: bool,
}

/// Source geometry and authored paint; no CPU-painted pixels cross a backend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePlan {
    pub side: u32,
    pub coverage: Rect,
    pub quad: FiniteQuad,
    pub paint: Paint,
    pub direction: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TilePlan {
    pub origin: [i32; 2],
    pub capture: Plan,
    pub expanded: SourcePlan,
    pub original: Option<SourcePlan>,
    pub copyback_quad: FiniteQuad,
    pub copyback_region: Rect,
}

pub enum TileOutcome {
    Empty,
    Passthrough,
    /// Valid scene input whose empty source is outside this replay contract.
    /// Preflight every sample/tile and fall back for the entire node.
    Unsupported,
    Capture(Box<TilePlan>),
}

/// Q8 coverage and a documented, approximate finite interpolation model.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiniteQuad {
    pub pixels: [f64; 4],
    pub coverage: Rect,
}

fn translation(m: Transform) -> bool {
    m.0.iter().all(|v| v.is_finite() && v.abs() <= LIMIT) && m.0[..4] == [1., 0., 0., 1.]
}
fn camera(m: Transform) -> bool {
    m.0.iter().all(|v| v.is_finite() && v.abs() <= LIMIT)
        && m.0[0] > 0.
        && m.0[0] == m.0[3]
        && m.0[1] == 0.
        && m.0[2] == 0.
}
fn size(s: [f64; 2]) -> bool {
    s.iter().all(|v| v.is_finite() && *v > 0. && *v <= LIMIT)
}
fn checked_rect(r: Rect) -> Result<(), String> {
    let right = i64::from(r.x) + i64::from(r.w);
    let bottom = i64::from(r.y) + i64::from(r.h);
    if [i64::from(r.x), i64::from(r.y), right, bottom]
        .iter()
        .any(|v| v.abs() > LIMIT as i64)
        || r.w > LIMIT as u32
        || r.h > LIMIT as u32
    {
        return Err("Texture replay viewport overflow".into());
    }
    Ok(())
}
fn row(m: Transform) -> Affine {
    [
        m.0[0] as f32,
        m.0[2] as f32,
        m.0[4] as f32,
        m.0[1] as f32,
        m.0[3] as f32,
        m.0[5] as f32,
    ]
}
fn plain(node: &Node) -> bool {
    node.visible
        && node.opacity == 1.
        && !node.mask
        && node.composite_blend() == "normal"
        && node.network.is_none()
        && node.derived_path.is_none()
        && node.boolean_operation.is_none()
        && node.instance.is_none()
        && node.component.is_none()
        && node.layout.is_none()
        && node.radii == [0.; 4]
        && node.smoothing == 0.
        && node.strokes.iter().all(|s| !s.visible || s.width <= 0.)
}
fn supported_paint(p: &Paint) -> bool {
    if !p.visible
        || p.opacity != 1.
        || p.blend != "normal"
        || p.transform.is_some()
        || !p.angle.is_finite()
    {
        return false;
    }
    match p.kind.as_str() {
        "solid" => Pixel::hex(&p.color, 1.).is_ok_and(|p| p.0[3] == 1.),
        "linear" => {
            p.angle.is_finite()
                && matches!(p.angle.rem_euclid(360.), 0. | 45. | 90.)
                && (2..=4096).contains(&p.stops.len())
                && p.stops.iter().all(|s| {
                    s.offset.is_finite()
                        && (0. ..=1.).contains(&s.offset)
                        && Pixel::hex(&s.color, 1.).is_ok_and(|p| p.0[3] == 1.)
                })
        }
        _ => false,
    }
}

pub fn recipe(
    doc: &Document,
    node: &Node,
    matrix: Transform,
    effect: &Effect,
) -> Result<Option<Replay>, String> {
    let Some(texture) = &effect.texture else {
        return Ok(None);
    };
    if texture
        .noise
        .as_deref()
        .is_some_and(|model| model != "figma")
        || doc.color_management.is_some()
        || !plain(node)
        || node.kind != "rectangle"
        || !node.children.is_empty()
        || !translation(node.transform)
        || node.effects.iter().filter(|e| e.visible).count() != 1
        || !effect.visible
        || effect.kind != "texture"
        || effect.opacity != 1.
        || !size([node.width, node.height])
    {
        return Ok(None);
    }
    effect.validate_material()?;
    let paints: Vec<_> = node.fills.iter().filter(|p| p.visible).collect();
    if paints.len() != 1 {
        return Ok(None);
    }
    // Validate the original gradient first, then preserve the existing solid
    // shortcut without changing authored document data or adding dither.
    let mut source_paint = paints[0].clone();
    // These two normalized paint matrices have exact axis semantics. Preserve
    // the authored matrix in the document; canonicalize only the capture plan.
    if source_paint.transform.is_some() {
        let Some(angle) = crate::figma_gradient::canonical_angle(&source_paint) else {
            return Ok(None);
        };
        source_paint.angle = angle;
        source_paint.transform = None;
    }
    if !supported_paint(&source_paint) {
        return Ok(None);
    }
    if source_paint.kind == "linear"
        && let Some(color) = source_paint.constant_color().map(str::to_owned)
    {
        source_paint.kind = "solid".into();
        source_paint.color = color;
        source_paint.stops.clear();
        source_paint.angle = 0.;
    }
    let mut parents = doc
        .nodes
        .values()
        .filter(|p| p.render_children().contains(&node.id));
    let Some(parent) = parents.next() else {
        return Ok(None);
    };
    if parents.next().is_some()
        || parent.kind != "frame"
        || !plain(parent)
        || !parent.clip
        || !translation(parent.transform)
        || !size([parent.width, parent.height])
        || parent.effects.iter().any(|e| e.visible)
        || parent.render_children().last() != Some(&node.id)
        || doc.mask_child(parent).is_some()
        || doc
            .nodes
            .values()
            .any(|n| n.render_children().contains(&parent.id))
        || !doc
            .pages
            .iter()
            .any(|p| p.children.as_slice() == [parent.id.as_str()])
    {
        return Ok(None);
    }
    let backgrounds: Vec<_> = parent.fills.iter().filter(|p| p.visible).collect();
    // Capture sources contain the leaf paint; copyback already composites
    // straight/associated alpha against the actual parent destination. An
    // unpainted parent must retain transparency instead of taking another
    // displacement/compositing algorithm merely because it has no fill.
    if backgrounds.len() > 1
        || backgrounds
            .iter()
            .any(|p| p.kind != "solid" || !supported_paint(p))
    {
        return Ok(None);
    }
    let x = node.transform.0[4];
    let y = node.transform.0[5];
    if x < 0. || y < 0. || x + node.width > parent.width || y + node.height > parent.height {
        return Ok(None);
    }
    let parent_matrix = matrix.concat(node.transform.inverse()?);
    let camera_matrix = parent_matrix.concat(parent.transform.inverse()?);
    if !camera(parent_matrix) || !camera(camera_matrix) {
        return Ok(None);
    }
    let replay = Replay {
        parent_matrix,
        parent_world_transform: parent.transform,
        camera_matrix,
        parent_size: [parent.width, parent.height],
        node_transform: node.transform,
        node_size: [node.width, node.height],
        paint: source_paint,
        radius: effect.radius as f32,
        noise_size: texture.noise_size.map(|v| v as f32),
        clipped: texture.clip_to_shape,
    };
    replay.validate()?;
    if !replay.below_activation(row(replay.camera_matrix).map(|v| v / 512.))?
        && replay.full_node_tile_count()? > 65_536
    {
        return Ok(None);
    }
    if !replay.supported_for_all_tiles()? {
        return Ok(None);
    }
    Ok(Some(replay))
}

fn rect_from_bounds(r: [f64; 4]) -> Result<Rect, String> {
    if r.iter().any(|v| !v.is_finite() || v.abs() > LIMIT) || r[0] > r[2] || r[1] > r[3] {
        return Err("Texture replay bounds overflow".into());
    }
    Ok(Rect::new(
        r[0].floor() as i32,
        r[1].floor() as i32,
        (r[2].ceil() - r[0].floor()) as u32,
        (r[3].ceil() - r[1].floor()) as u32,
    ))
}
fn device_bounds(m: Transform, s: [f64; 2], halo: f64) -> [f64; 4] {
    let a = m.point(Point::new(-halo, -halo));
    let b = m.point(Point::new(s[0] + halo, s[1] + halo));
    [a.x, a.y, b.x, b.y]
}

impl Replay {
    /// Classify the entire node independently of a requested viewport crop.
    /// A halo-only tile with no source cannot make a full export fall back
    /// while a crop of another tile uses replay. This builds metadata only;
    /// no source attachment, paint lookup or noise field is allocated.
    pub fn supported_for_all_tiles(&self) -> Result<bool, String> {
        self.validate()?;
        // No capture exists below activation, so neither a source nor global
        // tile enumeration is required. Keep all input validation above this.
        if self.below_activation(row(self.camera_matrix).map(|v| v / 512.))? {
            return Ok(true);
        }
        let region = self.parent_rect()?;
        for (origin, _) in self.tiles(region)? {
            for sample in 0..4 {
                if matches!(self.tile(origin, sample, region)?, TileOutcome::Unsupported) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    fn below_activation(&self, view: Affine) -> Result<bool, String> {
        planning::inverse(view)?;
        let axis = (view[0] * view[0] + view[3] * view[3])
            .sqrt()
            .max((view[1] * view[1] + view[4] * view[4]).sqrt());
        let radius = self.radius * axis;
        if !radius.is_finite() {
            return Err("Texture radius exceeds binary32 range".into());
        }
        Ok(radius < 1. / 512.)
    }
    pub fn validate(&self) -> Result<(), String> {
        if !translation(self.parent_world_transform)
            || !translation(self.node_transform)
            || !camera(self.camera_matrix)
            || !camera(self.parent_matrix)
            || !size(self.parent_size)
            || !size(self.node_size)
            || !supported_paint(&self.paint)
            || (self.paint.kind == "linear" && self.paint.constant_color().is_some())
            || !self.radius.is_finite()
            || self.radius < 0.
            || f64::from(self.radius) > LIMIT
            || self
                .noise_size
                .iter()
                .any(|v| !v.is_finite() || !(0.001..=10_000.).contains(v))
        {
            return Err("Invalid texture replay recipe".into());
        }
        let p = self.node_transform.0;
        if p[4] < 0.
            || p[5] < 0.
            || p[4] + self.node_size[0] > self.parent_size[0]
            || p[5] + self.node_size[1] > self.parent_size[1]
        {
            return Err("Texture source escapes its root frame".into());
        }
        self.parent_rect()?;
        rect_from_bounds(device_bounds(
            self.parent_matrix.concat(self.node_transform),
            self.node_size,
            if self.clipped { 0. } else { self.radius as f64 },
        ))?;
        Ok(())
    }
    fn parent_rect(&self) -> Result<Rect, String> {
        rect_from_bounds(device_bounds(self.parent_matrix, self.parent_size, 0.))
    }
    fn anchor(&self) -> [i32; 2] {
        [
            self.parent_matrix.0[4].floor() as i32,
            self.parent_matrix.0[5].floor() as i32,
        ]
    }
    fn tile_region(&self, viewport: Rect) -> Result<Rect, String> {
        let effect = rect_from_bounds(device_bounds(
            self.parent_matrix.concat(self.node_transform),
            self.node_size,
            if self.clipped { 0. } else { self.radius as f64 },
        ))?;
        Ok(effect.intersect(self.parent_rect()?).intersect(viewport))
    }
    fn full_node_tile_count(&self) -> Result<u64, String> {
        let region = self.tile_region(self.parent_rect()?)?;
        if region.empty() {
            return Ok(0);
        }
        let anchor = self.anchor();
        let counts = [
            (region.x, region.right(), anchor[0]),
            (region.y, region.bottom(), anchor[1]),
        ]
        .map(|(first, end, origin)| {
            let lo = (i64::from(first) - i64::from(origin)).div_euclid(512);
            let hi = (i64::from(end) - 1 - i64::from(origin)).div_euclid(512);
            u64::try_from(hi - lo + 1).map_err(|_| "Invalid texture tile span".to_string())
        });
        let [x, y] = counts;
        x?.checked_mul(y?)
            .ok_or_else(|| "Texture tile count overflow".into())
    }
    pub fn tiles(&self, viewport: Rect) -> Result<Vec<([i32; 2], Rect)>, String> {
        self.validate()?;
        checked_rect(viewport)?;
        let region = self.tile_region(viewport)?;
        if region.empty() {
            return Ok(Vec::new());
        }
        let anchor = self.anchor();
        let first = [
            i64::from(region.x) - i64::from(anchor[0]),
            i64::from(region.y) - i64::from(anchor[1]),
        ];
        let last = [
            i64::from(region.right()) - 1 - i64::from(anchor[0]),
            i64::from(region.bottom()) - 1 - i64::from(anchor[1]),
        ];
        let mut result = Vec::new();
        for y in first[1].div_euclid(512)..=last[1].div_euclid(512) {
            for x in first[0].div_euclid(512)..=last[0].div_euclid(512) {
                if result.len() >= 65_536 {
                    return Err("Texture replay tile budget exceeded".into());
                }
                let origin = [
                    (i64::from(anchor[0]) + x * 512) as i32,
                    (i64::from(anchor[1]) + y * 512) as i32,
                ];
                result.push((
                    origin,
                    Rect::new(origin[0], origin[1], 512, 512).intersect(region),
                ));
            }
        }
        Ok(result)
    }
    pub fn tile(
        &self,
        origin: [i32; 2],
        sample: usize,
        viewport: Rect,
    ) -> Result<TileOutcome, String> {
        self.validate()?;
        checked_rect(viewport)?;
        if origin.iter().zip(self.anchor()).any(|(p, a)| {
            p.abs_diff(0) > LIMIT as u32
                || (i64::from(*p) - i64::from(a)).rem_euclid(i64::from(TILE)) != 0
        }) {
            return Err("Invalid texture replay tile origin".into());
        }
        let &(sx, sy) = SAMPLE_OFFSETS
            .get(sample)
            .ok_or("Invalid texture replay sample")?;
        let mut view = row(self.camera_matrix).map(|v| v / 512.);
        view[2] = (view[2] - origin[0] as f32 / 512.) + (0.5 - sx) as f32 / 512.;
        view[5] = (view[5] - origin[1] as f32 / 512.) + (0.5 - sy) as f32 / 512.;
        if self.below_activation(view)? {
            let effect = rect_from_bounds(device_bounds(
                self.parent_matrix.concat(self.node_transform),
                self.node_size,
                if self.clipped { 0. } else { self.radius as f64 },
            ))?;
            let visible = effect
                .intersect(self.parent_rect()?)
                .intersect(viewport)
                .intersect(Rect::new(origin[0], origin[1], 512, 512));
            return Ok(if visible.empty() {
                TileOutcome::Empty
            } else {
                TileOutcome::Passthrough
            });
        }
        let world = planning::product(row(self.parent_world_transform), row(self.node_transform));
        let source_world = planning::transformed_bounds(
            world,
            [0., 0., self.node_size[0] as f32, self.node_size[1] as f32],
        );
        if source_world[0] == source_world[2] || source_world[1] == source_world[3] {
            return Ok(TileOutcome::Unsupported);
        }
        let halo = if self.clipped { 0. } else { self.radius };
        let effect_world = [
            source_world[0] - halo,
            source_world[1] - halo,
            source_world[2] + halo,
            source_world[3] + halo,
        ];
        let parent = device_bounds(self.parent_matrix, self.parent_size, 0.);
        let active = [
            ((parent[0] - origin[0] as f64) / 512.).max(0.) as f32,
            ((parent[1] - origin[1] as f64) / 512.).max(0.) as f32,
            ((parent[2] - origin[0] as f64) / 512.).min(1.) as f32,
            ((parent[3] - origin[1] as f64) / 512.).min(1.) as f32,
        ];
        if active[0] >= active[2] || active[1] >= active[3] {
            return Ok(TileOutcome::Empty);
        }
        let outcome = planning::compile(Input {
            view,
            node_to_render: world,
            render_bounds: planning::transformed_bounds(view, effect_world),
            capture_source_bounds_render: self.clipped.then_some(source_world),
            active_bounds: active,
            radius: self.radius,
            noise_size: self.noise_size,
            node_center: self.node_size.map(|v| v as f32 * 0.5),
            clipped: self.clipped,
            parent_pixels: 512,
            capture_pixels: 1024,
            original_pixels: 512,
        })?;
        let capture = match outcome {
            Outcome::Empty => return Ok(TileOutcome::Empty),
            Outcome::Passthrough => return Ok(TileOutcome::Passthrough),
            Outcome::Unsupported => return Ok(TileOutcome::Unsupported),
            Outcome::Capture(p) => *p,
        };
        let Some(expanded) = self.source_plan(
            capture.capture_view,
            world,
            capture.capture_pixels,
            capture.capture_rect,
        )?
        else {
            return Ok(TileOutcome::Unsupported);
        };
        let original = if let Some(rect) = capture.original_rect {
            let Some(source) = self.source_plan(view, world, 512, rect)? else {
                return Ok(TileOutcome::Unsupported);
            };
            Some(source)
        } else {
            None
        };
        let Some(copyback_quad) = FiniteQuad::maybe(capture.copyback_quad, 512)? else {
            return Ok(TileOutcome::Empty);
        };
        let coverage = copyback_quad.coverage;
        let copyback_region = Rect::new(
            coverage.x + origin[0],
            coverage.y + origin[1],
            coverage.w,
            coverage.h,
        )
        .intersect(self.parent_rect()?)
        .intersect(viewport)
        .intersect(Rect::new(origin[0], origin[1], 512, 512));
        if copyback_region.empty() {
            return Ok(TileOutcome::Empty);
        }
        Ok(TileOutcome::Capture(Box::new(TilePlan {
            origin,
            capture,
            expanded,
            original,
            copyback_quad,
            copyback_region,
        })))
    }
    fn source_plan(
        &self,
        view: Affine,
        world: Affine,
        side: u32,
        scissor: [i32; 4],
    ) -> Result<Option<SourcePlan>, String> {
        let m = planning::product(view, world);
        let r = planning::transformed_bounds(
            m,
            [0., 0., self.node_size[0] as f32, self.node_size[1] as f32],
        );
        let Some(quad) = FiniteQuad::maybe(r, side)? else {
            return Ok(None);
        };
        let Some(parent) = FiniteQuad::maybe(
            planning::transformed_bounds(
                planning::product(view, row(self.parent_world_transform)),
                [
                    0.,
                    0.,
                    self.parent_size[0] as f32,
                    self.parent_size[1] as f32,
                ],
            ),
            side,
        )?
        else {
            return Ok(None);
        };
        let coverage = quad
            .coverage
            .intersect(parent.coverage)
            .intersect(Rect::new(
                scissor[0],
                scissor[1],
                scissor[2] as u32,
                scissor[3] as u32,
            ))
            .intersect(Rect::new(0, 0, side, side));
        if coverage.empty() {
            return Ok(None);
        }
        Ok(Some(SourcePlan {
            side,
            coverage,
            quad,
            paint: self.paint.clone(),
            direction: match self.paint.angle.rem_euclid(360.) {
                45. => 1,
                90. => 2,
                _ => 0,
            },
        }))
    }
}

fn reciprocal25(area: f64) -> f64 {
    let value = 1. / area;
    let bits = value.to_bits();
    let dropped = 28;
    let low = bits & ((1_u64 << dropped) - 1);
    let upper = bits >> dropped;
    let half = 1_u64 << (dropped - 1);
    f64::from_bits((upper + u64::from(low > half || low == half && upper & 1 != 0)) << dropped)
}
fn toward_zero(value: f64) -> f32 {
    let result = value as f32;
    if f64::from(result).abs() > value.abs() {
        f32::from_bits(result.to_bits() - 1)
    } else {
        result
    }
}
impl FiniteQuad {
    pub fn new(bounds: Bounds, side: u32) -> Result<Self, String> {
        Self::maybe(bounds, side)?.ok_or_else(|| "Degenerate texture finite quad".into())
    }
    fn maybe(bounds: Bounds, side: u32) -> Result<Option<Self>, String> {
        if !matches!(side, 512 | 1024)
            || bounds.iter().any(|v| !v.is_finite())
            || bounds[0] > bounds[2]
            || bounds[1] > bounds[3]
        {
            return Err("Invalid texture finite quad".into());
        }
        let n = side as f32;
        let pixels = bounds.map(|uv| {
            // Vertex clip projection, viewport projection, then Q8 coverage.
            let clip = uv * 2. - 1.;
            let screen = (clip * 0.5 + 0.5) * n;
            (f64::from(screen) * 256. + 0.5).floor() / 256.
        });
        if pixels.iter().any(|v| !v.is_finite() || v.abs() > LIMIT) {
            return Err("Texture finite quad overflow".into());
        }
        if pixels[0] == pixels[2] || pixels[1] == pixels[3] {
            return Ok(None);
        }
        let edge = |v: f64| (v - 0.5).ceil() as i32;
        let coverage = Rect::new(
            edge(pixels[0]),
            edge(pixels[1]),
            (edge(pixels[2]) - edge(pixels[0])) as u32,
            (edge(pixels[3]) - edge(pixels[1])) as u32,
        );
        Ok(Some(Self { pixels, coverage }))
    }
    /// Approximate general coefficient setup with observed full-dot RZ iteration.
    /// Values at corners are base,base+dx,base+dy,base+dx+dy.
    pub fn scalar(&self, pixel: [i32; 2], base: f32, dx: f32, dy: f32) -> f32 {
        let [x0, y0, x1, y1] = self.pixels;
        let w = x1 - x0;
        let h = y1 - y0;
        let reciprocal = reciprocal25(w * h);
        let a = (f64::from(dx) * h * reciprocal) as f32;
        let b = (f64::from(dy) * w * reciprocal) as f32;
        let x = f64::from(pixel[0]) + 0.5;
        let y = f64::from(pixel[1]) + 0.5;
        let tx = pixel[0].div_euclid(32) as f64 * 32.;
        let ty = pixel[1].div_euclid(32) as f64 * 32.;
        let second = (x - x0) / w + (y - y0) / h >= 1.;
        let c = if second {
            f64::from(base + dx) + (tx - x1) * f64::from(a) + (ty - y0) * f64::from(b)
        } else {
            f64::from(base) + (tx - x0) * f64::from(a) + (ty - y0) * f64::from(b)
        } as f32;
        toward_zero((x - tx) * f64::from(a) + (y - ty) * f64::from(b) + f64::from(c))
    }
}

pub struct SamplingGrid {
    pub rect: Rect,
    pub values: Vec<f32>,
    _allocation: Option<crate::memory::Allocation>,
}
fn parameter_grid(
    template: &Surface,
    rect: Rect,
    mut at: impl FnMut(i32, i32) -> Result<[f32; 4], String>,
) -> Result<SamplingGrid, String> {
    checked_rect(rect)?;
    let pixels = (rect.w as usize)
        .checked_mul(rect.h as usize)
        .filter(|v| *v <= 16_777_216)
        .ok_or("Texture field pixel budget exceeded")?;
    let count = pixels.checked_mul(4).ok_or("Texture field size overflow")?;
    let allocation = template.reserve_scratch::<f32>(count)?;
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| "Could not allocate texture parameter field")?;
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            values.extend_from_slice(&at(x, y)?);
        }
    }
    Ok(SamplingGrid {
        rect,
        values,
        _allocation: allocation,
    })
}
impl SourcePlan {
    fn validate(&self) -> Result<(), String> {
        checked_rect(self.coverage)?;
        if !matches!(self.side, 512 | 1024)
            || self.direction > 2
            || self.coverage.empty()
            || self.coverage.x < 0
            || self.coverage.y < 0
            || self.coverage.right() > self.side as i32
            || self.coverage.bottom() > self.side as i32
            || !supported_paint(&self.paint)
            || (self.paint.kind == "linear" && self.paint.constant_color().is_some())
            || self.direction
                != match self.paint.angle.rem_euclid(360.) {
                    45. => 1,
                    90. => 2,
                    _ => 0,
                }
            || self
                .quad
                .pixels
                .iter()
                .any(|v| !v.is_finite() || v.abs() > LIMIT)
            || self.quad.pixels[0] >= self.quad.pixels[2]
            || self.quad.pixels[1] >= self.quad.pixels[3]
        {
            return Err("Invalid texture source plan".into());
        }
        Ok(())
    }
    /// Local attachment dither is deliberately not reduced modulo512.
    pub fn at(&self, x: i32, y: i32) -> Result<[f32; 4], String> {
        self.validate()?;
        self.at_validated(x, y)
    }
    fn at_validated(&self, x: i32, y: i32) -> Result<[f32; 4], String> {
        if x < 0 || y < 0 || x >= self.side as i32 || y >= self.side as i32 {
            return Err("Texture source coordinate outside attachment".into());
        }
        let (dx, dy) = match self.direction {
            0 => (1., 0.),
            1 => (0.5, 0.5),
            _ => (0., 1.),
        };
        let t = self.quad.scalar([x, y], 0., dx, dy);
        if !t.is_finite() {
            return Err("Nonfinite texture gradient parameter".into());
        }
        let dither =
            figma_gradient::dither_offset([x as u32, y as u32]).map_err(|e| e.to_string())?;
        Ok([t, dither, 0., 0.])
    }
    pub fn sampling_grid(&self, template: &Surface) -> Result<SamplingGrid, String> {
        self.validate()?;
        let count = (self.coverage.w as usize)
            .checked_mul(self.coverage.h as usize)
            .and_then(|v| v.checked_mul(4))
            .ok_or("Texture field size overflow")?;
        let allocation = template.reserve_scratch::<f32>(count)?;
        let mut values = Vec::new();
        values
            .try_reserve_exact(count)
            .map_err(|_| "Could not allocate texture source field")?;
        for y in self.coverage.y..self.coverage.bottom() {
            for x in self.coverage.x..self.coverage.right() {
                values.extend_from_slice(&self.at_validated(x, y)?);
            }
        }
        Ok(SamplingGrid {
            rect: self.coverage,
            values,
            _allocation: allocation,
        })
    }
    pub(crate) fn render(&self, template: &Surface) -> Result<ByteSurface, String> {
        self.validate()?;
        let mut output = ByteSurface::new(template, self.side)?;
        let _lookup_allocation = if self.paint.kind == "linear" {
            template.reserve_scratch::<u8>(8192)?
        } else {
            None
        };
        let gradient = if self.paint.kind == "linear" {
            Some(figma_gradient::from_paint(&self.paint)?)
        } else {
            None
        };
        let solid = if gradient.is_none() {
            Pixel::hex(&self.paint.color, 1.)?.0.map(encode_unorm8)
        } else {
            [0; 4]
        };
        let pixels = output.pixels_mut();
        for y in self.coverage.y..self.coverage.bottom() {
            for x in self.coverage.x..self.coverage.right() {
                let color = if let Some(g) = &gradient {
                    let [t, dither, ..] = self.at_validated(x, y)?;
                    let sample = g.sample(t).map_err(|e| e.to_string())?;
                    let mut c = sample.map(|v| (v + dither).abs().min(1.));
                    c[3] = 1.;
                    c.map(encode_unorm8)
                } else {
                    solid
                };
                let k = (y as usize * self.side as usize + x as usize) * 4;
                pixels[k..k + 4].copy_from_slice(&color);
            }
        }
        Ok(output)
    }
}
impl TilePlan {
    pub fn effect_sampling_grid(&self, template: &Surface) -> Result<SamplingGrid, String> {
        let parameters = texture_capture::ShaderParameters::new(&self.capture)?;
        let r = self.capture.effect_rect;
        if r[2] < 0 || r[3] < 0 {
            return Err("Invalid texture effect field bounds".into());
        }
        let rect = Rect::new(r[0], r[1], r[2] as u32, r[3] as u32);
        checked_rect(rect)?;
        let rect = rect.intersect(Rect::new(
            0,
            0,
            self.capture.capture_pixels,
            self.capture.capture_pixels,
        ));
        parameter_grid(template, rect, |x, y| {
            let field = parameters.field(self.effect_uv(x as u32, y as u32)?)?;
            Ok([
                field.node_point[0],
                field.node_point[1],
                field.displacement[0],
                field.displacement[1],
            ])
        })
    }
    pub fn copyback_sampling_grid(&self, template: &Surface) -> Result<SamplingGrid, String> {
        parameter_grid(template, self.copyback_region, |x, y| {
            let uv = self.copyback_uv(x, y)?;
            Ok([uv[0], uv[1], 0., 0.])
        })
    }
    pub fn effect_uv(&self, x: u32, y: u32) -> Result<[f32; 2], String> {
        if x >= self.capture.capture_pixels || y >= self.capture.capture_pixels {
            return Err("Texture effect coordinate outside attachment".into());
        }
        let n = self.capture.capture_pixels as f32;
        Ok([(x as f32 + 0.5) / n, (y as f32 + 0.5) / n])
    }
    pub fn copyback_uv(&self, x: i32, y: i32) -> Result<[f32; 2], String> {
        let p = [x - self.origin[0], y - self.origin[1]];
        let r = self.capture.copyback_quad;
        Ok([
            self.copyback_quad.scalar(p, r[0], r[2] - r[0], 0.),
            self.copyback_quad.scalar(p, r[1], 0., r[3] - r[1]),
        ])
    }
    pub fn render_into(&self, parent: &mut Surface) -> Result<(), String> {
        let expanded = self.expanded.render(parent)?;
        let original = self
            .original
            .as_ref()
            .map(|p| p.render(parent))
            .transpose()?;
        let effect = texture_capture::render_effect(
            parent,
            &self.capture,
            &expanded,
            original.as_ref(),
            |x, y| self.effect_uv(x, y),
        )?;
        texture_capture::copyback_surface(
            parent,
            effect.as_rgba8(),
            self.copyback_region,
            |x, y| self.copyback_uv(x, y),
        )
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    use crate::memory::Budget;

    fn solid() -> SourcePlan {
        let quad = FiniteQuad::new([0.25, 0.25, 0.3125, 0.3125], 1024).unwrap();
        SourcePlan {
            side: 1024,
            coverage: quad.coverage,
            quad,
            direction: 0,
            paint: serde_json::from_value(serde_json::json!({"kind":"solid","color":"#2468ac"}))
                .unwrap(),
        }
    }
    #[test]
    fn structural_tile_count_matches_cap_and_is_crop_invariant() {
        let mut replay = Replay {
            parent_matrix: Transform([32., 0., 0., 32., -1024., -1024.]),
            parent_world_transform: Transform::default(),
            camera_matrix: Transform([32., 0., 0., 32., -1024., -1024.]),
            parent_size: [4096., 4096.],
            node_transform: Transform::default(),
            node_size: [4096., 4096.],
            paint: solid().paint,
            radius: 2.,
            noise_size: [8., 8.],
            clipped: true,
        };
        assert_eq!(replay.full_node_tile_count().unwrap(), 65_536);
        assert_eq!(
            replay.tiles(replay.parent_rect().unwrap()).unwrap().len(),
            65_536
        );
        for origin in [[-1024.5, -1023.25], [-1401.5, -1518.25]] {
            replay.parent_matrix.0[4] = origin[0];
            replay.parent_matrix.0[5] = origin[1];
            replay.camera_matrix = replay.parent_matrix;
            assert_eq!(replay.full_node_tile_count().unwrap(), 66_049);
            assert_eq!(
                replay.tiles(replay.parent_rect().unwrap()).err().as_deref(),
                Some("Texture replay tile budget exceeded")
            );
        }
        replay.parent_size = [4112., 4112.];
        replay.node_size = replay.parent_size;
        assert!(replay.full_node_tile_count().unwrap() > 65_536);
        assert_eq!(
            replay.supported_for_all_tiles().err().as_deref(),
            Some("Texture replay tile budget exceeded")
        );
        replay.radius = 0.;
        assert!(replay.supported_for_all_tiles().unwrap());
        replay.camera_matrix.0[0] = 0.;
        assert!(replay.supported_for_all_tiles().is_err());
    }
    #[test]
    fn byte_source_and_colour_free_field_share_and_release_the_frame_budget() {
        let budget = Budget::new(8 * 1024 * 1024);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        let base = budget.usage().live_bytes;
        let source = solid();
        let bytes = source.render(&template).unwrap();
        assert_eq!(budget.usage().live_bytes, base + 1024 * 1024 * 4);
        assert_eq!(budget.usage().allocated_surface_pixels, 1 + 1024 * 1024);
        let field = source.sampling_grid(&template).unwrap();
        assert_eq!(field.values.len(), 64 * 64 * 4);
        assert_eq!(
            budget.usage().live_bytes,
            base + 1024 * 1024 * 4 + 64 * 64 * 16
        );
        drop(field);
        drop(bytes);
        assert_eq!(budget.usage().live_bytes, base);
        assert_eq!(budget.usage().live_surface_pixels, 1);
        let tiny = Budget::new(1024);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &tiny).unwrap();
        assert!(source.render(&template).is_err());
        assert!(source.sampling_grid(&template).is_err());
        assert_eq!(tiny.usage().live_bytes, size_of::<Pixel>());
    }
    #[test]
    fn malformed_public_source_fails_without_writing_or_leaking_budget() {
        let budget = Budget::new(8 * 1024 * 1024);
        let template = Surface::new_in(Rect::new(0, 0, 1, 1), &budget).unwrap();
        for which in 0..5 {
            let mut source = solid();
            match which {
                0 => source.coverage = Rect::new(-1, 0, 10, 10),
                1 => source.coverage = Rect::new(i32::MAX, 0, u32::MAX, 1),
                2 => source.quad.pixels[2] = source.quad.pixels[0],
                3 => source.paint.opacity = 0.5,
                _ => source.direction = 99,
            }
            assert!(source.at(0, 0).is_err());
            assert!(source.sampling_grid(&template).is_err());
            assert!(source.render(&template).is_err());
            assert_eq!(budget.usage().live_bytes, size_of::<Pixel>());
        }
    }
}

#[cfg(test)]
mod coefficient_holdout_tests {
    use super::*;

    /// Independent re-derivation of `FiniteQuad::scalar`'s documented model
    /// with an explicit ULP perturbation on each interpolation coefficient
    /// before the tile-base and toward-zero evaluations.
    fn scalar_perturbed(
        quad: &FiniteQuad,
        pixel: [i32; 2],
        base: f32,
        dx: f32,
        dy: f32,
        ulp_a: i64,
        ulp_b: i64,
    ) -> f32 {
        let [x0, y0, x1, y1] = quad.pixels;
        let w = x1 - x0;
        let h = y1 - y0;
        let reciprocal = reciprocal25(w * h);
        let narrow = |value: f32, ulp: i64| f32::from_bits(((value.to_bits() as i64) + ulp) as u32);
        let a = narrow((f64::from(dx) * h * reciprocal) as f32, ulp_a);
        let b = narrow((f64::from(dy) * w * reciprocal) as f32, ulp_b);
        let x = f64::from(pixel[0]) + 0.5;
        let y = f64::from(pixel[1]) + 0.5;
        let tx = pixel[0].div_euclid(32) as f64 * 32.;
        let ty = pixel[1].div_euclid(32) as f64 * 32.;
        let second = (x - x0) / w + (y - y0) / h >= 1.;
        let c = if second {
            f64::from(base + dx) + (tx - x1) * f64::from(a) + (ty - y0) * f64::from(b)
        } else {
            f64::from(base) + (tx - x0) * f64::from(a) + (ty - y0) * f64::from(b)
        } as f32;
        toward_zero((x - tx) * f64::from(a) + (y - ty) * f64::from(b) + f64::from(c))
    }

    /// Quantize one gradient parameter through the production dither, sample
    /// and UNORM8 chain used by `SourcePlan::render`.
    fn encoded_bytes(t: f32, dither: f32, gradient: &figma_gradient::LinearGradient) -> [u8; 4] {
        let sample = gradient.sample(t).unwrap();
        let mut c = sample.map(|v| (v + dither).abs().min(1.));
        c[3] = 1.;
        c.map(encode_unorm8)
    }

    fn linear_paint(stops: &[(&str, f64)]) -> Paint {
        serde_json::from_value(serde_json::json!({
            "kind": "linear",
            "color": "#000000",
            "angle": 0.,
            "stops": stops
                .iter()
                .map(|(color, offset)| serde_json::json!({"color": color, "offset": offset}))
                .collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    /// The recorded admitted-coefficient counterexample quad (scope ledger
    /// 2026-10-09) plus systematic non-square holdouts at both attachment
    /// sides, including a near-full original512 attachment.
    fn holdout_quads() -> Vec<FiniteQuad> {
        let recorded = FiniteQuad {
            pixels: [41.171875, 14.56640625, 281.06640625, 176.72265625],
            coverage: {
                let edge = |v: f64| (v - 0.5).ceil() as i32;
                let (l, t) = (edge(41.171875), edge(14.56640625));
                Rect::new(
                    l,
                    t,
                    (edge(281.06640625) - l) as u32,
                    (edge(176.72265625) - t) as u32,
                )
            },
        };
        let mut quads = vec![recorded];
        let shapes = [
            [0.02, 0.031, 0.71, 0.42],
            [0.31, 0.07, 0.44, 0.93],
            [0.0, 0.0, 1.0, 0.63],
            [0.17, 0.0, 0.63, 1.0],
            [0.0, 0.4, 1.0, 0.410_1],
        ];
        for side in [512, 1024] {
            for uv in shapes {
                if side == 1024 && uv[2] - uv[0] > 0.5 && uv[3] - uv[1] > 0.5 {
                    continue;
                }
                if let Some(quad) = FiniteQuad::maybe(uv, side).unwrap() {
                    quads.push(quad);
                }
            }
        }
        quads
    }

    /// The 1-ULP divergence recorded in the scope ledger is measured, not
    /// waived: on the non-square counterexample quad a one-ULP coefficient
    /// perturbation flips a dithered UNORM8 boundary pixel by 1/255. This test
    /// pins the exact flip census on the holdout corpus so any change to the
    /// coefficient model must consciously re-derive it. The census proves the
    /// approximation class is externally observable in principle; it stayed
    /// unobserved on all 72 real Figma samples.
    #[test]
    fn one_ulp_coefficient_divergence_census_is_pinned() {
        let paints = [
            linear_paint(&[("#000000", 0.), ("#ffffff", 1.)]),
            linear_paint(&[("#100f3f", 0.), ("#2bd9a0", 0.37), ("#ff8a30", 1.)]),
        ];
        let directions = [(1., 0.), (0.5, 0.5)];
        let mut evaluated = 0_u64;
        let mut flipped: Vec<(usize, [i32; 2])> = Vec::new();
        for (qi, quad) in holdout_quads().iter().enumerate() {
            for paint in &paints {
                let gradient = figma_gradient::from_paint(paint).unwrap();
                for (dx, dy) in directions {
                    for y in quad.coverage.y..quad.coverage.bottom() {
                        for x in quad.coverage.x..quad.coverage.right() {
                            let dither =
                                figma_gradient::dither_offset([x as u32, y as u32]).unwrap();
                            let t = quad.scalar([x, y], 0., dx, dy);
                            let expected = encoded_bytes(t, dither, &gradient);
                            for (ulp_a, ulp_b) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                                if dx == 0. && ulp_a != 0 || dy == 0. && ulp_b != 0 {
                                    continue;
                                }
                                let perturbed =
                                    scalar_perturbed(quad, [x, y], 0., dx, dy, ulp_a, ulp_b);
                                let actual = encoded_bytes(perturbed, dither, &gradient);
                                let diffs = actual
                                    .iter()
                                    .zip(expected)
                                    .map(|(a, e)| i32::from(*a) - i32::from(e))
                                    .collect::<Vec<i32>>();
                                assert!(
                                    diffs.iter().all(|d| d.abs() <= 1),
                                    "perturbation moved a channel beyond 1/255 at quad {:?} pixel {:?}",
                                    quad.pixels,
                                    [x, y]
                                );
                                if diffs.iter().any(|d| *d != 0) && !flipped.contains(&(qi, [x, y]))
                                {
                                    flipped.push((qi, [x, y]));
                                }
                                evaluated += 1;
                            }
                        }
                    }
                }
            }
        }
        // Census pinned on 2026-10-09: per-quad flipping-pixel counts over
        // both paints, both directions and four one-ULP perturbations —
        // 161 boundary pixels in 15,827,808 evaluations (~1/100k), each
        // flipping at most one quantization step. Index 0 is the recorded
        // scope-ledger counterexample quad. Any change to the coefficient
        // model must consciously re-derive this census.
        let total = holdout_quads().len();
        let mut counts = vec![0_usize; total];
        for (qi, _) in &flipped {
            counts[*qi] += 1;
        }
        assert_eq!(counts, [3, 4, 1, 17, 35, 0, 43, 1, 57, 0]);
        assert_eq!(evaluated, 15_827_808);
    }

    /// Pin the scope ledger's recorded model prediction for the counterexample
    /// quad so a silent change to reciprocal25 or the narrowing order fails
    /// here instead of quietly redefining the holdout.
    #[test]
    fn recorded_counterexample_reproduces_predicted_model_bits() {
        let quad = holdout_quads()[0].clone();
        let [x0, y0, x1, y1] = quad.pixels;
        let w = x1 - x0;
        let h = y1 - y0;
        let a = (1. * h * reciprocal25(w * h)) as f32;
        assert_eq!(a.to_bits(), 0x3b88_97e7);
        assert_eq!(
            scalar_perturbed(&quad, [quad.coverage.x, quad.coverage.y], 0., 1., 0., 0, 0),
            quad.scalar([quad.coverage.x, quad.coverage.y], 0., 1., 0.)
        );
    }
}
