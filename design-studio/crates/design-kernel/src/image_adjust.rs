//! Image paint adjustments (exposure/contrast/temperature/tint/highlights/
//! shadows/color), a line-by-line port of Figma's image-adjust math
//! (kept in sync by tests).
//!
//! Pipeline: `srgb→linear → highlight/shadow delta → Lab(temp,tint,contrast)
//! → exposure(+delta) → saturation → linear→srgb`, identical in the GLSL and
//! WGSL forms (`imageColorAdjustPaint`). The GLSL side runs `precision
//! highp`, so f32 here is the numeric contract (no precision-tier
//! tolerance).
//!
//! Adjustments operate on straight (unpremultiplied) RGB in [0,1]. SDR
//! documents store image texels as sRGB bytes, exactly the shader's texture
//! domain, so [`ImageAdjust::apply_srgb`] is Figma's pipeline verbatim.
//! Color-managed documents keep texels in the linear working space; there the
//! two gamma bookends cancel against the storage encoding, so
//! [`ImageAdjust::apply_linear`] runs the linear core on the stored values —
//! the same displayed-color result for the same source pixel.
use serde::{Deserialize, Serialize};

/// Rec. 709 luminance weights, GLSL `const vec3 a=vec3(0.2126,0.7152,0.0722)`.
const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

fn dot_luma(c: [f32; 3]) -> f32 {
    c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
}

/// GLSL `b` / WGSL `hb`: sRGB-encoded → gamma 2.2 "linear".
fn srgb_to_linear(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| v.powf(2.2))
}

/// GLSL `d` / WGSL `hf`: gamma 2.2 "linear" → sRGB encoding.
fn linear_to_srgb(c: [f32; 3]) -> [f32; 3] {
    c.map(|v| v.powf(1.0 / 2.2))
}

/// GLSL `e` / WGSL `hj`: soft-thresholded highlight/shadow exposure delta.
/// `h = luminance - threshold^2.2` in linear light; a bounded sigmoid
/// `0.75h/√(1+4h²)` ∈ (-0.375, 0.375) scales `highlights` above the
/// threshold and `-shadows·0.999` below it. The delta later feeds the
/// exposure stage as `globalExposure + delta`.
fn highlight_shadow_delta(c: [f32; 3], shadows: f32, highlights: f32, threshold: f32) -> f32 {
    let h = dot_luma(c) - threshold.powf(2.2);
    let scale = if h > 0.0 {
        highlights
    } else {
        -shadows * 0.999
    };
    0.75 * h / (1.0 + 4.0 * h * h).sqrt() * scale
}

/// GLSL `s` / WGSL `jl`: Perlin smootherstep with clamped edges.
fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// GLSL `i` / WGSL `ht`: exposure as an inverted Reinhard-like curve around
/// `k = 10^(2j) − 1`, preserving saturation through the luminance anchor `n`
/// (restored with a contrast-dependent factor `m`; negative exposure also
/// pre-scales by `1 + j/16`).
fn exposure_adjust(mut c: [f32; 3], j: f32) -> [f32; 3] {
    let k = 10_f32.powf(2.0 * j) - 1.0;
    const SATURATION_ANCHOR: f32 = 0.75;
    let mut m = 1.0 / (1.0 - SATURATION_ANCHOR) - 1.0;
    let mut n = dot_luma(c);
    let negative = j.min(0.0);
    m *= 1.0 + n * n * negative / (0.2 - negative);
    for channel in &mut c {
        *channel += (n - *channel) * SATURATION_ANCHOR;
    }
    if j < 0.0 {
        let scale = 1.0 + j / 16.0;
        for channel in &mut c {
            *channel *= scale;
        }
        n *= scale;
    }
    for channel in &mut c {
        *channel *= (k + 1.0) / (*channel * k + 1.0);
    }
    n *= (k + 1.0) / (n * k + 1.0);
    for channel in &mut c {
        *channel += (*channel - n) * m;
    }
    c.map(|v| v.clamp(0.0, 1.0))
}

