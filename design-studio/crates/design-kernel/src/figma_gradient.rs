//! Measured SDR linear-gradient source arithmetic.
//!
//! The lookup is paint data, not a rasterized color image: CPU, WebGPU and
//! WebGL independently sample it and apply the same dither mathematics. The
//! only sine table belongs to `texture_noise`; this module does not duplicate
//! it. Radial/angular/diamond gradients and managed/HDR interpolation are not
//! established by these controls. Callers retain their constant-fill shortcut.
//!
//! Full PNG validation additionally requires the ordered four-pass export
//! accumulator. A source color here must not be mistaken for an export pixel.
#![forbid(unsafe_code)]

use crate::figma_sampling::{
    GRADIENT_LUT_WIDTH, GradientStop, fraction_q8, gradient_lut, sample_q8,
};
use crate::texture_noise::{self, SineMode};
use crate::{
    math::{Point, Rect, Transform},
    scene::Paint,
};
use std::fmt;

/// Exact normalized axis matrices are another encoding of these angles.
/// Keep authored matrices intact; only the sampling plan reads this value.
pub(crate) fn canonical_angle(paint: &Paint) -> Option<f64> {
    match paint.transform {
        None if paint.angle.is_finite() && paint.angle.rem_euclid(45.) == 0. => Some(paint.angle),
        Some(m) if m.0 == [1., 0., 0., 1., 0., 0.] => Some(0.),
        Some(m) if m.0 == [0., 1., -1., 0., 1., 0.] => Some(90.),
        _ => None,
    }
}
/// The diagonal/axis mapping is established by offset and two-axis controls.
/// Other paint transforms retain their existing coordinate implementation.
pub fn supported(paint: &Paint, matrix: Transform) -> bool {
    paint.kind == "linear"
        && paint.blend == "normal"
        && canonical_angle(paint).is_some()
        && paint.constant_color().is_none()
        && !paint.stops.is_empty()
        && matrix.0.iter().all(|v| v.is_finite())
        && matrix.0[1] == 0.
        && matrix.0[2] == 0.
        && matrix.0[0] > 0.
        && matrix.0[3] > 0.
}

