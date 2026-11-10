use crate::math::Point;
use serde::{Deserialize, Serialize};

/// `patternTileType = 0` — regular grid.
pub const GRID: &str = "grid";
/// `patternTileType = 1` — horizontal stagger (`g.x` shifted by row parity).
pub const STAGGER_HORIZONTAL: &str = "stagger_horizontal";
/// `patternTileType = 2` — vertical stagger (`g.y` shifted by column parity).
pub const STAGGER_VERTICAL: &str = "stagger_vertical";
/// Authored "off" — same rendering path as an absent field.
pub const NONE: &str = "none";
/// kiwi `PatternAlignment` ordinal 0 — the scaled image's start edge lies on
/// the fill's start edge.
pub const ALIGN_START: &str = "start";
/// kiwi `PatternAlignment` ordinal 1 — the scaled image's center lies on the
/// fill's center.
pub const ALIGN_CENTER: &str = "center";
/// kiwi `PatternAlignment` ordinal 2 — the scaled image's end edge lies on
/// the fill's end edge.
pub const ALIGN_END: &str = "end";

/// `patternTileType` value for a mode name.
pub fn tile_type(mode: &str) -> Option<i32> {
    match mode {
        GRID => Some(0),
        STAGGER_HORIZONTAL => Some(1),
        STAGGER_VERTICAL => Some(2),
        _ => None,
    }
}

/// Authored pattern tiling on an image paint (`Paint::tile`).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct PatternTile {
    /// Tiling mode; names follow `patternTileType` (see the mode consts).
    /// `none` renders exactly like an absent field.
    #[serde(default = "grid_mode")]
    pub mode: String,
    /// Cell period in node-local pixels per axis. `0` on an axis selects the
    /// image's native extent for that axis (`patternTexSizePixels`).
    #[serde(default)]
    pub size: [f64; 2],
    /// `offsetPixels` in node-local pixels (`patternBoundsOffsetPixels`
    /// folded in — same pre-fract translation, opposite sign).
    #[serde(default)]
    pub offset: [f64; 2],
    /// kiwi `horizontalAlignment` / `verticalAlignment` (`PatternAlignment`),
    /// axis order [x, y]. The scaled image box is pinned to the fill on each
    /// axis. The trailing spacing gap is outside that box. Rotation is about
    /// the pin, so a start-aligned pattern still turns around the fill origin.
    #[serde(default = "default_alignment")]
    pub alignment: [String; 2],
    /// Uniform scale of the image inside the cell. `1` with `size: 0` is the
    /// image's native extent. Explicit `size` already is the cell period and
    /// is not multiplied again.
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// Pattern rotation in degrees, applied before the repeat.
    #[serde(default)]
    pub rotation: f64,
    /// Extra gap after the scaled image, in node-local pixels. The gap is
    /// transparent; it is not part of the sampled texture.
    #[serde(default)]
    pub spacing: [f64; 2],
}

fn default_scale() -> f64 {
    1.
}

fn grid_mode() -> String {
    GRID.into()
}

fn default_alignment() -> [String; 2] {
    [ALIGN_START.into(), ALIGN_START.into()]
}

/// A valid kiwi `PatternAlignment` name.
pub fn is_alignment(mode: &str) -> bool {
    matches!(mode, ALIGN_START | ALIGN_CENTER | ALIGN_END)
}

impl PatternTile {
    /// The base FIG-import mapping: a regular grid at the image's native
    /// size with zero offset.
    pub fn native() -> Self {
        Self {
            mode: GRID.into(),
            size: [0., 0.],
            offset: [0., 0.],
            alignment: default_alignment(),
            scale: 1.,
            rotation: 0.,
            spacing: [0., 0.],
        }
    }
    /// `false` renders through the legacy single-placement image path.
    pub fn is_active(&self) -> bool {
        self.mode != NONE
    }
    /// Resolve the `0 = native` size convention against the image extent.
    pub fn resolve(&self, image: [f64; 2]) -> [f64; 2] {
        let content = self.content(image);
        [
            content[0] + self.spacing[0].max(0.),
            content[1] + self.spacing[1].max(0.),
        ]
    }
    fn content(&self, image: [f64; 2]) -> [f64; 2] {
        [
            if self.size[0] > 0. {
                self.size[0]
            } else {
                image[0].max(1.) * self.scale.max(1e-6)
            },
            if self.size[1] > 0. {
                self.size[1]
            } else {
                image[1].max(1.) * self.scale.max(1e-6)
            },
        ]
    }
    /// Mode name plus finite, bounded numbers; sizes are non-negative
    /// (`0` = native extent). Matches the paint-parameter bounds in
    /// `scene::Document::validate`.
    pub fn validate(&self) -> bool {
        (tile_type(&self.mode).is_some() || self.mode == NONE)
            && self
                .size
                .iter()
                .chain(self.offset.iter())
                .all(|v| v.is_finite() && v.abs() <= 1e7)
            && self.size.iter().all(|v| *v >= 0.)
            && self.alignment.iter().all(|a| is_alignment(a))
            && self.scale.is_finite()
            && self.scale > 0.
            && self.scale <= 1e6
            && self.rotation.is_finite()
            && self.rotation.abs() <= 1e6
            && self
                .spacing
                .iter()
                .all(|v| v.is_finite() && *v >= 0. && *v <= 1e7)
    }
}