/// GLSL `o` / WGSL `iv`: saturation (`globalColor`, clamped to [-1,1] by the
/// caller exactly like the shader). Negative desaturates towards luminance;
/// positive pushes away, capped by the headroom to the min/max channel
/// (factors `q`,`r`) and an absolute cap of 2.
fn saturation_adjust(mut c: [f32; 3], p: f32) -> [f32; 3] {
    let n = dot_luma(c);
    if p <= 0.0 {
        for channel in &mut c {
            *channel -= (n - *channel) * p;
        }
    } else {
        let q = n / (n - c[0].min(c[1]).min(c[2]) + 1e-6);
        let r = (1.0 - n) / (c[0].max(c[1]).max(c[2]) - n + 1e-6);
        // mix(1.0, min(q,r), p) expanded, then min(k, 2.0).
        let k = (1.0 + (q.min(r) - 1.0) * p).min(2.0);
        for channel in &mut c {
            *channel += (n - *channel) * (1.0 - k);
        }
    }
    c
}

/// GLSL `w` / WGSL `jr`: temperature/tint/contrast in CIE Lab (D65 white).
/// `a += 30·tint` (green↔magenta), `b += 30·temperature` (blue↔warm); the
/// L channel is remapped around `threshold·100` — negative contrast pulls
/// towards `(L-ac)·0.2+50`, positive pushes through a ±30 smootherstep S-curve.
/// Matrices are the standard sRGB↔XYZ set written out per channel (GLSL's
/// column-major `mat3(...)` constructor produces exactly these row forms).
#[allow(clippy::too_many_arguments)]
fn lab_adjust(
    mut c: [f32; 3],
    temperature: f32,
    tint: f32,
    contrast: f32,
    threshold: f32,
) -> [f32; 3] {
    // Linear RGB → XYZ (columns (0.4124564,0.2126729,0.0193339) … as row form).
    let mut xyz = [
        0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2],
        0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2],
        0.0193339 * c[0] + 0.1191920 * c[1] + 0.9503041 * c[2],
    ];
    xyz[0] /= 0.95047;
    xyz[2] /= 1.08883;
    // f(t) = t^(1/3) exactly as pow(x, 1.0f/3.0) → 0.33333334 in f32.
    let mut f = xyz.map(|v| v.powf(1.0 / 3.0));
    let mut lab = [
        116.0 * f[1] - 16.0,
        500.0 * (f[0] - f[1]),
        200.0 * (f[1] - f[2]),
    ];
    lab[1] += 30.0 * tint;
    lab[2] += 30.0 * temperature;
    let midpoint = threshold * 100.0;
    const HALF_WIDTH: f32 = 30.0;
    let dark_target = (lab[0] - midpoint) * 0.2 + 50.0;
    let bright_target = smootherstep(midpoint - HALF_WIDTH, midpoint + HALF_WIDTH, lab[0]) * 100.0;
    let amount = if contrast < 0.0 {
        contrast + 1.0
    } else {
        contrast
    };
    // mix(ae, af, ag) expanded.
    lab[0] = if contrast < 0.0 {
        dark_target + (lab[0] - dark_target) * amount
    } else {
        lab[0] + (bright_target - lab[0]) * amount
    };
    f[1] = (lab[0] + 16.0) / 116.0;
    f[0] = lab[1] / 500.0 + f[1];
    f[2] = f[1] - lab[2] / 200.0;
    let mut xyz = f.map(|v| v * v * v);
    xyz[0] *= 0.95047;
    xyz[2] *= 1.08883;
    // XYZ → linear RGB.
    c = [
        3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2],
        -0.9692660 * xyz[0] + 1.8760108 * xyz[1] + 0.0415560 * xyz[2],
        0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2],
    ];
    c.map(|v| v.clamp(0.0, 1.0))
}

/// The linear-light core shared by both storage domains: GLSL `ah` minus the
/// two gamma bookends.
fn apply_core(c: [f32; 3], adjust: &ImageAdjust) -> [f32; 3] {
    let delta = highlight_shadow_delta(
        c,
        adjust.shadows as f32,
        adjust.highlights as f32,
        adjust.highlight_shadow_threshold as f32,
    );
    let c = lab_adjust(
        c,
        adjust.temperature as f32,
        adjust.tint as f32,
        adjust.contrast as f32,
        adjust.highlight_shadow_threshold as f32,
    );
    let c = exposure_adjust(c, adjust.exposure as f32 + delta);
    let c = saturation_adjust(c, (adjust.color as f32).clamp(-1.0, 1.0));
    // The shader leaves `o`'s ≤1e-6 gamut-epsilon overshoot unclamped (the
    // framebuffer clips it); storage here clamps for the same effect.
    c.map(|v| v.clamp(0.0, 1.0))
}

