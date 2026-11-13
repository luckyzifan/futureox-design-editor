//! Sample a retained zoom-in picture without compounding the stretch.
//!
//! The previous viewport stays on screen while a closer tile is still missing.
//! Linear resampling of that picture is the hold. A tile that is already
//! finer replaces only its own world rectangle; the rest of the hold stays the
//! single resample of the original picture, not a resample of a resample.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampledPicture {
    pub world_x: f64,
    pub world_y: f64,
    pub world_w: f64,
    pub world_h: f64,
}

/// Device side of the first cell drawn during a continuous zoom-in.
/// The settled lattice stays on its ordinary tile. This cell is only the
/// region that can leave the stretched picture before that tile finishes.
pub const ZOOM_IN_FOCUS_CORE: f64 = 160.0;

/// Content box, in device pixels of the motion lattice, of the one focus
/// cell to raster first. The origin is the stable 160-pixel grid, so a later
/// wheel tick at the same scale keeps the same cell. The box is not clipped
/// to the live viewport: clipping would change the key every tick and cancel
/// the raster. `None` when the focus is outside the viewport.
pub fn zoom_in_focus_core(
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    focus_x: f64,
    focus_y: f64,
) -> Option<[f64; 4]> {
    let core = ZOOM_IN_FOCUS_CORE;
    if ![left, top, right, bottom, focus_x, focus_y]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    if !(right > left && bottom > top && core > 0.0) {
        return None;
    }
    if focus_x < left || focus_y < top || focus_x >= right || focus_y >= bottom {
        return None;
    }
    let x = (focus_x / core).floor() * core;
    let y = (focus_y / core).floor() * core;
    if !(x < right && y < bottom && x + core > left && y + core > top) {
        return None;
    }
    Some([x, y, core, core])
}

/// Normalized UV of `world` inside a picture whose device texture was rendered
/// with `base_view` at `base_dpr`. Matches the display underlay quad.
pub fn underlay_uv(
    base_view_x: f64,
    base_view_y: f64,
    base_zoom: f64,
    base_dpr: f64,
    texture_width: f64,
    texture_height: f64,
    world_x: f64,
    world_y: f64,
    world_w: f64,
    world_h: f64,
) -> [f64; 4] {
    let u = |x: f64| (x * base_zoom + base_view_x) * base_dpr / texture_width;
    let v = |y: f64| (y * base_zoom + base_view_y) * base_dpr / texture_height;
    [
        u(world_x),
        v(world_y),
        u(world_x + world_w),
        v(world_y + world_h),
    ]
}

fn texel(rgba: &[u8], width: u32, x: i32, y: i32) -> [f32; 4] {
    let height = rgba.len() as u32 / (width * 4);
    let x = x.clamp(0, width as i32 - 1) as u32;
    let y = y.clamp(0, height as i32 - 1) as u32;
    let i = ((y * width + x) * 4) as usize;
    [
        f32::from(rgba[i]),
        f32::from(rgba[i + 1]),
        f32::from(rgba[i + 2]),
        f32::from(rgba[i + 3]),
    ]
}

/// `texel_x` / `texel_y` use texel centers as integers. A sample at `n.0`
/// is exactly texel `n`.
fn sample_linear(rgba: &[u8], width: u32, height: u32, texel_x: f64, texel_y: f64) -> [u8; 4] {
    let x = texel_x.clamp(0.0, f64::from(width) - 1.0);
    let y = texel_y.clamp(0.0, f64::from(height) - 1.0);
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let fx = (x - f64::from(x0)) as f32;
    let fy = (y - f64::from(y0)) as f32;
    let samples = [
        texel(rgba, width, x0, y0),
        texel(rgba, width, x0 + 1, y0),
        texel(rgba, width, x0, y0 + 1),
        texel(rgba, width, x0 + 1, y0 + 1),
    ];
    let weights = [
        (1.0 - fx) * (1.0 - fy),
        fx * (1.0 - fy),
        (1.0 - fx) * fy,
        fx * fy,
    ];
    let mut out = [0u8; 4];
    for channel in 0..4 {
        let value = samples[0][channel] * weights[0]
            + samples[1][channel] * weights[1]
            + samples[2][channel] * weights[2]
            + samples[3][channel] * weights[3];
        out[channel] = (value + 0.5).floor().clamp(0.0, 255.0) as u8;
    }
    out
}

fn world_to_texel(world: f64, origin: f64, span: f64, pixels: u32) -> f64 {
    (world - origin) / span * f64::from(pixels) - 0.5
}

fn contains(picture: &SampledPicture, x: f64, y: f64) -> bool {
    x >= picture.world_x
        && y >= picture.world_y
        && x < picture.world_x + picture.world_w
        && y < picture.world_y + picture.world_h
}

/// `tiles` are painted in order, later over earlier. A pixel whose center lies
/// in a tile uses that tile. Every other pixel uses `base` once.
pub fn compose_zoom_in_preview(
    base: &SampledPicture,
    base_rgba: &[u8],
    base_width: u32,
    base_height: u32,
    tiles: &[(&SampledPicture, &[u8], u32, u32)],
    target: &SampledPicture,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>, String> {
    if base.world_w <= 0.0
        || base.world_h <= 0.0
        || target.world_w <= 0.0
        || target.world_h <= 0.0
        || base_width == 0
        || base_height == 0
        || target_width == 0
        || target_height == 0
    {
        return Err("zoom-in preview picture is empty".into());
    }
    if base_rgba.len() != base_width as usize * base_height as usize * 4 {
        return Err("zoom-in preview base is the wrong size".into());
    }
    for (picture, rgba, width, height) in tiles {
        if picture.world_w <= 0.0 || picture.world_h <= 0.0 || *width == 0 || *height == 0 {
            return Err("zoom-in preview tile is empty".into());
        }
        if rgba.len() != *width as usize * *height as usize * 4 {
            return Err("zoom-in preview tile is the wrong size".into());
        }
    }
    let mut output = vec![0u8; target_width as usize * target_height as usize * 4];
    for py in 0..target_height {
        for px in 0..target_width {
            let world_x =
                target.world_x + (f64::from(px) + 0.5) * target.world_w / f64::from(target_width);
            let world_y =
                target.world_y + (f64::from(py) + 0.5) * target.world_h / f64::from(target_height);
            let (picture, rgba, width, height) = tiles
                .iter()
                .rev()
                .find(|(picture, _, _, _)| contains(picture, world_x, world_y))
                .copied()
                .unwrap_or((base, base_rgba, base_width, base_height));
            let sample = sample_linear(
                rgba,
                width,
                height,
                world_to_texel(world_x, picture.world_x, picture.world_w, width),
                world_to_texel(world_y, picture.world_y, picture.world_h, height),
            );
            let index = ((py * target_width + px) * 4) as usize;
            output[index..index + 4].copy_from_slice(&sample);
        }
    }
    Ok(output)
}
