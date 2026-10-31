//! Exact measured SDR texture-clipping weight on the finite RGBA8/Q4 domain.
//!
//! Native fast math combines the two authored powers into
//! `fast_exp2(RN32(RN32(fast_log2(a) + fast_log2(b)) * f32(0.2)))`.
//! Multiplying two correctly rounded fifth roots is only a portable baseline.
//! The signed-ULP residual is essential: omitting it is an approximation.
//!
//! Assets contain synthetic numeric-function data, never image pixels or node
//! identities. All ordered pairs match independent Metal readbacks bit-for-bit;
//! this does not establish external image parity or an arbitrary-alpha/HDR model.
//! See `clip-weight-metadata.json` for provenance, layout and full-domain proof.
#![forbid(unsafe_code)]

use std::fmt;

pub const ALPHA_COUNT: u32 = 4081;
pub const TRIANGLE_ENTRIES: usize = 8_329_321;
pub const RESIDUAL_BITS: u32 = 4;
pub const RESIDUAL_MIN: i32 = -5;
pub const RESIDUAL_MAX: i32 = 4;
pub const BASELINE_BYTES: usize = 16_324;
pub const RESIDUAL_BYTES: usize = 4_164_661;
pub const TOTAL_BYTES: usize = BASELINE_BYTES + RESIDUAL_BYTES;
pub const BASELINE_SHA256: &str =
    "aa47fd46ef32ca55daf7262f05da2183d93a370258584b3e27537eb0b07f92b9";
pub const RESIDUAL_SHA256: &str =
    "18f4d377a83f5b76ded6e5574cd9aebd754f4db81cebe0741f3315e7dc1c6527";

static ROOTS: &[u8; BASELINE_BYTES] = include_bytes!("clip-baseline-fifth-root.f32");
static RESIDUALS: &[u8; RESIDUAL_BYTES] = include_bytes!("clip-residual-4bit.bin");

/// Shared immutable little-endian f32 fifth-root values, indexed by Q4 alpha.
/// Backends may upload this numerical lookup without receiving painted colours.
pub fn baseline_root_bytes() -> &'static [u8] {
    ROOTS
}

/// Two offset residuals per byte, low nibble first. For indices a,b use
/// `hi*(hi+1)/2+lo`; add RESIDUAL_MIN to the decoded nibble before correcting
/// the baseline's positive float bit pattern. The final high nibble is unused.
pub fn residual_bytes() -> &'static [u8] {
    RESIDUALS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidAlpha,
    InvalidIndex,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidAlpha => "Texture clip alpha is not an exact RGBA8/Q4 sample",
            Self::InvalidIndex => "Texture clip Q4 index is outside 0..=4080",
        })
    }
}
impl std::error::Error for Error {}

/// Recover q only when alpha is bit-identical to RN32(q/4080). In particular,
/// negative zero, adjacent float neighbours and arbitrary finite alphas are
/// rejected rather than silently rounded into the measured finite domain.
pub fn alpha_index(alpha: f32) -> Result<u32, Error> {
    if !alpha.is_finite() || !(0. ..=1.).contains(&alpha) {
        return Err(Error::InvalidAlpha);
    }
    let q = (f64::from(alpha) * 4080.).round() as u32;
    if crate::figma_sampling::normalize_q4(q).to_bits() != alpha.to_bits() {
        return Err(Error::InvalidAlpha);
    }
    Ok(q)
}

fn root(q: u32) -> f32 {
    let i = q as usize * 4;
    f32::from_bits(u32::from_le_bytes([
        ROOTS[i],
        ROOTS[i + 1],
        ROOTS[i + 2],
        ROOTS[i + 3],
    ]))
}

/// Exact finite-domain weight. Both indices are validated even when one is zero.
pub fn evaluate_indices(a: u32, b: u32) -> Result<f32, Error> {
    if a >= ALPHA_COUNT || b >= ALPHA_COUNT {
        return Err(Error::InvalidIndex);
    }
    let low = a.min(b);
    let high = a.max(b);
    let index = (high * (high + 1) / 2 + low) as usize;
    let baseline = (root(a) * root(b)).to_bits();
    let code = (RESIDUALS[index / 2] >> ((index & 1) * 4)) & 15;
    // The immutable table's residual range and every reconstructed float are
    // verified over the full finite domain. No wrapping/saturating conversion
    // or transcendental implementation is part of this operation.
    let corrected = i64::from(baseline) + i64::from(code) + i64::from(RESIDUAL_MIN);
    Ok(f32::from_bits(corrected as u32))
}

/// Alpha zero yields zero only after the other input also passes strict Q4
/// validation; malformed inputs must not disappear behind an early return.
pub fn evaluate(original_alpha: f32, displaced_alpha: f32) -> Result<f32, Error> {
    let original = alpha_index(original_alpha)?;
    let displaced = alpha_index(displaced_alpha)?;
    evaluate_indices(original, displaced)
}
