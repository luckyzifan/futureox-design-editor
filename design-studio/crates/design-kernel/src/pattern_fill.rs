//! Pattern (tiled) image fills, following Figma's pattern-fill semantics.
//!
//! Uniform vocabulary (kept honest by tests):
//! `patternTexSizePixels / patternBoundsOffsetPixels / tileSizePixels /
//! fillSizePixels / offsetPixels / patternTileType`. The fragment chain
//! starts from the **paint-transformed local coordinate**
//! (`_coord2 = (paintTransform * vec3(position2, 1)).xy`), exactly where
//! this port composes `Paint.transform` before tiling; the math is quoted
//! line by line below.
//!
//! Uniform semantics (pattern-fill family, 4 shaders in the family):
//! `patternTileType` 0 = regular grid, 1 = horizontal stagger
//! (alternate rows shifted half a tile along x), 2 = vertical stagger
//! (alternate columns shifted half a tile along y); `offsetPixels` /
//! `patternBoundsOffsetPixels` are two opposite-sign pre-repeat translations;
//! `tileSizePixels` rescales the sampled texture window inside one cell
//! (`uv = fract(g) * texSize/tile`, clamped to `(texSize-0.5)/tile` — the
//! half-texel seam guard).
//!
//! Contract with the kernel sampler: `size` is the authored cell period in
//! node-local pixels per axis (the shader produces a per-axis period
//! `patternTexSizePixels/fillSizePixels` in `_coord2` units — that ratio is
//! what our `size` absorbs); `offset` carries `offsetPixels` with
//! `patternBoundsOffsetPixels` folded in (both are pre-fract translations,
//! the same degree of freedom with opposite signs). `size: 0` on an axis
//! means "the image's native extent" (pitch = `patternTexSizePixels`, i.e.
//! one texture per tile at 1:1). `tileSizePixels` is taken equal to
//! `patternTexSizePixels` (identity zoom: `i = 1`), so the half-texel clamp
//! `j` is exactly the sampler's existing `[0.5, n-0.5]` bilinear edge — see
//! the report for the one uniform we do not yet author.
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
/// kiwi `PatternAlignment` ordinal 0 — cells anchor at the fill's start edge.
pub const ALIGN_START: &str = "start";
/// kiwi `PatternAlignment` ordinal 1 — cells center within the fill.
pub const ALIGN_CENTER: &str = "center";
/// kiwi `PatternAlignment` ordinal 2 — cells anchor at the end edge.
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
    /// kiwi `verticalAlignment`/`horizontalAlignment` (`PatternAlignment`:
    /// start/center/end), axis order [x, y]. The engine-side mapping of an
    /// alignment to shader uniforms was not recovered, so the authored
    /// values are carried verbatim (import/export round-trip) without
    /// perturbing `tile_uv`.
    #[serde(default = "default_alignment")]
    pub alignment: [String; 2],
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
        }
    }
    /// `false` renders through the legacy single-placement image path.
    pub fn is_active(&self) -> bool {
        self.mode != NONE
    }
    /// Resolve the `0 = native` size convention against the image extent.
    pub fn resolve(&self, image: [f64; 2]) -> [f64; 2] {
        [
            if self.size[0] > 0. {
                self.size[0]
            } else {
                image[0].max(1.)
            },
            if self.size[1] > 0. {
                self.size[1]
            } else {
                image[1].max(1.)
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
pub fn tile_uv(pattern: &PatternTile, point: Point, size: [f64; 2]) -> Point {
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
    Point::new(g.x - g.x.floor(), g.y - g.y.floor())
}
