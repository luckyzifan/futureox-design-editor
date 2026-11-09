//! Tile stack addressing for the canvas renderer.
//!
//! The viewport is cut into fixed-size tiles at power-of-two zoom levels.
//! Every tile exposes its device viewport, scissor rects (absolute and
//! render-target-relative), UV-space rect and clear policy, matching the
//! surface a GPU compositor needs per tile.
use crate::handles::{Arena, Handle};

pub const TILE_SIZE: i32 = 512;

/// A tile address: zoom level plus integer tile coordinates at that level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub level: i32,
    pub x: i32,
    pub y: i32,
}

impl TileKey {
    /// World scale this level renders at.
    pub fn scale(self) -> f64 {
        2f64.powi(self.level)
    }
    /// Tile origin in world units.
    pub fn world_origin(self) -> (f64, f64) {
        (
            self.x as f64 * TILE_SIZE as f64 / self.scale(),
            self.y as f64 * TILE_SIZE as f64 / self.scale(),
        )
    }
    /// Device-pixel rect this tile occupies when composited at `level`.
    pub fn device_rect(self) -> (i32, i32, u32, u32) {
        let origin = self.world_origin();
        let scale = self.scale();
        (
            (origin.0 * scale).round() as i32,
            (origin.1 * scale).round() as i32,
            TILE_SIZE as u32,
            TILE_SIZE as u32,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UvRect {
    pub u: f64,
    pub v: f64,
    pub du: f64,
    pub dv: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const TRANSPARENT: Color = Color {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 0.,
    };
    pub fn is_transparent(self) -> bool {
        self.a == 0.
    }
}

/// Per-tile state the compositor queries; fields mirror the clear/scissor
/// contract a tile-based GPU backend publishes per render pass.
#[derive(Clone, Debug, PartialEq)]
pub struct TileState {
    pub key: TileKey,
    pub viewport: Rect,
    pub scissor: Rect,
    pub clear_color: Color,
    pub single_texture: bool,
}

impl TileState {
    pub fn needs_color_clear(&self) -> bool {
        !self.clear_color.is_transparent() || !self.single_texture
    }
    pub fn needs_color_clear_to_transparent(&self) -> bool {
        self.clear_color.is_transparent() && self.needs_color_clear()
    }
    pub fn needs_depth_stencil_clear(&self) -> bool {
        !self.single_texture
    }
    /// Scissor offset by the tile origin, for render-target-relative passes.
    pub fn scissor_relative_to_render_target(&self) -> Rect {
        Rect {
            x: self.scissor.x - self.viewport.x,
            y: self.scissor.y - self.viewport.y,
            w: self.scissor.w,
            h: self.scissor.h,
        }
    }
    /// Scissor pre-clipped to the viewport for clear passes.
    pub fn scissor_for_clear(&self) -> Rect {
        intersect(self.scissor, self.viewport)
    }
    pub fn uv_space_rect(&self) -> UvRect {
        let (u0, v0) = (
            (self.scissor.x - self.viewport.x) as f64 / TILE_SIZE as f64,
            (self.scissor.y - self.viewport.y) as f64 / TILE_SIZE as f64,
        );
        let (u1, v1) = (
            (self.scissor.x - self.viewport.x + self.scissor.w) as f64 / TILE_SIZE as f64,
            (self.scissor.y - self.viewport.y + self.scissor.h) as f64 / TILE_SIZE as f64,
        );
        UvRect {
            u: u0,
            v: v0,
            du: u1 - u0,
            dv: v1 - v0,
        }
    }
    pub fn size(&self) -> (i32, i32) {
        (self.scissor.w.max(0), self.scissor.h.max(0))
    }
}

fn intersect(a: Rect, b: Rect) -> Rect {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.w).min(b.x + b.w);
    let y1 = (a.y + a.h).min(b.y + b.h);
    Rect {
        x: x0,
        y: y0,
        w: (x1 - x0).max(0),
        h: (y1 - y0).max(0),
    }
}

/// Tile registry: allocates per-tile state and answers spatial queries for
/// the visible region of a viewport.
pub struct TileStack {
    tiles: Arena<TileState>,
    /// Background clear colour applied to tiles without explicit state.
    background: Color,
}

impl Default for TileStack {
    fn default() -> Self {
        TileStack {
            tiles: Arena::default(),
            background: Color::TRANSPARENT,
        }
    }
}

impl TileStack {
    pub fn new(background: Color) -> Self {
        TileStack {
            tiles: Arena::default(),
            background,
        }
    }

    pub fn set_background(&mut self, color: Color) {
        self.background = color;
    }

    pub fn tile_handle(&mut self, key: TileKey) -> Handle {
        let (dx, dy, w, h) = key.device_rect();
        let viewport = Rect {
            x: dx,
            y: dy,
            w: w as i32,
            h: h as i32,
        };
        let state = TileState {
            key,
            viewport,
            scissor: viewport,
            clear_color: self.background,
            single_texture: false,
        };
        self.tiles.alloc(state)
    }

    pub fn get(&self, handle: Handle) -> Option<&TileState> {
        self.tiles.get(handle)
    }

    pub fn get_mut(&mut self, handle: Handle) -> Option<&mut TileState> {
        self.tiles.get_mut(handle)
    }

    pub fn release(&mut self, handle: Handle) -> bool {
        self.tiles.free(handle).is_some()
    }

    pub fn len(&self) -> usize {
        self.tiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }

    /// Tiles covering a world-space rectangle at `level`; `pad` grows the
    /// rect in world units before snapping, for effects that bleed past
    /// node bounds.
    pub fn tiles_for_rect(&self, level: i32, world: Rect, pad: i32) -> Vec<TileKey> {
        let scale = TileKey { level, x: 0, y: 0 }.scale();
        let tile = TILE_SIZE as f64;
        let x0 = ((world.x - pad) as f64 * scale / tile).floor() as i32;
        let y0 = ((world.y - pad) as f64 * scale / tile).floor() as i32;
        let x1 = (((world.x + world.w + pad) as f64 * scale / tile).ceil() as i32).max(x0);
        let y1 = (((world.y + world.h + pad) as f64 * scale / tile).ceil() as i32).max(y0);
        let mut keys = Vec::with_capacity(((x1 - x0 + 1) * (y1 - y0 + 1)).max(0) as usize);
        for y in y0..=y1 {
            for x in x0..=x1 {
                keys.push(TileKey { level, x, y });
            }
        }
        keys
    }

    /// 3x3 row-major matrix mapping tile-local pixels to world units.
    pub fn tile_to_node(&self, key: TileKey) -> [f64; 9] {
        let scale = key.scale();
        let (wx, wy) = key.world_origin();
        [1. / scale, 0., 0., 0., 1. / scale, 0., wx, wy, 1.]
    }

    /// Level whose scale best matches the requested zoom.
    pub fn level_for_zoom(zoom: f64) -> i32 {
        if zoom <= 0. || !zoom.is_finite() {
            return 0;
        }
        zoom.log2().round().clamp(-8., 8.) as i32
    }
}

/// Fixed raster scale at or above the requested zoom. The live camera
/// resamples these committed pixels until the next scale bucket is needed.
pub fn exact_bucket_scale(scale: f64) -> f64 {
    if !scale.is_finite() || scale <= 0. {
        return scale;
    }
    if scale <= 0.1 {
        return 0.1;
    }
    let mut bucket = 0.25;
    while bucket < scale {
        bucket *= 2.;
    }
    bucket
}

/// Preview scale at or below the requested zoom. Scales up to 2 use
/// 0.1 / 0.25 / 0.5 / 1 buckets; smaller requests keep halving from 0.1.
pub fn lod_bucket_scale(scale: f64) -> f64 {
    if !scale.is_finite() || scale <= 0. {
        return scale;
    }
    if scale > 2. {
        return scale;
    }
    if scale > 1. {
        return 1.;
    }
    if scale > 0.5 {
        return 0.5;
    }
    if scale > 0.25 {
        return 0.25;
    }
    let mut bucket = 0.1;
    while bucket > scale {
        bucket *= 0.5;
    }
    bucket
}

/// Exact production raster grid. Unlike display-level tile handles this uses
/// the requested zoom without power-of-two resampling. The grid is anchored to
/// world-device multiples of `TILE_SIZE`: the same world span always addresses
/// the same tiles regardless of camera translation or subpixel phase, so a pan
/// reuses resident tiles and only newly exposed tiles rasterize (`phase` is
/// validated for contract compatibility but no longer shifts the grid).
pub fn raster_addresses(
    bounds: [f64; 4],
    zoom: f64,
    limit: usize,
    phase: [f64; 2],
) -> Result<Vec<[i32; 2]>, String> {
    if bounds
        .iter()
        .chain(phase.iter())
        .chain(std::iter::once(&zoom))
        .any(|x| !x.is_finite())
        || bounds[2] < 0.
        || bounds[3] < 0.
        || zoom <= 0.
        || phase.iter().any(|x| !(0. ..1.).contains(x))
    {
        return Err("Invalid tile bounds".into());
    }
    let tile = f64::from(TILE_SIZE);
    // A phase-aware resident begins at (address * TILE_SIZE - phase) / zoom.
    // Address the same shifted grid here, including the final row/column when
    // a fractional camera moves its visible edge across a tile boundary.
    let start = [(bounds[0] * zoom + phase[0]) / tile, (bounds[1] * zoom + phase[1]) / tile].map(f64::floor);
    let end = [
        ((bounds[0] + bounds[2]) * zoom + phase[0]) / tile,
        ((bounds[1] + bounds[3]) * zoom + phase[1]) / tile,
    ]
    .map(f64::ceil);
    if start
        .iter()
        .chain(end.iter())
        .any(|x| !x.is_finite() || x.abs() > i32::MAX as f64 / f64::from(TILE_SIZE))
    {
        return Err("Tile address exceeds exact coordinate range".into());
    }
    let count = (end[0] - start[0]) * (end[1] - start[1]);
    if count > limit.min(65536) as f64 {
        return Err("Visible tile budget exceeded".into());
    }
    let mut tiles = Vec::with_capacity(count as usize);
    for y in start[1] as i32..end[1] as i32 {
        for x in start[0] as i32..end[0] as i32 {
            tiles.push([x, y]);
        }
    }
    Ok(tiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_geometry_at_identity_level() {
        let key = TileKey {
            level: 0,
            x: 2,
            y: -1,
        };
        assert_eq!(key.world_origin(), (1024., -512.));
        assert_eq!(key.device_rect(), (1024, -512, 512, 512));
    }

    #[test]
    fn tile_geometry_zooms_round_trip() {
        for level in [-3, 0, 2] {
            let key = TileKey { level, x: 1, y: 1 };
            let (wx, wy) = key.world_origin();
            let (dx, dy, w, h) = key.device_rect();
            assert!((wx * key.scale() - dx as f64).abs() < 1e-9);
            assert!((wy * key.scale() - dy as f64).abs() < 1e-9);
            assert_eq!((w, h), (512, 512));
        }
    }

    #[test]
    fn scissor_math_matches_clear_contract() {
        let mut stack = TileStack::default();
        let handle = stack.tile_handle(TileKey {
            level: 0,
            x: 0,
            y: 0,
        });
        let state = stack.get_mut(handle).unwrap();
        state.scissor = Rect {
            x: -64,
            y: 128,
            w: 512,
            h: 128,
        };
        state.clear_color = Color {
            r: 1.,
            g: 1.,
            b: 1.,
            a: 1.,
        };
        let state = stack.get(handle).unwrap();
        let clear = state.scissor_for_clear();
        assert_eq!((clear.x, clear.y, clear.w, clear.h), (0, 128, 448, 128));
        let relative = state.scissor_relative_to_render_target();
        assert_eq!((relative.x, relative.y), (-64, 128));
        assert!(state.needs_color_clear());
        assert!(!state.needs_color_clear_to_transparent());
        let uv = state.uv_space_rect();
        assert!((uv.u - (-0.125)).abs() < 1e-9, "raw scissor u is -64/512");
        assert!((uv.v - 0.25).abs() < 1e-9);
        assert!((uv.du - 1.0).abs() < 1e-9, "raw scissor width is 512/512");
        assert!((uv.dv - 0.25).abs() < 1e-9);
        assert_eq!(state.size(), (512, 128));
    }

    #[test]
    fn transparent_clear_reports_transparent_clear() {
        let mut stack = TileStack::default();
        let handle = stack.tile_handle(TileKey {
            level: 0,
            x: 0,
            y: 0,
        });
        let state = stack.get(handle).unwrap();
        assert_eq!(state.clear_color, Color::TRANSPARENT);
        assert!(state.needs_color_clear());
        assert!(state.needs_color_clear_to_transparent());
        assert!(state.needs_depth_stencil_clear());
    }

    #[test]
    fn tiles_for_rect_snaps_outward() {
        let stack = TileStack::default();
        let world = Rect {
            x: 100,
            y: 100,
            w: 300,
            h: 300,
        };
        let keys = stack.tiles_for_rect(0, world, 0);
        assert_eq!(
            keys.first().copied(),
            Some(TileKey {
                level: 0,
                x: 0,
                y: 0
            })
        );
        // A 512 grid covers the 100..400 span with the 0 and 1 columns.
        assert_eq!(keys.len(), 4);
        let wide = Rect {
            x: 100,
            y: 100,
            w: 600,
            h: 300,
        };
        let keys = stack.tiles_for_rect(0, wide, 0);
        assert_eq!(keys.len(), 6);
        assert_eq!(
            keys.last().copied(),
            Some(TileKey {
                level: 0,
                x: 2,
                y: 1
            })
        );
    }

    #[test]
    fn tile_to_node_maps_tile_origin_to_world() {
        let stack = TileStack::default();
        let key = TileKey {
            level: 1,
            x: 3,
            y: 2,
        };
        let m = stack.tile_to_node(key);
        let (wx, wy) = key.world_origin();
        // tile-local (0,0) -> world origin
        let x = 0. * m[0] + 0. * m[1] + m[6];
        let y = 0. * m[3] + 0. * m[4] + m[7];
        assert!((x - wx).abs() < 1e-9 && (y - wy).abs() < 1e-9);
        // tile-local (512,0) -> one tile width in world units
        let x = 512. * m[0] + m[6];
        assert!(
            (x - (wx + 256.)).abs() < 1e-9,
            "level 1 tile covers half the world distance"
        );
    }

    #[test]
    fn handles_are_stable_until_released() {
        let mut stack = TileStack::default();
        let a = stack.tile_handle(TileKey {
            level: 0,
            x: 0,
            y: 0,
        });
        assert!(stack.get(a).is_some());
        assert!(stack.release(a));
        assert!(stack.get(a).is_none());
        assert!(!stack.release(a));
        assert_eq!(stack.len(), 0);
    }

    #[test]
    fn level_for_zoom_picks_nearest_power_of_two() {
        assert_eq!(TileStack::level_for_zoom(1.), 0);
        assert_eq!(TileStack::level_for_zoom(0.5), -1);
        assert_eq!(TileStack::level_for_zoom(4.), 2);
        assert_eq!(TileStack::level_for_zoom(0.), 0);
        assert_eq!(TileStack::level_for_zoom(-3.), 0);
    }

    #[test]
    fn exact_bucket_scale_pins_the_mipmap_ladder_from_above() {
        // Level [0] covers everything at or below 0.1 (Sketch reuses it upscaled).
        assert_eq!(exact_bucket_scale(0.001), 0.1);
        assert_eq!(exact_bucket_scale(0.1), 0.1);
        assert_eq!(exact_bucket_scale(0.101), 0.25);
        assert_eq!(exact_bucket_scale(0.25), 0.25);
        assert_eq!(exact_bucket_scale(0.3), 0.5);
        assert_eq!(exact_bucket_scale(1.), 1.);
        assert_eq!(exact_bucket_scale(1.5), 2.);
        assert_eq!(exact_bucket_scale(2.), 2.);
        // Level [5] is pinned on first use above 2x: power-of-two steps keep
        // the over-render bound and make cache keys deterministic.
        assert_eq!(exact_bucket_scale(2.1), 4.);
        assert_eq!(exact_bucket_scale(3.9), 4.);
        assert_eq!(exact_bucket_scale(4.), 4.);
        assert_eq!(exact_bucket_scale(7.), 8.);
        assert_eq!(exact_bucket_scale(0.), 0.);
    }

    #[test]
    fn lod_bucket_scale_follows_the_threshold_table() {
        assert_eq!(lod_bucket_scale(4.), 4.);
        assert_eq!(lod_bucket_scale(2.), 1.);
        assert_eq!(lod_bucket_scale(1.5), 1.);
        assert_eq!(lod_bucket_scale(1.), 0.5);
        assert_eq!(lod_bucket_scale(0.75), 0.5);
        assert_eq!(lod_bucket_scale(0.5), 0.25);
        assert_eq!(lod_bucket_scale(0.3), 0.25);
        assert_eq!(lod_bucket_scale(0.25), 0.1);
        assert_eq!(lod_bucket_scale(0.101), 0.1);
        assert_eq!(lod_bucket_scale(0.1), 0.1);
        assert_eq!(lod_bucket_scale(0.09), 0.05);
        assert_eq!(lod_bucket_scale(0.02), 0.0125);
        assert_eq!(lod_bucket_scale(0.001), 0.00078125);
        // Degenerate input passes through; the exact planner validates zoom.
        assert_eq!(lod_bucket_scale(0.), 0.);
        assert!(lod_bucket_scale(f64::NAN).is_nan());
    }

    #[test]
    fn lod_bucket_scale_never_exceeds_the_requested_scale() {
        for i in 1..400 {
            let scale = i as f64 / 100.;
            assert!(lod_bucket_scale(scale) <= scale);
        }
    }

    #[test]
    fn raster_addresses_are_world_anchored() {
        // Phase changes samples and may expose an additional edge tile.
        let plain = raster_addresses([100., 0., 512., 512.], 1., 64, [0., 0.]).unwrap();
        let phased = raster_addresses([100., 0., 512., 512.], 1., 64, [0.75, 0.25]).unwrap();
        assert_eq!(plain, vec![[0, 0], [1, 0]]);
        assert_eq!(phased, vec![[0, 0], [1, 0], [0, 1], [1, 1]]);
        let aligned = raster_addresses([-0.75, -0.25, 512., 512.], 1., 64, [0.75, 0.25]).unwrap();
        assert_eq!(aligned, vec![[0, 0]]);
        // Translating the span by whole tiles shifts indices canonically.
        let shifted = raster_addresses([612., 512., 512., 512.], 1., 64, [0., 0.]).unwrap();
        assert_eq!(shifted, vec![[1, 1], [2, 1]]);
        // Coverage still snaps outward around the visible span.
        let partial = raster_addresses([-1., -1., 1., 1.], 1., 64, [0., 0.]).unwrap();
        assert_eq!(partial, vec![[-1, -1]]);
    }
}
