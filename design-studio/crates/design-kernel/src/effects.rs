use crate::{
    blend::{Pixel, Surface},
    math::Rect,
};

#[derive(Clone, Copy)]
pub enum BlurFilter {
    Gaussian(f64),
    IntegratedTent(f64),
    PortableTent(f64),
    LinearTent(f64),
}
impl BlurFilter {
    pub fn apply(self, surface: &Surface) -> Result<Surface, String> {
        match self {
            Self::Gaussian(sigma) => blur(surface, sigma),
            Self::LinearTent(radius) => linear_tent_blur(surface, radius, false),
            Self::IntegratedTent(radius) => tent_blur(surface, radius),
            Self::PortableTent(radius) => portable_tent_blur_edge(surface, radius, false),
        }
    }
}

// Convolve a unit-area tent with the source and destination pixel boxes.
// Unlike point sampling, integrating both pixels preserves small-radius energy.
// This is a separable box-spline, not a Gaussian approximation. The finite
// support and edge response are inferred from our exported Figma blur fixtures.
pub fn tent_weight(radius: f64, distance: u32) -> f64 {
    if radius <= 0. {
        return f64::from(distance == 0);
    }
    // For r <= 1, the only side coefficient is integral_0^r
    // t*(r-t)/r^2 dt = r/6. Evaluating the cubic boundary formula
    // as ((1+r)-1)^3/(6*r*r) loses tiny radii and can produce 0/0.
    if radius <= 1. {
        return match distance {
            0 => 1. - radius / 3.,
            1 => radius / 6.,
            _ => 0.,
        };
    }
    if distance == 0 {
        return (radius - 1. / 3.) / (radius * radius);
    }
    let x = f64::from(distance);
    if x + 1. <= radius {
        return (radius - x) / (radius * radius);
    }
    // Only evaluate cubics at the support boundary to avoid cancellation of
    // large, almost equal values for wide filters.
    let cube = |v: f64| v.max(0.).powi(3);
    (cube(radius + 1. - x) - 2. * cube(radius - x)) / (6. * radius * radius)
}

/// Gradient-modulated blur compositing (the decoded two-tier shader
/// semantics, CPU side): `blurred` and `sharp` are the same layer's two
/// renders; each pixel blends by the gradient-projected strength using the
/// tier weight curves.  `inverse` maps device pixels back to node space.
pub fn gradient_blur_composite(
    target: &mut Surface,
    blurred: &Surface,
    inverse: &crate::math::Transform,
    params: &crate::scene::GradientBlurParameters,
) {
    let field = crate::gradient_blur::CompositeField::new(inverse, params);
    for y in target.rect.y..target.rect.bottom() {
        for x in target.rect.x..target.rect.right() {
            let (ti, bi) = match (target.rect.index(x, y), blurred.rect.index(x, y)) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            target.pixels[ti].0 = field.composite(
                target.pixels[ti].0, blurred.pixels[bi].0, x as f32 + 0.5, y as f32 + 0.5,
            );
        }
    }
}

