//! Deterministic, node-centered texture displacement parameters.
//!
//! The finite numeric domains used by the fixed seed0 graph match independent
//! Apple M2 Pro mathematical probes bit-for-bit, including operation ordering.
//! Unsupported inputs are errors. This module only produces geometry parameters;
//! rendering backends still sample and composite their own colors. Numerical
//! agreement does not establish external Figma image parity. See
//! `texture_noise/math-metadata.json` for domains, provenance and validation.
#![forbid(unsafe_code)]

pub mod clip_weight;
pub mod gabor;

use std::fmt;

const SINC: &[u8; 2_097_156] = include_bytes!("texture_noise/sine-q19.bin");
pub const LUT_BYTES: usize = SINC.len();
/// Shared immutable numerical data for backend upload; no second LUT allocation.
pub fn sine_table_bytes() -> &'static [u8] {
    SINC
}
pub const LUT_SHA256: &str = "7700b8984942195a45b7e9b4fa9b571666c44cad67013521d851cb5af5654622";
pub const SEED_PLAN_SHA256: &str =
    "fc76acc1fe985f718afcdbc27f9ae4a4d778a48ca2bc187eb5bf2ad7546457d3";
const Q22_RESIDUAL: &[u8] = include_bytes!("texture_noise/q22-complete-residual-3bit.bin");
const GRADIENT_LOW_RESIDUAL: &[u8] = include_bytes!("texture_noise/gradient-low-q25-3bit.bin");
const COORDINATE_LOW_RESIDUAL: &[u8] = include_bytes!("texture_noise/coordinate-low-q22-3bit.bin");
const COORDINATE_COMPOSED_RESIDUAL: &[u8] =
    include_bytes!("texture_noise/coordinate-composed-q22-3bit.bin");
const POSITIVE_RESIDUALS: [&[u8]; 4] = [
    include_bytes!("texture_noise/positive-exponent--2-3bit.bin"),
    include_bytes!("texture_noise/positive-exponent--1-3bit.bin"),
    include_bytes!("texture_noise/positive-exponent-0-3bit.bin"),
    include_bytes!("texture_noise/positive-exponent-1-3bit.bin"),
];
const RSQRT_RESIDUAL: &[u8] = include_bytes!("texture_noise/rsqrt-residual.bin");
/// Shared Q19 bytes plus exact arithmetic residual data, before compression.
pub const TOTAL_MATH_BYTES: usize = 26_686_749;
/// SHA bindings for all additional independently generated mathematical assets.
pub static RESIDUAL_ASSETS: &[NumericAsset] = &[
    NumericAsset {
        name: "q22-complete-residual-3bit.bin",
        sha256: "801db65d1316ff0fb06ae796d0053a852f594710e0d1db6f3c82ca6305dd039b",
        bytes: include_bytes!("texture_noise/q22-complete-residual-3bit.bin"),
    },
    NumericAsset {
        name: "gradient-low-q25-3bit.bin",
        sha256: "3c7a1abccdc84e053dead4b1327df4ba0eaaffec6192d1eef0fc8252b890e840",
        bytes: include_bytes!("texture_noise/gradient-low-q25-3bit.bin"),
    },
    NumericAsset {
        name: "positive-exponent--2-3bit.bin",
        sha256: "78d86087fa7bd5aec980660269a8ace44e6adfcf67cc7ed6be6c181a31ab8d11",
        bytes: include_bytes!("texture_noise/positive-exponent--2-3bit.bin"),
    },
    NumericAsset {
        name: "positive-exponent--1-3bit.bin",
        sha256: "0464506536a460785110ce03d795fb9d2987f6f0e8ca7fdfb63503232dd6e1ee",
        bytes: include_bytes!("texture_noise/positive-exponent--1-3bit.bin"),
    },
    NumericAsset {
        name: "positive-exponent-0-3bit.bin",
        sha256: "3085da58c32fa6c860ba3517ae1f1f515326a4cdd8d6437aec04a9af36fac8b1",
        bytes: include_bytes!("texture_noise/positive-exponent-0-3bit.bin"),
    },
    NumericAsset {
        name: "positive-exponent-1-3bit.bin",
        sha256: "d9c69da32a1d04dbb45abfeea4f4cb9b23653628943a906c304615c529b2d808",
        bytes: include_bytes!("texture_noise/positive-exponent-1-3bit.bin"),
    },
    NumericAsset {
        name: "coordinate-low-q22-3bit.bin",
        sha256: "f18a10a8408155590c42756c1b8d0bee972661ce46851ed558c93f9c5f863b90",
        bytes: include_bytes!("texture_noise/coordinate-low-q22-3bit.bin"),
    },
    NumericAsset {
        name: "coordinate-composed-q22-3bit.bin",
        sha256: "fb22ec959558f0ef2d9a096716e890eb6bebba5c85243b461685e5d8df18310f",
        bytes: include_bytes!("texture_noise/coordinate-composed-q22-3bit.bin"),
    },
    NumericAsset {
        name: "rsqrt-residual.bin",
        sha256: "5c81e7f88a7ec172e9a2100e32d80d472e21bb639991ac32197ea70e22fd38c2",
        bytes: include_bytes!("texture_noise/rsqrt-residual.bin"),
    },
];