/// The pattern-fill fragment chain, source order preserved. Expanded GLSL:
///
/// ```glsl
/// float d = fillSizePixels.x / patternTexSizePixels.x;   // per-axis scale
/// float e = fillSizePixels.y / patternTexSizePixels.y;
/// vec2  f = offsetPixels / patternTexSizePixels;          // tile units
/// vec2  g = vec2(_coord2.x * d, _coord2.y * e);
/// vec2  h = patternBoundsOffsetPixels / patternTexSizePixels;
/// g -= f;  g += h;
/// if (patternTileType == 1) g.x += (1.0 + step(1., mod(g.y, 2.0))) * 0.5;
/// else if (patternTileType == 2) g.y += (1.0 + step(1., mod(g.x, 2.0))) * 0.5;
/// g = fract(g);
/// vec2  i = patternTexSizePixels / tileSizePixels;        // == 1 here
/// vec2  j = (patternTexSizePixels - 0.5) / tileSizePixels;
/// gl_FragColor = texture2D(texture0, min(g * i, j));
/// ```
///
/// `point` is the paint-space local pixel (post `Paint.transform`, the
/// vertex-shader `_coord2` role); `size` is the resolved cell period; the
/// return value is the texture UV in `[0,1)²` (`fract(g)` with `i = 1`, so
/// the caller's half-texel bilinear clamp implements `j`).
///
/// This entry is the start-aligned shader chain. Fill alignment is applied
/// by [`tile_sample_in_fill`] before the chain runs.
pub fn tile_uv(pattern: &PatternTile, point: Point, size: [f64; 2]) -> Point {
    tile_sample(pattern, point, size).unwrap_or(Point::new(0., 0.))
}

fn rotate_pattern_sample(point: Point, degrees: f64) -> Point {
    if degrees == 0. {
        return point;
    }
    let rad = -degrees.to_radians();
    let (sin, cos) = rad.sin_cos();
    Point::new(cos * point.x - sin * point.y, sin * point.x + cos * point.y)
}

fn image_extent(pattern: &PatternTile, period: [f64; 2]) -> [f64; 2] {
    [
        (period[0] - pattern.spacing[0].max(0.)).max(1e-6),
        (period[1] - pattern.spacing[1].max(0.)).max(1e-6),
    ]
}

/// Where the scaled image box is pinned, `(fill pin, image pin)`, one axis.
fn image_pin(align: &str, fill: f64, image: f64) -> (f64, f64) {
    match align {
        ALIGN_CENTER => (fill * 0.5, image * 0.5),
        ALIGN_END => (fill, image),
        _ => (0., 0.),
    }
}

/// UV inside the image portion of one cell. `None` is the transparent gap
/// introduced by `spacing`. `size` is the resolved cell period from
/// [`PatternTile::resolve`], including that gap. Alignment is not applied;
/// [`tile_sample_in_fill`] is the fill-aware entry.
pub fn tile_sample(pattern: &PatternTile, point: Point, size: [f64; 2]) -> Option<Point> {
    sample_placed(
        pattern,
        rotate_pattern_sample(point, pattern.rotation),
        size,
    )
}

/// Place `point` in a fill of `fill` pixels, then sample.
///
/// On each axis the scaled image — not the trailing gap — is pinned to the
/// fill: start to start, center to center, end to end. Positive `rotation`
/// turns the pattern about that pin (the sample point turns the other way).
/// Start alignment is the historical origin-pinned chain, bit for bit.
pub fn tile_sample_in_fill(
    pattern: &PatternTile,
    point: Point,
    period: [f64; 2],
    fill: [f64; 2],
) -> Option<Point> {
    if pattern.alignment[0] == ALIGN_START && pattern.alignment[1] == ALIGN_START {
        return tile_sample(pattern, point, period);
    }
    if ![period[0], period[1], fill[0], fill[1]]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    let image = image_extent(pattern, period);
    let (fill_x, image_x) = image_pin(&pattern.alignment[0], fill[0], image[0]);
    let (fill_y, image_y) = image_pin(&pattern.alignment[1], fill[1], image[1]);
    let placed = rotate_pattern_sample(
        Point::new(point.x - fill_x, point.y - fill_y),
        pattern.rotation,
    );
    sample_placed(
        pattern,
        Point::new(placed.x + image_x, placed.y + image_y),
        period,
    )
}

fn sample_placed(pattern: &PatternTile, point: Point, size: [f64; 2]) -> Option<Point> {
    let content = image_extent(pattern, size);
    // vec2 g = _coord2 * (fillSizePixels/patternTexSizePixels) — with our
    // `size` absorbing that ratio and `offset` folding `-f + h`:
    let mut g = Point::new(
        (point.x - pattern.offset[0]) / size[0],
        (point.y - pattern.offset[1]) / size[1],
    );
    if pattern.mode == STAGGER_HORIZONTAL {
        // g.x += (1.0 + step(1., mod(g.y, 2.0))) * 0.5;
        // GLSL mod(x,2) ∈ [0,2) (also for negatives); step(1., m) is 1 iff
        // m >= 1. Post-fract the 1.0 shift is a no-op, so even bands stay
        // put and odd bands move half a tile — the brick offset.
        let m = g.y.rem_euclid(2.0);
        g.x += (1.0 + if m >= 1.0 { 1.0 } else { 0.0 }) * 0.5;
    } else if pattern.mode == STAGGER_VERTICAL {
        let m = g.x.rem_euclid(2.0);
        g.y += (1.0 + if m >= 1.0 { 1.0 } else { 0.0 }) * 0.5;
    }
    // g = fract(g); — GLSL fract(x) = x - floor(x) ∈ [0,1) for negatives
    // too (Rust's `fract` truncates and would wrap the wrong way).
    let fx = g.x - g.x.floor();
    let fy = g.y - g.y.floor();
    if fx * size[0] >= content[0] || fy * size[1] >= content[1] {
        return None;
    }
    Some(Point::new(
        fx * size[0] / content[0],
        fy * size[1] / content[1],
    ))
}