pub fn tent_blur(surface: &Surface, radius: f64) -> Result<Surface, String> {
    tent_blur_edge(surface, radius, false)
}
pub fn tent_blur_edge(
    surface: &Surface,
    radius: f64,
    clamp_edges: bool,
) -> Result<Surface, String> {
    tent_blur_impl(surface, radius, clamp_edges, false, false)
}
pub const TENT_WEIGHT_SCALE: u32 = 1 << 24;
/// Symmetric Q24 coefficients with exact unit mass. The same bytes are uploaded
/// to both GPU APIs; shaders never independently approximate fractional weights.
pub fn quantized_tent_kernel(radius: f64) -> Result<Vec<u32>, String> {
    let radius = f64::from(radius as f32);
    if !radius.is_finite() || radius <= 0. || radius > 512. {
        return Err("Portable blur radius must be in (0, 512]".into());
    }
    let mut weights: Vec<u32> = (0..=radius.ceil() as u32)
        .map(|i| (tent_weight(radius, i) * f64::from(TENT_WEIGHT_SCALE)).round_ties_even() as u32)
        .collect();
    // At r <= 512 the center exceeds 32000 units, while all side-rounding
    // errors together are <= 512 units, so this subtraction cannot underflow.
    weights[0] = TENT_WEIGHT_SCALE - 2 * weights[1..].iter().sum::<u32>();
    Ok(weights)
}
pub fn portable_tent_blur_edge(
    surface: &Surface,
    radius: f64,
    clamp_edges: bool,
) -> Result<Surface, String> {
    let radius = f64::from(radius as f32);
    tent_blur_impl(
        surface,
        radius,
        clamp_edges,
        radius > 0. && radius <= 512. && radius.fract() != 0.,
        false,
    )
}
pub fn linear_tent_blur(
    surface: &Surface,
    radius: f64,
    clamp_edges: bool,
) -> Result<Surface, String> {
    crate::rational_filter::blur(surface, radius, clamp_edges)
}
fn tent_blur_impl(
    surface: &Surface,
    radius: f64,
    clamp_edges: bool,
    portable: bool,
    linear: bool,
) -> Result<Surface, String> {
    if radius <= 0. {
        return surface.try_clone();
    }
    let reach = radius.ceil() as i32;
    let interior = (radius.floor() as i32 - 1).max(0);
    // At integer radii the integrated coefficients have the exact common
    // denominator 6*r*r: center 6*r-2, interior 6*(r-i), endpoints 1.
    // UNORM8 input and integer-valued moments avoid half-way float drift, and
    // agree with the integer accumulator used by both GPU shaders.
    let integer = !linear && radius.fract() == 0. && radius <= 512.;
    let kernel =
        portable.then(|| quantized_tent_kernel(radius).expect("bounded finite portable radius"));
    let (center_error, side_error) = kernel.as_ref().map_or((0., 0.), |weights| {
        let delta = |i: usize| {
            (f64::from(weights[i]) / f64::from(TENT_WEIGHT_SCALE) - tent_weight(radius, i as u32))
                .abs()
        };
        (
            delta(0),
            (1..weights.len()).map(delta).fold(0_f64, f64::max),
        )
    });
    let center = if integer {
        6. * radius - 2.
    } else {
        tent_weight(radius, 0)
    };
    let inv_square = if integer { 6. } else { 1. / (radius * radius) };
    let boundary: Vec<_> = ((interior + 1)..=reach)
        .map(|i| {
            (
                i,
                if integer {
                    1.
                } else {
                    tent_weight(radius, i as u32)
                },
            )
        })
        .collect();
    let mut current = surface.try_clone()?;
    if !linear {
        current.quantize_rgba8();
    }
    for horizontal in [true, false] {
        let rect = current.rect;
        let mut next = current.new_like(rect)?;
        let (lines, len) = if horizontal {
            (rect.h as i32, rect.w as i32)
        } else {
            (rect.w as i32, rect.h as i32)
        };
        // Conservative rounding guard: only pixels whose nearest half-byte lies
        // inside this conservative error interval need the exact integer dot
        // product. The common path retains O(1) prefix moments per pixel.
        let arithmetic_error =
            64. * f64::EPSILON * 255. * (f64::from(len + reach) + 1.).powi(2) * inv_square.max(1.);
        let coarse_error =
            255. * (center_error + 2. * f64::from(reach) * side_error) + arithmetic_error;
        // The tent is linear away from its center/support boundary. Prefix sums
        // of color and its first moment integrate that entire interval in O(1).
        // f64 prevents cancellation from the first moments on long scanlines.
        // Scratch is O(scanline length); work no longer grows with blur radius.
        let _scratch = surface.reserve_scratch::<[f64; 4]>((len as usize + 1) * 2)?;
        let mut sums = vec![[0_f64; 4]; len as usize + 1];
        let mut moments = sums.clone();
        for line in 0..lines {
            let sample = |at: i32| {
                let at = if clamp_edges {
                    at.clamp(0, len - 1)
                } else {
                    at
                };
                let p = if horizontal {
                    current.at(rect.x + at, rect.y + line)
                } else {
                    current.at(rect.x + line, rect.y + at)
                };
                if integer || portable {
                    Pixel(p.0.map(|v| (v * 255.).round_ties_even()))
                } else {
                    p
                }
            };
            for at in 0..len {
                let value = sample(at);
                let i = at as usize;
                for c in 0..4 {
                    sums[i + 1][c] = sums[i][c] + f64::from(value.0[c]);
                    moments[i + 1][c] = moments[i][c] + f64::from(value.0[c]) * f64::from(at);
                }
            }
            for at in 0..len {
                let mut value = sample(at).0.map(|v| f64::from(v) * center);
                if interior > 0 {
                    let lo = (at - interior).max(0) as usize;
                    let mid = at as usize;
                    let right = (at + interior + 1).min(len) as usize;
                    for c in 0..4 {
                        let left_sum = sums[mid][c] - sums[lo][c];
                        let left_moment = moments[mid][c] - moments[lo][c];
                        let right_sum = sums[right][c] - sums[mid + 1][c];
                        let right_moment = moments[right][c] - moments[mid + 1][c];
                        value[c] += ((radius - f64::from(at)) * left_sum
                            + left_moment
                            + (radius + f64::from(at)) * right_sum
                            - right_moment)
                            * inv_square;
                    }
                    if clamp_edges {
                        let weight = |start: i32| {
                            let count = (interior - start + 1).max(0);
                            f64::from(count)
                                * (radius - f64::from(start + interior) / 2.)
                                * inv_square
                        };
                        let left = sample(0);
                        let right = sample(len - 1);
                        for (c, value) in value.iter_mut().enumerate() {
                            *value += f64::from(left.0[c]) * weight(at + 1)
                                + f64::from(right.0[c]) * weight(len - at);
                        }
                    }
                }
                for &(offset, weight) in &boundary {
                    let a = sample(at - offset);
                    let b = sample(at + offset);
                    for (c, v) in value.iter_mut().enumerate() {
                        *v += (f64::from(a.0[c]) + f64::from(b.0[c])) * weight;
                    }
                }
                let index = if horizontal {
                    line as usize * rect.w as usize + at as usize
                } else {
                    at as usize * rect.w as usize + line as usize
                };
                if linear {
                    next.pixels[index] = Pixel(value.map(|v| v as f32));
                    continue;
                }
                let bytes = value.map(|v| {
                    let byte = if integer {
                        v / (6. * radius * radius)
                    } else if portable {
                        v
                    } else {
                        v * 255.
                    };
                    byte.clamp(0., 255.)
                });
                let uncertain = kernel.is_some()
                    && bytes.iter().enumerate().any(|(c, b)| {
                        let distance = ((b - b.floor()) - 0.5).abs();
                        if distance > coarse_error {
                            return false;
                        }
                        // Nonnegative byte inputs let prefix sums bound the weight
                        // error using actual signal mass, not 255 at every tap.
                        let center = f64::from(sample(at).0[c]);
                        let lo = (at - reach).max(0) as usize;
                        let hi = (at + reach + 1).min(len) as usize;
                        let mut sides = sums[hi][c] - sums[lo][c] - center;
                        if clamp_edges {
                            sides += f64::from((reach - at).max(0)) * f64::from(sample(0).0[c]);
                            sides += f64::from((at + reach + 1 - len).max(0))
                                * f64::from(sample(len - 1).0[c]);
                        }
                        distance <= center_error * center + side_error * sides + arithmetic_error
                    });
                if let Some(weights) = kernel.as_ref().filter(|_| uncertain) {
                    let center = sample(at).0;
                    let mut exact = center.map(|v| v as u32 * weights[0]);
                    for (offset, weight) in weights.iter().enumerate().skip(1) {
                        let a = sample(at - offset as i32).0;
                        let b = sample(at + offset as i32).0;
                        for c in 0..4 {
                            exact[c] += (a[c] as u32 + b[c] as u32) * weight;
                        }
                    }
                    // sum(weights) == 2^24; max total == 255*2^24 < u32::MAX.
                    next.pixels[index] = Pixel(exact.map(|n| {
                        let q = n >> 24;
                        let r = n & 0xffffff;
                        (q + u32::from(r > 0x800000 || (r == 0x800000 && q % 2 == 1))) as f32 / 255.
                    }));
                } else {
                    next.pixels[index] = Pixel(bytes.map(|b| b.round_ties_even() as f32 / 255.));
                }
            }
        }
        current = next;
    }
    Ok(current)
}
fn box_pass(input: &Surface, r: i32, horizontal: bool) -> Result<Surface, String> {
    let rect = input.rect;
    if r <= 0 {
        return input.try_clone();
    }
    let mut out = input.new_like(rect)?;
    let (lines, len) = if horizontal {
        (rect.h as i32, rect.w as i32)
    } else {
        (rect.w as i32, rect.h as i32)
    };
    let denominator = f64::from(2 * r + 1);
    let kernel = crate::rational_filter::RationalKernel::uniform_box(r as u32)?;
    let _scratch = input.reserve_scratch::<f32>((2 * r + 1) as usize)?;
    let mut taps = vec![0.; (2 * r + 1) as usize];
    for line in 0..lines {
        let sample = |at: i32| {
            if horizontal {
                input.at(rect.x + at, rect.y + line)
            } else {
                input.at(rect.x + line, rect.y + at)
            }
        };
        // Higham's gamma_n bound for an ordered sum: at most n operations
        // over n terms of magnitude <= M. 8*eps*n^2*M also encloses the
        // endpoint/division rounding below. Accept only when both interval
        // endpoints round to the same binary32; otherwise use exact rationals.
        let magnitude = (0..len).fold([0_f64; 4], |mut m, at| {
            for (c, value) in sample(at).0.iter().enumerate() {
                m[c] = m[c].max(f64::from(*value).abs());
            }
            m
        });
        let operations = f64::from(2 * r + 1 + 2 * len);
        let error = magnitude.map(|m| 8. * f64::EPSILON * operations * operations * m);
        let mut sum = [0_f64; 4];
        for k in -r..=r {
            let p = sample(k);
            for (i, s) in sum.iter_mut().enumerate() {
                *s += f64::from(p.0[i]);
            }
        }
        for at in 0..len {
            let index = if horizontal {
                line as usize * rect.w as usize + at as usize
            } else {
                at as usize * rect.w as usize + line as usize
            };
            let mut channels = [0.; 4];
            for c in 0..4 {
                let lo = ((sum[c] - error[c]) / denominator).clamp(0., 1.) as f32;
                let hi = ((sum[c] + error[c]) / denominator).clamp(0., 1.) as f32;
                channels[c] = if lo.to_bits() == hi.to_bits() {
                    lo
                } else {
                    for (i, tap) in taps.iter_mut().enumerate() {
                        *tap = sample(at - r + i as i32).0[c];
                    }
                    kernel.convolve(&taps)?.clamp(0., 1.)
                };
            }
            out.pixels[index] = Pixel(channels);
            let remove = sample(at - r);
            let add = sample(at + r + 1);
            for (i, s) in sum.iter_mut().enumerate() {
                *s += f64::from(add.0[i]);
                *s -= f64::from(remove.0[i]);
            }
        }
    }
    Ok(out)
}
// Authoritative binary64 three-box radius selection, shared with both browsers.
pub fn gaussian_box_radii(sigma: f64) -> Result<[u32; 3], String> {
    if !sigma.is_finite() || !(0. ..=512.).contains(&sigma) {
        return Err("Gaussian sigma must be in [0,512]".into());
    }
    if sigma < 0.1 {
        return Ok([0; 3]);
    }
    let ideal = (4. * sigma * sigma + 1.).sqrt();
    let mut lower = ideal.floor() as i32;
    if lower % 2 == 0 {
        lower -= 1;
    }
    lower = lower.max(1);
    let upper = lower + 2;
    let m = ((12. * sigma * sigma - 3. * (lower * lower) as f64 - 12. * lower as f64 - 9.)
        / (-4. * lower as f64 - 4.))
        .round()
        .clamp(0., 3.) as i32;
    let radii =
        std::array::from_fn(|i| ((if (i as i32) < m { lower } else { upper } - 1) / 2) as u32);
    if radii.iter().any(|r| *r > 512) {
        return Err("Gaussian box radius exceeds 512 pixels".into());
    }
    Ok(radii)
}
// Premultiplied three-box Gaussian; certified sliding sums, exact tie fallback.
pub fn blur(surface: &Surface, sigma: f64) -> Result<Surface, String> {
    let mut out = surface.try_clone()?;
    for radius in gaussian_box_radii(sigma)? {
        if radius == 0 {
            continue;
        }
        out = box_pass(&out, radius as i32, true)?;
        out = box_pass(&out, radius as i32, false)?;
    }
    Ok(out)
}
pub fn morphology_alpha(input: &Surface, r: i32, dilate: bool) -> Result<Surface, String> {
    use std::collections::VecDeque;
    let mut src = input.try_clone()?;
    for horizontal in [true, false] {
        let rect = src.rect;
        let mut dst = src.try_clone()?;
        let (lines, len) = if horizontal {
            (rect.h as i32, rect.w as i32)
        } else {
            (rect.w as i32, rect.h as i32)
        };
        for line in 0..lines {
            let _scratch = input.reserve_scratch::<(i32, f32)>((2 * r + 2).max(0) as usize)?;
            let mut deque: VecDeque<(i32, f32)> =
                VecDeque::with_capacity((2 * r + 2).max(0) as usize);
            let sample = |at: i32| {
                if horizontal {
                    src.at(rect.x + at, rect.y + line).0[3]
                } else {
                    src.at(rect.x + line, rect.y + at).0[3]
                }
            };
            for at in -r..len + r {
                let value = sample(at);
                while deque
                    .back()
                    .is_some_and(|(_, v)| if dilate { *v <= value } else { *v >= value })
                {
                    deque.pop_back();
                }
                deque.push_back((at, value));
                while deque.front().is_some_and(|(i, _)| *i < at - 2 * r) {
                    deque.pop_front();
                }
                let x = at - r;
                if x >= 0 && x < len {
                    let a = deque.front().map_or(0., |v| v.1);
                    let index = if horizontal {
                        line as usize * rect.w as usize + x as usize
                    } else {
                        x as usize * rect.w as usize + line as usize
                    };
                    dst.pixels[index] = Pixel([0., 0., 0., a]);
                }
            }
        }
        src = dst;
    }
    Ok(src)
}
pub fn shadow(
    surface: &Surface,
    color: Pixel,
    sigma: f64,
    spread: f64,
    dx: f64,
    dy: f64,
    inner: bool,
) -> Result<Surface, String> {
    shadow_with_filter(
        surface,
        color,
        BlurFilter::Gaussian(sigma),
        spread,
        dx,
        dy,
        inner,
    )
}
pub(crate) fn shadow_with_filter(
    surface: &Surface,
    color: Pixel,
    filter: BlurFilter,
    spread: f64,
    dx: f64,
    dy: f64,
    inner: bool,
) -> Result<Surface, String> {
    let alpha = shadow_alpha(surface, filter, spread, inner)?;
    color_shadow_linear(surface, &alpha, color, dx, dy, inner)
}