const GRID: f32 = 524_288.0;
const LAST: usize = 524_288;
const INV_TAU: f32 = f32::from_bits(0x3e22_f983);
// These are authored numerical constants, not substitutions for mathematical pi/e.
const COORD_X: f32 = f32::from_bits(0x414f_d639);
const COORD_Y: f32 = f32::from_bits(0x429c_774c);
const MODULUS: f32 = f32::from_bits(0x4049_0fd0);
const INV_MODULUS: f32 = 1.0 / MODULUS;
const SCRAMBLE_SCALE: f32 = f32::from_bits(0x43db_45cc);
const SCRAMBLE_OFFSET: f32 = f32::from_bits(0x3fdd_b3d0);
const WEIGHT_SCALE: [f32; 2] = [f32::from_bits(0x3fcf_1b9b), f32::from_bits(0x3f1e_3737)];
const WEIGHT_OFFSET: [f32; 2] = [f32::from_bits(0x4192_c28f), f32::from_bits(0x41ac_5810)];
const DIRECTIONS: [[f32; 2]; 2] = [
    [f32::from_bits(0x4146_b852), f32::from_bits(0x429c_75c3)],
    [f32::from_bits(0xc19f_d70a), f32::from_bits(0x41f9_ae14)],
];

/// Six independently generated mathematical triples [seed, frequency_x, frequency_y].
/// Order: channel, octave, triple member. No image pixels or node IDs are stored.
/// The resulting planned Metal gradients matched 13,068 baseline components
/// bit-for-bit. Only the fixed base seed 0 is represented by this plan.
pub const SEED_PLAN_BITS: [[[u32; 3]; 3]; 2] = [
    [
        [1027342336, 1059454976, 1049067520],
        [1049919488, 1043595264, 1060601856],
        [1060896768, 1061158912, 1045757952],
    ],
    [
        [1063487488, 1058603008, 1063845888],
        [1058275328, 1062141952, 1062469632],
        [1051721728, 1058471936, 1051721728],
    ],
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SineMode {
    RequireGridNode,
    RequireSupportedDomain,
    /// Legacy variant retained for source compatibility; now exact-or-error.
    AllowInterpolation,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SineSample {
    pub value: f32,
    pub interpolated: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Quality {
    pub sine_grid_samples: u32,
    /// Always zero: successful texture evaluation no longer uses approximation.
    pub sine_interpolated_samples: u32,
    /// Exact samples resolved by complete residual tables or the enumerated tiny domain.
    pub sine_residual_samples: u32,
    /// Exact captured normalizations in the declared finite domain.
    pub normalizations: u32,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub offset: [f32; 2],
    pub quality: Quality,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInput(&'static str),
    NonFinite(&'static str),
    OffGridSine {
        phase_bits: u32,
    },
    UnsupportedDomain {
        stage: &'static str,
        value_bits: u32,
    },
    ZeroGradient,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(stage) => write!(f, "invalid texture noise input: {stage}"),
            Self::NonFinite(stage) => write!(f, "nonfinite texture noise arithmetic: {stage}"),
            Self::OffGridSine { phase_bits } => write!(
                f,
                "sine phase {phase_bits:#010x} is outside the exact Q19 nodes"
            ),
            Self::UnsupportedDomain { stage, value_bits } => {
                write!(f, "unsupported exact {stage} input {value_bits:#010x}")
            }
            Self::ZeroGradient => f.write_str("texture noise gradient has zero length"),
        }
    }
}
impl std::error::Error for Error {}

fn table(index: usize) -> f32 {
    let start = index * 4;
    f32::from_bits(u32::from_le_bytes([
        SINC[start],
        SINC[start + 1],
        SINC[start + 2],
        SINC[start + 3],
    ]))
}
fn fraction(v: f32) -> f32 {
    v - v.floor()
}
fn checked(v: f32, stage: &'static str) -> Result<f32, Error> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(Error::NonFinite(stage))
    }
}
/// A mathematical asset generated from independent scalar GPU probes.
/// These bytes never contain scene colors, reference pixels or node IDs.
pub struct NumericAsset {
    pub name: &'static str,
    pub sha256: &'static str,
    pub bytes: &'static [u8],
}

#[derive(Clone, Copy)]
struct Quarter {
    triangle: f32,
    magnitude: f32,
    fraction: f32,
    approximate: f32,
}
fn quarter(cycles: f32) -> Result<Quarter, Error> {
    checked(cycles, "sine reduction")?;
    let phase = fraction(cycles) * 4.0;
    let triangle = if phase < 1.0 {
        phase
    } else if phase < 3.0 {
        2.0 - phase
    } else {
        phase - 4.0
    };
    let magnitude = triangle.abs();
    let position = magnitude * GRID;
    let index = position.floor() as usize;
    if index > LAST {
        return Err(Error::NonFinite("sine phase"));
    }
    let fraction = position - index as f32;
    let left = table(index);
    // Interpolation is only a residual-table baseline, never a successful
    // approximation fallback. Every non-node result must be corrected below.
    let approximate = if fraction == 0.0 {
        left
    } else {
        (table(index + 1) - left).mul_add(fraction, left)
    };
    Ok(Quarter {
        triangle,
        magnitude,
        fraction,
        approximate,
    })
}
fn code3(bytes: &[u8], index: usize) -> u8 {
    let bit = index * 3;
    let byte = bit / 8;
    // Every bundled 3-bit asset has one SHA-bound zero sentinel byte.
    let word = u16::from(bytes[byte]) | (u16::from(bytes[byte + 1]) << 8);
    ((word >> (bit % 8)) & 7) as u8
}
fn corrected(q: Quarter, bytes: &[u8], index: usize) -> f32 {
    let bits = (i64::from(q.approximate.to_bits()) + i64::from(code3(bytes, index)) - 3) as u32;
    f32::from_bits(bits).copysign(q.triangle)
}
#[derive(Clone, Copy)]
struct ResolvedSine {
    value: f32,
    q19: bool,
}
fn grid_sine(q: Quarter) -> Option<ResolvedSine> {
    if q.fraction == 0.0 {
        return Some(ResolvedSine {
            value: q.approximate.copysign(q.triangle),
            q19: true,
        });
    }
    let key = q.magnitude * 4_194_304.0;
    if key == key.floor() {
        let key = key as usize;
        return Some(ResolvedSine {
            value: corrected(q, Q22_RESIDUAL, key - key / 8 - 1),
            q19: false,
        });
    }
    None
}
fn resolve_sine(value: f32, mode: SineMode) -> Result<ResolvedSine, Error> {
    if !value.is_finite() {
        return Err(Error::InvalidInput("sine argument"));
    }
    let q = quarter(value * INV_TAU)?;
    if mode == SineMode::RequireGridNode && q.fraction != 0.0 {
        return Err(Error::OffGridSine {
            phase_bits: q.magnitude.to_bits(),
        });
    }
    if let Some(result) = grid_sine(q) {
        return Ok(result);
    }
    let result = if (1.0 / 67_108_864.0..1.0 / 8192.0).contains(&value) {
        let slope = if q.magnitude < 1.0 / 4_194_304.0 {
            f32::from_bits(0x3fc9_0fdb)
        } else {
            f32::from_bits(0x3fc9_0fda)
        };
        q.triangle * slope
    } else if (0.25..4.0).contains(&value) {
        let bits = value.to_bits();
        corrected(
            q,
            POSITIVE_RESIDUALS[((bits >> 23) - 125) as usize],
            (bits & 0x7f_ffff) as usize,
        )
    } else if value > 0.0 && value < 0.25 {
        let gradient_index = value * 33_554_432.0;
        if gradient_index == gradient_index.floor() {
            corrected(q, GRADIENT_LOW_RESIDUAL, gradient_index as usize)
        } else {
            const SCALE: f32 = f32::from_bits(0x402d_f84d) * (1.0 / 4_194_304.0);
            let index = (value / SCALE).round();
            if !(0.0..385_751.0).contains(&index) || (index * SCALE).to_bits() != value.to_bits() {
                return Err(Error::UnsupportedDomain {
                    stage: "sine",
                    value_bits: value.to_bits(),
                });
            }
            corrected(q, COORDINATE_LOW_RESIDUAL, index as usize)
        }
    } else {
        return Err(Error::UnsupportedDomain {
            stage: "sine",
            value_bits: value.to_bits(),
        });
    };
    Ok(ResolvedSine {
        value: result,
        q19: false,
    })
}
/// Captured scalar sine with an explicit domain. RequireGridNode keeps the
/// existing Q19-only ABI used by gradient dithering. Other modes accept only
/// the additional fully enumerated numeric domains; no approximate result is
/// returned. See math-metadata.json for the exact membership predicates.
pub fn sine(value: f32, mode: SineMode) -> Result<SineSample, Error> {
    let result = resolve_sine(value, mode)?;
    Ok(SineSample {
        value: result.value,
        interpolated: false,
    })
}
fn record(result: ResolvedSine, quality: &mut Quality) -> f32 {
    if result.q19 {
        quality.sine_grid_samples += 1;
    } else {
        quality.sine_residual_samples += 1;
    }
    result.value
}
fn recorded_sine(value: f32, quality: &mut Quality) -> Result<f32, Error> {
    Ok(record(
        resolve_sine(value, SineMode::RequireSupportedDomain)?,
        quality,
    ))
}
fn resolve_coordinate_sine(remainder: f32) -> Result<ResolvedSine, Error> {
    if !remainder.is_finite() {
        return Err(Error::InvalidInput("coordinate remainder"));
    }
    // The native compiler combines 2.71828*INV_TAU before multiplication.
    let q = quarter(remainder * f32::from_bits(0x3edd_8161))?;
    if let Some(result) = grid_sine(q) {
        return Ok(result);
    }
    let index = remainder * 4_194_304.0;
    if !(0.0..8_388_608.0).contains(&index) || index != index.floor() {
        return Err(Error::UnsupportedDomain {
            stage: "coordinate sine composition",
            value_bits: remainder.to_bits(),
        });
    }
    Ok(ResolvedSine {
        value: corrected(q, COORDINATE_COMPOSED_RESIDUAL, index as usize),
        q19: false,
    })
}
/// Captured composition sin(remainder*2.71828), including its combined range
/// reduction constant. It is observably different from rounding the argument
/// multiplication before calling the scalar sine function.
pub fn coordinate_sine(remainder: f32) -> Result<SineSample, Error> {
    Ok(SineSample {
        value: resolve_coordinate_sine(remainder)?.value,
        interpolated: false,
    })
}
/// Captured fast reciprocal square root on every positive binary32 value in
/// [2^-48,4). All mantissas and power-of-four scales in this domain were
/// independently enumerated. Zero is rejected; native normalization would
/// yield NaNs and must never be silently replaced by a zero vector.
pub fn reciprocal_sqrt(value: f32) -> Result<f32, Error> {
    if !value.is_finite() || value < 0.0 {
        return Err(Error::InvalidInput("reciprocal square root"));
    }
    if value == 0.0 {
        return Err(Error::ZeroGradient);
    }
    if !(1.0 / 281_474_976_710_656.0..4.0).contains(&value) {
        return Err(Error::UnsupportedDomain {
            stage: "reciprocal square root",
            value_bits: value.to_bits(),
        });
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 255) as i32 - 127;
    let scale = exponent.div_euclid(2);
    let normalized = (bits & 0x7f_ffff) | (((127 + exponent.rem_euclid(2)) as u32) << 23);
    let key = (normalized - (127 << 23)) as usize;
    let base = (1.0 / f64::from(f32::from_bits(normalized)).sqrt()) as f32;
    let code = (RSQRT_RESIDUAL[key / 4] >> (2 * (key % 4))) & 3;
    let corrected = i64::from(base.to_bits()) + i64::from(code) - 1;
    Ok(f32::from_bits(
        (corrected - (i64::from(scale) << 23)) as u32,
    ))
}

// Measured Metal dot ordering: first round x*ax, then fuse y*ay + x*ax.
fn dot(a: [f32; 2], b: [f32; 2]) -> f32 {
    a[1].mul_add(b[1], a[0] * b[0])
}
fn gradient_impl(
    point: [f32; 2],
    channel: usize,
    octave: usize,
    quality: &mut Quality,
) -> Result<[f32; 2], Error> {
    let plan = SEED_PLAN_BITS[channel][octave].map(f32::from_bits);
    let phase = checked(dot(point, [COORD_X, COORD_Y]), "coordinate dot")?;
    let cycles = (phase * INV_MODULUS).floor();
    let remainder = (-cycles).mul_add(MODULUS, phase);
    let wave = record(resolve_coordinate_sine(remainder)?, quality);
    let scramble = fraction(wave.mul_add(SCRAMBLE_SCALE, SCRAMBLE_OFFSET));
    let common = plan[0] * scramble;
    let mut raw = [0.0_f32; 2];
    for j in 0..2 {
        // The identity shader folds +312 into the FMA bias. A diagnostic
        // quantize branch inhibits that fold and measures a different graph.
        let weight = common.mul_add(WEIGHT_SCALE[j], WEIGHT_OFFSET[j] + 312.0);
        let coefficients = DIRECTIONS[j].map(|v| v * plan[j + 1]);
        let argument = (dot(point, coefficients) * 0.25) * 0.25;
        let wave = recorded_sine(argument, quality)?;
        let product = wave * weight;
        // Native fast arithmetic subtracts .5 before subtracting floor(product).
        raw[j] = 2.0 * ((product - 0.5) - product.floor());
    }
    let squared = checked(dot(raw, raw), "gradient norm")?;
    if squared <= 0.0 {
        return Err(Error::ZeroGradient);
    }
    let reciprocal_length = reciprocal_sqrt(squared)?;
    quality.normalizations += 1;
    Ok([
        checked(raw[0] * reciprocal_length, "gradient x")?,
        checked(raw[1] * reciprocal_length, "gradient y")?,
    ])
}
/// Numerical inspection entry point; it evaluates the same mathematical plan
/// used by `displacement`, without returning or accepting source colors.
pub fn gradient(point: [f32; 2], channel: usize, octave: usize) -> Result<Sample, Error> {
    if channel >= 2 || octave >= 3 || point.iter().any(|v| !v.is_finite() || v.fract() != 0.0) {
        return Err(Error::InvalidInput("gradient lattice/channel/octave"));
    }
    let mut quality = Quality::default();
    let offset = gradient_impl(point, channel, octave, &mut quality)?;
    Ok(Sample { offset, quality })
}
fn perlin(
    point: [f32; 2],
    channel: usize,
    octave: usize,
    quality: &mut Quality,
) -> Result<f32, Error> {
    let base = point.map(f32::floor);
    let x = point[0] - base[0];
    let y = point[1] - base[1];
    let ease_x = x * x * (3.0 - 2.0 * x);
    let ease_y = y * y * (3.0 - 2.0 * y);
    let mut values = [0.0_f32; 4];
    for (i, corner) in [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
        .iter()
        .enumerate()
    {
        let g = gradient_impl(
            [base[0] + corner[0], base[1] + corner[1]],
            channel,
            octave,
            quality,
        )?;
        values[i] = dot([x - corner[0], y - corner[1]], g);
    }
    let upper = (values[1] - values[0]).mul_add(ease_x, values[0]);
    let lower = (values[3] - values[2]).mul_add(ease_x, values[2]);
    checked(
        (lower - upper).mul_add(ease_y, upper),
        "cubic interpolation",
    )
}
/// Returns node-space displacement for a node-centered coordinate `q`.
/// `noise_size` is the authored X/Y size, not reciprocal frequency; `radius`
/// is the effective authored radius, not the legacy doubled texture amount.
/// Seed is fixed at 0. Callers apply the node's linear transform to the result.
/// Size is first reciprocated to binary32, then multiplied by q, as in the
/// shader uniform graph. Every successful numeric sample is in the verified
/// finite domain; external Figma acceptance remains independent.
pub fn displacement(q: [f32; 2], noise_size: [f32; 2], radius: f32) -> Result<Sample, Error> {
    if q.iter().any(|v| !v.is_finite())
        || noise_size.iter().any(|v| !v.is_finite() || *v <= 0.0)
        || !radius.is_finite()
        || radius < 0.0
    {
        return Err(Error::InvalidInput("coordinate/size/radius"));
    }
    // Preserve the authored-size API's neutral-radius behavior before taking
    // a reciprocal that can overflow for a tiny but positive authored size.
    if radius == 0.0 {
        return Ok(Sample {
            offset: [0.0; 2],
            quality: Quality::default(),
        });
    }
    let frequency = noise_size.map(|v| 1.0 / v);
    if frequency.iter().any(|v| !v.is_finite()) {
        // Keep the original authored-size API's stage-specific overflow error.
        checked(q[0] * frequency[0], "noise x")?;
        checked(q[1] * frequency[1], "noise y")?;
    }
    displacement_with_reciprocal(q, frequency, radius)
}

/// Returns displacement using the already-rounded reciprocal size uniform.
/// This avoids reversing and recomputing a caller's binary32 reciprocal.
/// Frequency must be finite and strictly positive, including at zero radius.
pub fn displacement_with_reciprocal(
    q: [f32; 2],
    frequency: [f32; 2],
    radius: f32,
) -> Result<Sample, Error> {
    if q.iter().any(|v| !v.is_finite())
        || frequency.iter().any(|v| !v.is_finite() || *v <= 0.0)
        || !radius.is_finite()
        || radius < 0.0
    {
        return Err(Error::InvalidInput("coordinate/frequency/radius"));
    }
    let mut quality = Quality::default();
    if radius == 0.0 {
        return Ok(Sample {
            offset: [0.0; 2],
            quality,
        });
    }
    let point = [
        checked(q[0] * frequency[0], "noise x")?,
        checked(q[1] * frequency[1], "noise y")?,
    ];
    let mut offset = [0.0_f32; 2];
    for (channel, value) in offset.iter_mut().enumerate() {
        let mut position = point;
        let mut amplitude = 1.0;
        let mut sum = 0.0;
        for octave in 0..3 {
            sum += perlin(position, channel, octave, &mut quality)? * amplitude;
            position = position.map(|v| v * 2.0);
            amplitude *= 0.5;
        }
        *value = checked(sum * radius, "displacement")?;
    }
    Ok(Sample { offset, quality })
}