/// Authored image adjustments on an image paint. Field names and order follow
/// the Figma uniform block
/// (`struct UniformBlock{… globalTint, globalColor, globalShadows,
/// globalHighlights, globalExposure, globalTemperature, globalContrast,
/// highlightShadowThreshold …}`); all sliders span [-1, 1].
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct ImageAdjust {
    /// `globalExposure`: `10^(2j)-1` Reinhard-like curve; negative also
    /// desaturates and pre-scales by `1+j/16`.
    #[serde(default)]
    pub exposure: f64,
    /// `globalContrast`: Lab L S-curve around the threshold.
    #[serde(default)]
    pub contrast: f64,
    /// `globalTemperature`: Lab b+ axis (warm/yellow positive).
    #[serde(default)]
    pub temperature: f64,
    /// `globalTint`: Lab a+ axis (magenta positive).
    #[serde(default)]
    pub tint: f64,
    /// `globalHighlights`: lifts pixels above the threshold.
    #[serde(default)]
    pub highlights: f64,
    /// `globalShadows`: lifts pixels below the threshold.
    #[serde(default)]
    pub shadows: f64,
    /// `globalColor`: saturation; the shader clamps it to [-1,1].
    #[serde(default)]
    pub color: f64,
    /// `highlightShadowThreshold`: mid-gray split (Lab L = value·100). The
    /// CPU-side default is not observable; 0.5 (L=50) is our documented
    /// assumption and the fixed UI value.
    #[serde(default = "mid_threshold")]
    pub highlight_shadow_threshold: f64,
    /// kiwi `PaintFilterMessage.detail` (ordinal 3). Present in the wire
    /// schema; the engine-side render uniform for it was not recovered, so
    /// the authored value is carried (and round-trips) without changing the
    /// seven-consumer pipeline above.
    #[serde(default)]
    pub detail: f64,
    /// kiwi `PaintFilterMessage.vignette` (ordinal 6). Carried verbatim;
    /// not consumed by the ported shader math yet.
    #[serde(default)]
    pub vignette: f64,
    /// kiwi `PaintFilterMessage.brightness` (ordinal 10). Carried verbatim;
    /// not consumed by the ported shader math yet.
    #[serde(default)]
    pub brightness: f64,
}

fn mid_threshold() -> f64 {
    0.5
}

impl ImageAdjust {
    pub const fn mid_threshold() -> f64 {
        0.5
    }
    /// All sliders at zero is a no-op for every threshold value, so old
    /// documents render unchanged whether or not a threshold round-tripped.
    /// The three carried-only fields (detail/vignette/brightness) join the
    /// identity check so a non-zero authored value is still preserved by the
    /// importer instead of collapsing to "no adjustment".
    pub fn is_identity(&self) -> bool {
        self.exposure == 0.0
            && self.contrast == 0.0
            && self.temperature == 0.0
            && self.tint == 0.0
            && self.highlights == 0.0
            && self.shadows == 0.0
            && self.color == 0.0
            && self.detail == 0.0
            && self.vignette == 0.0
            && self.brightness == 0.0
    }
    /// Sliders span [-1,1] (the shader itself clamps `globalColor` to that
    /// range; exposure's `10^(2j)` saturates beyond it); the threshold is a
    /// [0,1] luminance split.
    pub fn validate(&self) -> bool {
        [
            self.exposure,
            self.contrast,
            self.temperature,
            self.tint,
            self.highlights,
            self.shadows,
            self.color,
            self.detail,
            self.vignette,
            self.brightness,
        ]
        .iter()
        .all(|v| v.is_finite() && (-1.0..=1.0).contains(v))
            && self.highlight_shadow_threshold.is_finite()
            && (0.0..=1.0).contains(&self.highlight_shadow_threshold)
    }
    /// Full image-adjust `ah` pipeline for sRGB-encoded input (SDR byte texels):
    /// gamma 2.2 bookends around the linear core.
    pub fn apply_srgb(&self, rgb: [f32; 3]) -> [f32; 3] {
        if self.is_identity() {
            return rgb;
        }
        let c = rgb.map(|v| v.clamp(0.0, 1.0));
        linear_to_srgb(apply_core(srgb_to_linear(c), self))
    }
    /// Linear core only, for texels stored in the linear working space
    /// (color-managed documents). Input clamps to [0,1] like the shader's
    /// `clamp(sample.xyz, vec3(0), vec3(1))` boundary.
    pub fn apply_linear(&self, rgb: [f32; 3]) -> [f32; 3] {
        if self.is_identity() {
            return rgb;
        }
        let c = rgb.map(|v| v.clamp(0.0, 1.0));
        apply_core(c, self)
    }
}