pub(crate) fn shadow_alpha(
    surface: &Surface,
    filter: BlurFilter,
    spread: f64,
    inner: bool,
) -> Result<Surface, String> {
    let mut alpha = surface.try_clone()?;
    for p in &mut alpha.pixels {
        *p = Pixel([0., 0., 0., p.0[3]]);
    }
    if spread.abs() >= 0.5 {
        alpha = morphology_alpha(
            &alpha,
            spread.abs().round() as i32,
            if inner { spread < 0. } else { spread > 0. },
        )?;
    }
    filter.apply(&alpha)
}

/// Keep the filter boundary in byte space until the final quantization. Going
/// byte -> UNORM float -> opacity -> byte can move exact half-byte alpha to
/// opposite sides of a rounding boundary after GPU algebra simplification.
pub(crate) fn color_shadow_rgba8(
    surface: &Surface,
    alpha: &Surface,
    rgb: [f32; 3],
    opacity: f32,
    dx: f64,
    dy: f64,
    inner: bool,
) -> Result<Surface, String> {
    let mut out = surface.new_like(surface.rect)?;
    let sample = |x: f32, y: f32| {
        let x = x - alpha.rect.x as f32 - 0.5;
        let y = y - alpha.rect.y as f32 - 0.5;
        let (ix, iy) = (
            x.floor() as i32 + alpha.rect.x,
            y.floor() as i32 + alpha.rect.y,
        );
        let (u, v) = (x - x.floor(), y - y.floor());
        let byte = |x, y| (alpha.at(x, y).0[3] * 255.).round_ties_even();
        let top = byte(ix, iy) * (1. - u) + byte(ix + 1, iy) * u;
        let bottom = byte(ix, iy + 1) * (1. - u) + byte(ix + 1, iy + 1) * u;
        top * (1. - v) + bottom * v
    };
    for y in out.rect.y..out.rect.bottom() {
        for x in out.rect.x..out.rect.right() {
            let b = sample(x as f32 + 0.5 - dx as f32, y as f32 + 0.5 - dy as f32);
            let coverage = if inner {
                (surface.at(x, y).0[3] * 255.).round_ties_even() * (1. - b / 255.)
            } else {
                b
            };
            let alpha_fixed =
                ((opacity * coverage).clamp(0., 255.) * 65536.).round_ties_even() as u32;
            // 255 * (255 * 65536) = 4_261_478_400, safely below u32::MAX.
            // Q16 byte alpha avoids reassociation of RGB * opacity * coverage.
            let channels =
                [rgb[0], rgb[1], rgb[2], 1.].map(|c| (c * 255.).round_ties_even() as u32);
            const DENOMINATOR: u32 = 255 * 65536;
            out.pixels[out.rect.index(x, y).expect("shadow bounds")] = Pixel(channels.map(|c| {
                let numerator = c * alpha_fixed;
                let q = numerator / DENOMINATOR;
                let r = numerator % DENOMINATOR;
                (q + u32::from(r * 2 > DENOMINATOR || (r * 2 == DENOMINATOR && q % 2 == 1))) as f32
                    / 255.
            }));
        }
    }
    Ok(out)
}