pub fn from_paint(paint: &Paint) -> Result<LinearGradient, String> {
    let mut stops = paint
        .stops
        .iter()
        .map(|stop| {
            Ok(GradientStop {
                offset: stop.offset as f32,
                color: crate::color::unmanaged_straight(&stop.color)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    LinearGradient::new(&stops).map_err(|e| e.to_string())
}

pub struct Coordinates {
    inverse: Transform,
    size: [f32; 2],
    direction: u32,
    sample: [f64; 2],
    software: bool,
}
impl Coordinates {
    pub fn new(
        rect: Rect,
        matrix: Transform,
        size: [f64; 2],
        paint: &Paint,
        sample: usize,
    ) -> Result<Self, String> {
        Self::with_raster(rect, matrix, size, paint, sample, false)
    }

    pub fn with_raster(
        rect: Rect,
        matrix: Transform,
        size: [f64; 2],
        paint: &Paint,
        sample: usize,
        software: bool,
    ) -> Result<Self, String> {
        if !supported(paint, matrix)
            || size
                .iter()
                .any(|v| !v.is_finite() || *v <= 0. || *v > 10_000_000.)
        {
            return Err("Unsupported measured gradient coordinates".into());
        }
        let &(x, y) = crate::fidelity::SAMPLE_OFFSETS
            .get(sample)
            .ok_or("Invalid gradient sample")?;
        Ok(Self {
            inverse: matrix.inverse_composed(rect)?,
            size: size.map(|v| v as f32),
            direction: (canonical_angle(paint)
                .ok_or("Unsupported gradient transform")?
                .rem_euclid(360.)
                / 45.) as u32,
            sample: [x, y],
            software,
        })
    }
    pub fn at(&self, x: i32, y: i32) -> Result<[f32; 4], String> {
        let q = self.inverse.point(Point::new(
            f64::from(x) + self.sample[0],
            f64::from(y) + self.sample[1],
        ));
        let u = q.x as f32 / self.size[0];
        let v = q.y as f32 / self.size[1];
        let t = match self.direction {
            0 => u,
            1 => (u + v) * 0.5,
            2 => v,
            3 => ((1. - u) + v) * 0.5,
            4 => 1. - u,
            5 => ((1. - u) + (1. - v)) * 0.5,
            6 => 1. - v,
            _ => (u + (1. - v)) * 0.5,
        };
        let pixel = [x.rem_euclid(512) as u32, y.rem_euclid(512) as u32];
        let noise = if self.software {
            software_dither_offset(pixel)
        } else {
            dither_offset(pixel).map_err(|e| e.to_string())?
        };
        Ok([t, noise, 0., 0.])
    }
}

pub fn field(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    paint: &Paint,
    sample: usize,
) -> Result<Vec<f32>, String> {
    let coordinates = Coordinates::new(rect, matrix, size, paint, sample)?;
    crate::sampling::parameter_grid(rect, |x, y| coordinates.at(x, y))
}

pub fn field_with_raster(
    rect: Rect,
    matrix: Transform,
    size: [f64; 2],
    paint: &Paint,
    sample: usize,
    software: bool,
) -> Result<Vec<f32>, String> {
    let coordinates = Coordinates::with_raster(rect, matrix, size, paint, sample, software)?;
    crate::sampling::parameter_grid(rect, |x, y| coordinates.at(x, y))
}

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidInput(&'static str),
    Lookup(String),
    Sine(texture_noise::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(stage) => write!(f, "invalid linear-gradient input: {stage}"),
            Self::Lookup(message) => f.write_str(message),
            Self::Sine(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for Error {}

/// Straight SDR stops, interpolated and premultiplied into the measured
/// 1024-by-2 high/low-byte lookup. One instance can be reused across passes.
#[derive(Clone, Debug)]
pub struct LinearGradient {
    lookup: Vec<u8>,
}

impl LinearGradient {
    pub fn new(stops: &[GradientStop]) -> Result<Self, Error> {
        Ok(Self {
            lookup: gradient_lut(stops).map_err(Error::Lookup)?,
        })
    }

    /// Upload these 8192 bytes as a 1024-by-2 RGBA8 lookup. Each rendering
    /// backend performs its own sampling; do not upload CPU-painted pixels.
    pub fn lookup_bytes(&self) -> &[u8] {
        &self.lookup
    }

    /// Sample the authored linear parameter, already evaluated in binary32.
    /// For a horizontal export control, t=(source_x+sample_x)/(2*output_width).
    /// No half-texel correction is added to t. Addressing clamps at the ends.
    pub fn sample(&self, t: f32) -> Result<[f32; 4], Error> {
        self.sample_with_raster(t, false)
    }

    pub fn sample_with_raster(&self, t: f32, software: bool) -> Result<[f32; 4], Error> {
        if !t.is_finite() {
            return Err(Error::InvalidInput("linear parameter"));
        }
        // Keep multiply and subtract separate: shader contraction of this
        // coordinate expression is not part of the measured contract.
        let scaled = t.clamp(0.0, 1.0) * GRADIENT_LUT_WIDTH as f32;
        let coordinate = (scaled - 0.5).clamp(0.0, (GRADIENT_LUT_WIDTH - 1) as f32);
        let left = coordinate.floor() as usize;
        let right = (left + 1).min(GRADIENT_LUT_WIDTH - 1);
        let wx = fraction_q8(coordinate - left as f32);
        let pixel = |row: usize, column: usize| -> [u8; 4] {
            let offset = (row * GRADIENT_LUT_WIDTH + column) * 4;
            self.lookup[offset..offset + 4].try_into().unwrap()
        };
        // v=.25+.5/256 on a two-row texture gives Q8 vertical weight exactly1.
        let sample = if software {
            crate::software_raster::sample_q8
        } else {
            sample_q8
        };
        Ok(sample(
            [
                pixel(0, left),
                pixel(0, right),
                pixel(1, left),
                pixel(1, right),
            ],
            wx,
            1,
        ))
    }

    /// Return one source-frame float RGBA value. `source_pixel` is the integer
    /// export-viewport pixel; dither uses its center and does not follow the
    /// geometry jitter. The caller encodes this source value into RGBA8.
    pub fn paint(&self, t: f32, opacity: f32, source_pixel: [u32; 2]) -> Result<[f32; 4], Error> {
        if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) {
            return Err(Error::InvalidInput("opacity"));
        }
        let color = self.sample(t)?.map(|component| component * opacity);
        if color[3] == 0.0 {
            return Ok(color);
        }
        let offset = dither_offset(source_pixel)?;
        let mut result = color.map(|component| (component + offset).abs().min(1.0));
        if color[3] == 1.0 {
            result[3] = 1.0;
        }
        Ok(result)
    }
}

/// Center-coordinate hash, evaluated with the independently measured sine
/// primitive. The dot product rounds x*12.9898 before fusing y*78.233 with it.
/// Positive pixel centers keep these inputs on the exact Q19 sine nodes;
/// off-grid phases return an error rather than silently interpolate.
pub fn noise_at_pixel(pixel: [u32; 2]) -> Result<f32, Error> {
    // Binary32 must represent the pixel center, including its half fraction.
    if pixel.iter().any(|value| *value >= 8_388_608) {
        return Err(Error::InvalidInput("source pixel center"));
    }
    let x = pixel[0] as f32 + 0.5;
    let y = pixel[1] as f32 + 0.5;
    let argument = y.mul_add(78.233_f32, x * 12.9898_f32);
    let wave = texture_noise::sine(argument, SineMode::RequireGridNode)
        .map_err(Error::Sine)?
        .value;
    let scrambled = wave * 43_758.547_f32;
    Ok(scrambled - scrambled.floor())
}

/// This authored binary32 amplitude is 0.007843, not the rational 2/255.
pub fn dither_offset(pixel: [u32; 2]) -> Result<f32, Error> {
    Ok((noise_at_pixel(pixel)? - 0.5) * 0.007843_f32)
}

/// Explicit software-export dither, with separately rounded dot products.
/// The authored amplitude, pixel-center coordinates and alpha lock stay the
/// same as the legacy path. Only the specified scalar arithmetic changes.
pub fn software_dither_offset(pixel: [u32; 2]) -> f32 {
    let x = pixel[0] as f32 + 0.5;
    let y = pixel[1] as f32 + 0.5;
    let argument = x * 12.9898_f32 + y * 78.233_f32;
    let wave = crate::software_raster::trigonometry::sin(argument);
    let scrambled = wave * 43_758.547_f32;
    ((scrambled - scrambled.floor()) - 0.5) * 0.007843_f32
}
