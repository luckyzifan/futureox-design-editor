//! Numeric planning for a filtered backdrop capture.
//!
//! This module only compiles coordinates and filter parameters. It does not
//! capture pixels, select source objects, or choose a renderer's tile sizes.
//! Every arithmetic operation below has a binary32 rounding boundary. In
//! particular, the filter count is retained from before scale quantization.

use std::{error::Error, fmt};

/// The largest integer tile dimension that is represented exactly by `f32`.
pub const MAX_TILE_PIXELS: u32 = 1 << 24;

/// Inputs in the caller's normalized tile coordinate system.
///
/// `normalized_support` includes all source displacement support, whereas
/// `normalized_blur` is the filter radius alone. Neither is a document-pixel
/// radius. The caller supplies the tile configuration explicitly.
#[derive(Clone, Copy, Debug)]
pub struct CaptureInput {
    pub normalized_support: f32,
    pub normalized_blur: f32,
    pub target_pixels: u32,
    pub source_pixels: u32,
    pub divisor: u32,
    /// Row-major affine matrix `[m00, m01, tx, m10, m11, ty]`.
    pub transform: [f32; 6],
    /// Normalized rectangle `[left, top, right, bottom]` before expansion.
    pub bounds: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct CapturePlan {
    /// Normalized triangle count, before any downscale pass adjusts it.
    pub kernel_count: f32,
    pub density: f32,
    pub normalized_padding: f32,
    /// Centered density transform composed with the supplied affine matrix.
    pub transform: [f32; 6],
    /// Expanded normalized rectangle `[left, top, right, bottom]`.
    pub expanded_bounds: [f32; 4],
    /// Checked integer rectangle `[x, y, width, height]` with a one-pixel guard.
    pub pixel_bounds: [i32; 4],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapturePlanError {
    InvalidTileConfiguration,
    InvalidRadius,
    InvalidTransform,
    InvalidBounds,
    ArithmeticRange,
    PixelBoundsOverflow,
}

impl fmt::Display for CapturePlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidTileConfiguration => "Invalid backdrop tile configuration",
            Self::InvalidRadius => {
                "Backdrop support must be finite and nonnegative; blur must be finite and positive"
            }
            Self::InvalidTransform => "Backdrop transform must be finite",
            Self::InvalidBounds => "Backdrop bounds must be finite and ordered",
            Self::ArithmeticRange => "Backdrop parameters exceed the binary32 arithmetic range",
            Self::PixelBoundsOverflow => "Backdrop pixel bounds exceed the signed integer range",
        })
    }
}

impl Error for CapturePlanError {}

// Keep these as separate binary32 operations. Reassociation, an FMA, or a
// binary64 temporary changes the parameter contract at rounding boundaries.
fn add(a: f32, b: f32) -> f32 {
    a + b
}
fn mul(a: f32, b: f32) -> f32 {
    a * b
}
fn div(a: f32, b: f32) -> f32 {
    a / b
}

fn positive(value: f32) -> Result<f32, CapturePlanError> {
    if value.is_finite() && value > 0. {
        Ok(value)
    } else {
        Err(CapturePlanError::ArithmeticRange)
    }
}

/// The shift itself rounds to binary32 before truncation. This must not be
/// replaced by `round()`, whose behavior next to a half-integer can differ.
fn shift_then_truncate(value: f32) -> f32 {
    // This is the predecessor of 0.5, not the rounded decimal 0.5 itself.
    // Adding exact 0.5 incorrectly increments large odd integers.
    let bias = f32::from_bits(0x3eff_ffff);
    add(value, bias.copysign(value)).trunc()
}

fn pixel_edge(value: f32) -> Result<i32, CapturePlanError> {
    let rounded = shift_then_truncate(value);
    if !rounded.is_finite()
        || f64::from(rounded) < f64::from(i32::MIN)
        || f64::from(rounded) > f64::from(i32::MAX)
    {
        return Err(CapturePlanError::PixelBoundsOverflow);
    }
    Ok(rounded as i32)
}