pub(crate) fn color_shadow_linear(
    surface: &Surface,
    alpha: &Surface,
    color: Pixel,
    dx: f64,
    dy: f64,
    inner: bool,
) -> Result<Surface, String> {
    let mut out = surface.new_like(surface.rect)?;
    for y in out.rect.y..out.rect.bottom() {
        for x in out.rect.x..out.rect.right() {
            let b = alpha
                .sample_linear(f64::from(x) + 0.5 - dx, f64::from(y) + 0.5 - dy)
                .0[3];
            let coverage = if inner {
                surface.at(x, y).0[3] * (1. - b)
            } else {
                b
            };
            out.pixels[out.rect.index(x, y).expect("shadow")] = color.opacity(coverage);
        }
    }
    Ok(out)
}
pub fn noise(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x9e3779b1) ^ (y as u32).wrapping_mul(0x85ebca77) ^ seed;
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846ca68b);
    h ^= h >> 16;
    (h & 0x00ffffff) as f32 / 0x00ffffff as f32
}
pub fn texture(
    input: &Surface,
    amount: f64,
    transform: crate::math::Transform,
) -> Result<Surface, String> {
    texture_impl(input, amount, transform, false)
}
pub fn texture_linear(
    input: &Surface,
    amount: f64,
    transform: crate::math::Transform,
) -> Result<Surface, String> {
    texture_impl(input, amount, transform, true)
}
/// Color-independent sample-address field for managed GPU displacement. The
/// same binary64 coordinate compiler is used by native and WASM. Each texel
/// stores relative integer cell x/y and separately rounded binary32 fractions;
/// GPU backends still fetch and interpolate their own rendered color surfaces.
/// This avoids JSON payloads, f32 inverse matrices and a coordinate round trip
/// through a single f32 value. It is not a CPU color-render fallback.
pub fn texture_sampling_grid(
    rect: Rect,
    amount: f64,
    transform: crate::math::Transform,
) -> Result<Vec<f32>, String> {
    if !amount.is_finite() {
        return Err("Nonfinite texture displacement".into());
    }
    let inverse = transform.inverse_composed(rect)?;
    crate::sampling::coordinate_grid(rect, rect, |x, y| {
        Some(texture_location(x, y, amount, transform, inverse))
    })
}
fn texture_location(
    x: i32,
    y: i32,
    amount: f64,
    transform: crate::math::Transform,
    inverse: crate::math::Transform,
) -> crate::math::Point {
    let local = inverse.point(crate::math::Point::new(
        f64::from(x) + 0.5,
        f64::from(y) + 0.5,
    ));
    let nx = local.x.floor() as i32;
    let ny = local.y.floor() as i32;
    let dx = (f64::from(noise(nx, ny, 13)) - 0.5) * amount;
    let dy = (f64::from(noise(nx, ny, 29)) - 0.5) * amount;
    transform.point(local + crate::math::Point::new(dx, dy))
}
fn texture_impl(
    input: &Surface,
    amount: f64,
    transform: crate::math::Transform,
    linear: bool,
) -> Result<Surface, String> {
    if amount == 0. {
        return input.try_clone();
    }
    let mut out = input.try_clone()?;
    let inverse = transform.inverse_composed(input.rect)?;
    for y in out.rect.y..out.rect.bottom() {
        for x in out.rect.x..out.rect.right() {
            let sample = texture_location(x, y, amount, transform, inverse);
            if !sample.finite() {
                return Err("Nonfinite texture sample coordinate".into());
            }
            out.pixels[out.rect.index(x, y).expect("bounds")] = if linear {
                input.sample_linear(sample.x, sample.y)
            } else {
                input.sample(sample.x, sample.y)
            };
        }
    }
    Ok(out)
}
pub fn copy_region(input: &Surface, rect: Rect) -> Result<Surface, String> {
    let mut out = input.new_like(rect)?;
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            out.pixels[rect.index(x, y).expect("bounds")] = input.at(x, y);
        }
    }
    Ok(out)
}

/// The same ordered jump-flood distance field used by the GPU glass shader.
/// The result is unmasked; each geometric sample applies its own coverage later.
pub(crate) fn glass_unmasked(
    backdrop: &Surface,
    mask: &Surface,
    material: crate::material::GlassMaterial,
    rgba8: bool,
) -> Result<Surface, String> {
    let depth = material.depth;
    let refraction = material.refraction;
    let light = material.light;
    let r = backdrop.rect;
    let _scratch = backdrop.reserve_scratch::<[i32; 2]>(r.pixels() * 2)?;
    let mut field = vec![[-1_i32; 2]; r.pixels()];
    for y in 0..r.h as i32 {
        for x in 0..r.w as i32 {
            if mask.at(r.x + x, r.y + y).0[3] <= 0.5 {
                field[y as usize * r.w as usize + x as usize] = [x, y];
            }
        }
    }
    let mut step = r.w.max(r.h).max(1).next_power_of_two() / 2;
    let mut next = field.clone();
    while step >= 1 {
        for y in 0..r.h as i32 {
            for x in 0..r.w as i32 {
                let mut best = [-1, -1];
                let mut score = f32::INFINITY;
                for dy in [-1, 0, 1] {
                    for dx in [-1, 0, 1] {
                        let (sx, sy) = (x + dx * step as i32, y + dy * step as i32);
                        if sx < 0 || sy < 0 || sx >= r.w as i32 || sy >= r.h as i32 {
                            continue;
                        }
                        let p = field[sy as usize * r.w as usize + sx as usize];
                        if p[0] < 0 {
                            continue;
                        }
                        let a = (x - p[0]) as f32;
                        let b = (y - p[1]) as f32;
                        let d = a * a + b * b;
                        if d < score {
                            score = d;
                            best = p;
                        }
                    }
                }
                next[y as usize * r.w as usize + x as usize] = best;
            }
        }
        std::mem::swap(&mut field, &mut next);
        step /= 2;
    }
    let distance = |x: i32, y: i32| {
        let p = if x < 0 || y < 0 || x >= r.w as i32 || y >= r.h as i32 {
            [0, 0]
        } else {
            field[y as usize * r.w as usize + x as usize]
        };
        if p[0] < 0 {
            return 1_000_000_f32;
        }
        let a = (x - p[0]) as f32;
        let b = (y - p[1]) as f32;
        (a * a + b * b).sqrt()
    };
    let mut result = backdrop.try_clone()?;
    for y in 0..r.h as i32 {
        for x in 0..r.w as i32 {
            let d = distance(x, y);
            let gx = distance(x + 1, y) - distance(x - 1, y);
            let gy = distance(x, y + 1) - distance(x, y - 1);
            if material.modern {
                let pixel = crate::material::glass_pixel(
                    backdrop,
                    [r.x + x, r.y + y],
                    d,
                    [gx, gy],
                    material,
                    !rgba8,
                );
                result.pixels[y as usize * r.w as usize + x as usize] = if rgba8 {
                    pixel.rgba8_quantized()
                } else {
                    pixel
                };
                continue;
            }
            let len = (gx * gx + gy * gy).sqrt().max(1e-5);
            let factor = (1. - d / depth.max(4.)).clamp(0., 1.);
            let px = (r.x + x) as f32 + 0.5 + gx / len * refraction * factor * factor;
            let py = (r.y + y) as f32 + 0.5 + gy / len * refraction * factor * factor;
            let highlight = (gx - gy).abs() / len * factor * light * 0.25;
            if rgba8 {
                // Refraction and lighting are separate SDR materialization
                // boundaries, followed by exact byte source-over. Do not let
                // a driver's contraction of lighting into interpolation choose
                // the final half-byte direction.
                let sampled = backdrop.sample_rgba8(f64::from(px), f64::from(py));
                let light = Pixel::rgba(1., 1., 1., highlight).rgba8_quantized();
                result.pixels[y as usize * r.w as usize + x as usize] =
                    sampled.over_rgba8(light, 1.);
                continue;
            }
            let pixel = crate::blend::over(
                backdrop.sample_linear(f64::from(px), f64::from(py)),
                Pixel::rgba(1., 1., 1., highlight),
                "normal",
            );
            // Only legacy SDR intermediates use byte storage. Managed glass
            // must preserve extended linear RGB and unquantized alpha.
            result.pixels[y as usize * r.w as usize + x as usize] = pixel;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod gradient_blur_pipeline_tests {
    use super::*;
    use crate::math::Transform;

    fn surface(rect: Rect, fill: fn(i32, i32) -> [f32; 4]) -> Surface {
        let mut s = Surface::new(rect).unwrap();
        for y in rect.y..rect.bottom() {
            for x in rect.x..rect.right() {
                if let Some(i) = rect.index(x, y) {
                    s.pixels[i] = crate::blend::Pixel(fill(x, y));
                }
            }
        }
        s
    }

    #[test]
    fn composite_blends_blur_end_and_passes_sharp_end_through() {
        // 40x1 strip, gradient along x 0→40, strength 0→8 (smooth tier).
        let rect = Rect::new(0, 0, 40, 1);
        let mut target = surface(rect, |_, _| [0., 1., 0., 1.]); // sharp green
        let blurred = surface(rect, |_, _| [1., 0., 0., 1.]); // blurred red
        let params = crate::scene::GradientBlurParameters {
            start: [0., 0.],
            end: [40., 0.],
            start_count: 0.,
            end_count: 8.,
            smooth: true,
        };
        gradient_blur_composite(&mut target, &blurred, &Transform::default(), &params);
        let px = |x: i32| target.pixels[rect.index(x, 0).unwrap()].0;
        // t≈0 (x=0): strength < 1 → sharp passes through untouched.
        assert_eq!(px(0), [0., 1., 0., 1.]);
        // t=1 (x=39): heavy blur dominates → strongly red.
        assert!(px(39)[0] > 0.9 && px(39)[1] < 0.1, "end {:#?}", px(39));
        // monotone ramp along the gradient.
        let mid = px(20)[0];
        assert!(
            mid > px(5)[0] && mid < px(35)[0],
            "ramp {} < {} < {}",
            px(5)[0],
            mid,
            px(35)[0]
        );
    }

    #[test]
    fn off_axis_projection_clamps_to_segment() {
        let rect = Rect::new(0, 0, 10, 10);
        let mut target = surface(rect, |_, _| [0., 1., 0., 1.]);
        let blurred = surface(rect, |_, _| [1., 0., 0., 1.]);
        let params = crate::scene::GradientBlurParameters {
            start: [0., 5.],
            end: [10., 5.],
            start_count: 0.,
            end_count: 8.,
            smooth: true,
        };
        gradient_blur_composite(&mut target, &blurred, &Transform::default(), &params);
        // same x ⇒ same strength regardless of y (projection semantics)
        let a = target.pixels[rect.index(5, 1).unwrap()].0;
        let b = target.pixels[rect.index(5, 9).unwrap()].0;
        assert_eq!(a, b);
    }
}