/// Compile a capture plan without allocating image buffers.
///
/// Dimensions and the divisor must be in `1..=MAX_TILE_PIXELS`, and integer
/// `source_pixels / divisor / 2` must exceed one. Derived values must remain
/// finite and positive. Pixel edges and dimensions must fit `i32`; invalid
/// inputs and arithmetic overflow are errors, never a clipped or empty plan.
pub fn compile(input: CaptureInput) -> Result<CapturePlan, CapturePlanError> {
    if [input.target_pixels, input.source_pixels, input.divisor]
        .iter()
        .any(|v| !(1..=MAX_TILE_PIXELS).contains(v))
        || input.source_pixels / input.divisor / 2 <= 1
    {
        return Err(CapturePlanError::InvalidTileConfiguration);
    }
    if !input.normalized_support.is_finite()
        || input.normalized_support < 0.
        || !input.normalized_blur.is_finite()
        || input.normalized_blur <= 0.
    {
        return Err(CapturePlanError::InvalidRadius);
    }
    if !input.transform.iter().all(|v| v.is_finite()) {
        return Err(CapturePlanError::InvalidTransform);
    }
    if !input.bounds.iter().all(|v| v.is_finite())
        || input.bounds[0] > input.bounds[2]
        || input.bounds[1] > input.bounds[3]
    {
        return Err(CapturePlanError::InvalidBounds);
    }

    let target = input.target_pixels as f32;
    let divisor = input.divisor as f32;
    let maximum = (input.source_pixels / input.divisor / 2 - 1) as f32;
    let support = input
        .normalized_support
        .max(input.normalized_blur)
        .max(div(0.001, divisor));
    let scaled_support = positive(mul(support, divisor))?;
    let denominator = positive(add(add(scaled_support, scaled_support), 1.))?;
    let raw_count = positive(mul(mul(div(1., denominator), support), target))?;
    let limited = maximum.min(raw_count);
    let mut padding = positive(div(limited, target))?;
    let count_before_cap = positive(mul(div(input.normalized_blur, support), limited))?;
    let kernel_count = count_before_cap.min(64.);
    let mut density = positive(div(
        div(padding, support),
        div(count_before_cap, kernel_count),
    ))?;

    let steps = positive(div(target, divisor))?;
    if density > div(2., steps) {
        density = positive(div(shift_then_truncate(mul(steps, density)), steps))?;
        let expanded_support = positive(mul(mul(support, density), target))?;
        padding = positive(div(maximum.min(expanded_support), target))?;
    }

    // Compose translate(.5) * scale(density) * translate(-.5) with the
    // supplied affine transform. The two additions in each translation are
    // deliberately separate, including the zero product.
    let translation = add(add(0.5, mul(-0.5, density)), mul(0., -0.5));
    let [a, b, tx, c, d, ty] = input.transform;
    let transform = [
        add(mul(density, a), mul(0., c)),
        add(mul(density, b), mul(0., d)),
        add(add(translation, mul(density, tx)), mul(0., ty)),
        add(mul(0., a), mul(density, c)),
        add(mul(0., b), mul(density, d)),
        add(add(translation, mul(0., tx)), mul(density, ty)),
    ];
    let [left, top, right, bottom] = input.bounds;
    let points = [(left, top), (right, top), (right, bottom), (left, bottom)].map(|(x, y)| {
        [
            add(add(translation, mul(density, x)), mul(0., y)),
            add(add(translation, mul(0., x)), mul(density, y)),
        ]
    });
    if !transform
        .iter()
        .chain(points.iter().flatten())
        .all(|v| v.is_finite())
    {
        return Err(CapturePlanError::ArithmeticRange);
    }
    let minimum_x = points.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min);
    let minimum_y = points.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min);
    let maximum_x = points
        .iter()
        .map(|p| p[0])
        .fold(f32::NEG_INFINITY, f32::max);
    let maximum_y = points
        .iter()
        .map(|p| p[1])
        .fold(f32::NEG_INFINITY, f32::max);
    let expanded_bounds = [
        add(minimum_x, -padding),
        add(minimum_y, -padding),
        add(add(padding, maximum_x), 0.),
        add(padding, add(maximum_y, 0.)),
    ];
    if !expanded_bounds.iter().all(|v| v.is_finite()) {
        return Err(CapturePlanError::ArithmeticRange);
    }
    let x = pixel_edge(add(mul(expanded_bounds[0], target), -1.))?;
    let y = pixel_edge(add(mul(expanded_bounds[1], target), -1.))?;
    let right = pixel_edge(add(mul(expanded_bounds[2], target), 1.))?;
    let bottom = pixel_edge(add(mul(expanded_bounds[3], target), 1.))?;
    let width = right
        .checked_sub(x)
        .filter(|v| *v > 0)
        .ok_or(CapturePlanError::PixelBoundsOverflow)?;
    let height = bottom
        .checked_sub(y)
        .filter(|v| *v > 0)
        .ok_or(CapturePlanError::PixelBoundsOverflow)?;
    Ok(CapturePlan {
        kernel_count,
        density,
        normalized_padding: padding,
        transform,
        expanded_bounds,
        pixel_bounds: [x, y, width, height],
    })
}
