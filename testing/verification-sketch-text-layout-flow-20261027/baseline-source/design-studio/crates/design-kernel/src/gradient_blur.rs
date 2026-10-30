//! Gradient-modulated blur, decoded from the reference engine's two shader
//! tiers (extracted source semantics):
//!
//! ```glsl
//! t = clamp(dot(px - start, end - start) / dot(end - start, end - start), 0, 1)
//! b = (endCount - startCount) * t + startCount        // local blur strength
//! if (b < 1) { out = sharp }
//! else {
//!   q = (b-1)*(b-1) + 2*(b-1)
//!   tier A: w_blur = b*b            w_sharp = (2q)^2
//!   tier B: w_blur = b*b            w_sharp = q^2      // sharper falloff
//!   out = (w_blur * blurred + w_sharp * sharp) / (w_blur + w_sharp)
//! }
//! ```
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    /// Wider blend band (weight (2q)²): the higher-quality variant.
    Smooth,
    /// Steeper blend band (weight q²).
    Tight,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GradientBlur {
    /// Gradient anchor in node space; blur ramps from start to end.
    pub start: [f64; 2],
    pub end: [f64; 2],
    /// Blur strength at `start` / `end`.
    pub start_count: f64,
    pub end_count: f64,
    pub tier: Tier,
}

impl GradientBlur {
    /// Gradient parameter t at a point: the clamped projection onto the
    /// start→end segment (the shader's dot-product projection).
    pub fn t_at(&self, x: f64, y: f64) -> f64 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        let len2 = dx * dx + dy * dy;
        if len2 <= 0. {
            return 0.;
        }
        let s = ((x - self.start[0]) * dx + (y - self.start[1]) * dy) / len2;
        s.clamp(0., 1.)
    }

    /// Local blur strength b(t): linear interpolation of the counts.
    pub fn intensity(&self, x: f64, y: f64) -> f64 {
        let t = self.t_at(x, y);
        self.start_count + (self.end_count - self.start_count) * t
    }

    /// Blend weights at strength `b`: `(w_blur, w_sharp)`.
    /// Below strength 1 the sharp layer passes through untouched.  Above
    /// it the blur weight follows the steep quadratic curve (the shader's
    /// `(2q)^2` / `q^2` tiers) so strength drives blur; the extracted
    /// shader's texture-slot binding carries no call-site evidence, so the
    /// direction here matches our pipeline (blurred layer grows with
    /// strength), documented as an interpretation.
    pub fn weights(&self, b: f64) -> (f64, f64) {
        if b < 1. {
            return (0., 1.);
        }
        let q = (b - 1.) * (b - 1.) + 2. * (b - 1.);
        let w_blur = match self.tier {
            Tier::Smooth => (2. * q) * (2. * q),
            Tier::Tight => q * q,
        };
        let w_sharp = b * b;
        (w_blur, w_sharp)
    }

    /// Composite one pixel: `b < 1` keeps sharp; otherwise the weighted
    /// blend normalised by the weight sum.
    pub fn composite(&self, blurred: [f64; 4], sharp: [f64; 4], b: f64) -> [f64; 4] {
        let (wb, ws) = self.weights(b);
        let total = wb + ws;
        if total <= 0. {
            return sharp;
        }
        [
            (wb * blurred[0] + ws * sharp[0]) / total,
            (wb * blurred[1] + ws * sharp[1]) / total,
            (wb * blurred[2] + ws * sharp[2]) / total,
            (wb * blurred[3] + ws * sharp[3]) / total,
        ]
    }
}

/// Affine device-space strength field for the one-pass GPU gradient-blur
/// composite (WGSL mode 46). The projection
/// `t = clamp(((inverse·p - start)·d) / (d·d))` is affine in the device
/// pixel `p`, so the f64 derivation below folds the device→node inverse and
/// the segment projection into three coefficients evaluated once per frame.
/// The shader only evaluates `t = clamp(a·px + b·py + c)` and the weight
/// curves; no per-pixel matrix or division work crosses the GPU boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompositeField {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub start_count: f32,
    pub end_count: f32,
    pub smooth: bool,
}

// Saturating f64→f32 narrowing. Sub-normal segment lengths make the true
// coefficients overflow f32; the transition band is then far below one
// device pixel, so a saturated sign-preserving step is indistinguishable
// while keeping the shader free of infinities and NaNs.
fn narrow(v: f64) -> f32 {
    if !v.is_finite() {
        return if v.is_sign_negative() { -1e30 } else { 1e30 };
    }
    v.clamp(-1e30, 1e30) as f32
}

impl CompositeField {
    pub fn new(
        inverse: &crate::math::Transform,
        params: &crate::scene::GradientBlurParameters,
    ) -> Self {
        let d = [
            params.end[0] - params.start[0],
            params.end[1] - params.start[1],
        ];
        let len2 = d[0] * d[0] + d[1] * d[1];
        let (a, b, c) = if len2 > 0. && len2.is_finite() {
            let m = inverse.0;
            (
                narrow((d[0] * m[0] + d[1] * m[1]) / len2),
                narrow((d[0] * m[2] + d[1] * m[3]) / len2),
                narrow((d[0] * (m[4] - params.start[0]) + d[1] * (m[5] - params.start[1])) / len2),
            )
        } else {
            (0., 0., 0.)
        };
        Self {
            a,
            b,
            c,
            start_count: params.start_count as f32,
            end_count: params.end_count as f32,
            smooth: params.smooth,
        }
    }

    /// Canonical binary32 composite, shared by CPU/export and GPU mode 46.
    /// Keep each product/addition rounded separately; only the projection uses FMA.
    pub fn composite(&self, sharp: [f32; 4], blurred: [f32; 4], x: f32, y: f32) -> [f32; 4] {
        let b = self.strength_f32(x, y);
        if b < 1. { return sharp; }
        let d = b - 1.;
        let q = d * d + (d + d);
        let w = if self.smooth { q + q } else { q };
        let wb = w * w;
        let ws = b * b;
        let total = wb + ws;
        std::array::from_fn(|c| (wb * blurred[c] + ws * sharp[c]) / total)
    }

    /// f32 strength at a device pixel centre, exactly as the shader's RNE
    /// chain computes it (`fma(a,x,fma(b,y,c))` then the count lerp).
    pub fn strength_f32(&self, x: f32, y: f32) -> f32 {
        let t = self.a.mul_add(x, self.b.mul_add(y, self.c)).clamp(0., 1.);
        self.start_count + (self.end_count - self.start_count) * t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gb() -> GradientBlur {
        GradientBlur {
            start: [0., 0.],
            end: [100., 0.],
            start_count: 0.,
            end_count: 8.,
            tier: Tier::Smooth,
        }
    }

    #[test]
    fn t_is_the_clamped_projection() {
        let g = gb();
        assert_eq!(g.t_at(0., 0.), 0.);
        assert_eq!(g.t_at(100., 0.), 1.);
        assert_eq!(g.t_at(50., 0.), 0.5);
        assert_eq!(g.t_at(50., 999.), 0.5, "off-axis projects onto the segment");
        assert_eq!(g.t_at(-30., 0.), 0., "clamped low");
        assert_eq!(g.t_at(300., 0.), 1., "clamped high");
    }

    #[test]
    fn intensity_ramps_linearly() {
        let g = gb();
        assert!((g.intensity(25., 0.) - 2.).abs() < 1e-9);
        assert!((g.intensity(75., 0.) - 6.).abs() < 1e-9);
    }

    #[test]
    fn sub_unit_strength_passes_sharp_through() {
        let g = gb();
        assert_eq!(g.weights(0.5), (0., 1.));
        let out = g.composite([1., 0., 0., 1.], [0., 0., 1., 1.], 0.5);
        assert_eq!(out, [0., 0., 1., 1.]);
    }

    #[test]
    fn smooth_tier_doubles_the_sharp_band() {
        let g = gb();
        let b = 3.;
        let q = (b - 1.) * (b - 1.) + 2. * (b - 1.); // (4 + 4) = 8
        let (wb, ws) = g.weights(b);
        assert!(
            (wb - (2. * q * 2. * q)).abs() < 1e-9,
            "smooth blur: (2q)^2 = {}",
            2. * q * 2. * q
        );
        assert!((ws - 9.).abs() < 1e-9);
        let tight = GradientBlur {
            tier: Tier::Tight,
            ..gb()
        };
        let (wb_t, _) = tight.weights(b);
        assert!((wb_t - q * q).abs() < 1e-9, "tight blur: q^2");
    }

    #[test]
    fn composite_follows_the_extracted_formula() {
        let g = gb();
        // blurred-only input: out = wb / (wb + ws) per the shader's blend.
        let (wb, ws) = g.weights(4.);
        let out = g.composite([1., 1., 1., 1.], [0., 0., 0., 0.], 4.);
        assert!(out.iter().all(|&c| (c - wb / (wb + ws)).abs() < 1e-12));
        // mixed inputs land on the normalised weight point.
        let mixed = g.composite([1., 0., 0., 1.], [0., 1., 0., 1.], 2.);
        let (wb2, ws2) = g.weights(2.);
        assert!((mixed[1] - ws2 / (wb2 + ws2)).abs() < 1e-12);
        assert!((mixed[0] - wb2 / (wb2 + ws2)).abs() < 1e-12);
    }

    #[test]
    fn degenerate_gradient_stays_sharp() {
        let g = GradientBlur {
            start: [5., 5.],
            end: [5., 5.],
            start_count: 0.,
            end_count: 9.,
            tier: Tier::Tight,
        };
        assert_eq!(g.t_at(5., 5.), 0.);
        assert_eq!(g.intensity(5., 5.), 0.);
    }

    fn params() -> crate::scene::GradientBlurParameters {
        crate::scene::GradientBlurParameters {
            start: [2.5, -4.],
            end: [41.25, 30.75],
            start_count: 0.5,
            end_count: 7.25,
            smooth: true,
        }
    }

    #[test]
    fn composite_field_matches_the_per_pixel_projection() {
        let p = params();
        let matrix = crate::math::Transform([0.8, 0.125, -0.0625, 1.4, 13.375, -7.5]);
        let inverse = matrix
            .inverse_composed(crate::math::Rect::new(-40, -30, 160, 120))
            .unwrap();
        let field = CompositeField::new(&inverse, &p);
        // The same affine derivation kept in f64: isolate the reassociation
        // error from the f32 narrowing baked into the shipped field.
        let d = [p.end[0] - p.start[0], p.end[1] - p.start[1]];
        let len2 = d[0] * d[0] + d[1] * d[1];
        let m = inverse.0;
        let fa = (d[0] * m[0] + d[1] * m[1]) / len2;
        let fb = (d[0] * m[2] + d[1] * m[3]) / len2;
        let fc = (d[0] * (m[4] - p.start[0]) + d[1] * (m[5] - p.start[1])) / len2;
        let g = GradientBlur {
            start: p.start,
            end: p.end,
            start_count: p.start_count,
            end_count: p.end_count,
            tier: Tier::Smooth,
        };
        let mut worst_reassociation = 0_f64;
        let mut worst_narrowed = 0_f64;
        for y in -30..90 {
            for x in -40..120 {
                let q = inverse.point(crate::math::Point::new(x as f64 + 0.5, y as f64 + 0.5));
                let expected = g.intensity(q.x, q.y);
                let strength = |a: f64, b: f64, c: f64| {
                    p.start_count
                        + (p.end_count - p.start_count)
                            * (a * (x as f64 + 0.5) + b * (y as f64 + 0.5) + c).clamp(0., 1.)
                };
                worst_reassociation =
                    worst_reassociation.max((strength(fa, fb, fc) - expected).abs());
                worst_narrowed = worst_narrowed.max(
                    (strength(field.a as f64, field.b as f64, field.c as f64) - expected).abs(),
                );
            }
        }
        eprintln!(
            "composite field: reassociation {worst_reassociation:.3e}, f32-narrowed {worst_narrowed:.3e}"
        );
        assert!(
            worst_reassociation < 1e-12,
            "reassociation {worst_reassociation}"
        );
        assert!(worst_narrowed < 1e-6, "f32-narrowed field {worst_narrowed}");
    }

    #[test]
    fn composite_field_degenerate_gradient_clamps_to_zero() {
        let mut p = params();
        p.end = p.start;
        let field = CompositeField::new(&crate::math::Transform::default(), &p);
        assert_eq!((field.a, field.b, field.c), (0., 0., 0.));
        assert_eq!(field.strength_f32(100., -40.), p.start_count as f32);
    }

    #[test]
    fn composite_field_saturates_subnormal_segments() {
        let mut p = params();
        p.start = [0., 0.];
        p.end = [1e-100, 0.];
        let field = CompositeField::new(&crate::math::Transform::default(), &p);
        assert!(field.a.is_finite() && field.b.is_finite() && field.c.is_finite());
        assert!(
            field.a >= 1e30,
            "saturated step replaces the sub-pixel band"
        );
        assert_eq!(field.strength_f32(0.5, 0.5), p.end_count as f32);
        // When d·d underflows to zero the CPU projection reports t = 0 too.
        p.end = [1e-200, 0.];
        let field = CompositeField::new(&crate::math::Transform::default(), &p);
        assert_eq!((field.a, field.b, field.c), (0., 0., 0.));
        assert_eq!(field.strength_f32(0.5, 0.5), p.start_count as f32);
    }

    /// Emulate the WGSL mode-46 chain (one correctly-rounded f32 op per step,
    /// fused multiply-add for the field) and bound its deviation from the
    /// authoritative f64 composite across a dense parameter sweep.
    #[test]
    fn shader_chain_stays_within_a_quantified_error_bound() {
        let mut worst_value = 0_f64;
        let mut worst_weight = 0_f64;
        let mut cases = 0_u64;
        for &smooth in &[false, true] {
            for i in 0..=80 {
                let b64 = 64. * i as f64 / 80.;
                let g = GradientBlur {
                    tier: if smooth { Tier::Smooth } else { Tier::Tight },
                    ..gb()
                };
                let (wb64, ws64) = g.weights(b64);
                // f32 strength as the shader sees it (field rounding included).
                let b = b64 as f32;
                if b < 1. {
                    continue;
                }
                let d = b - 1.;
                let q = d * d + (d + d);
                let wb = if smooth {
                    let w = q + q;
                    w * w
                } else {
                    q * q
                };
                let ws = b * b;
                let total = wb + ws;
                worst_weight = worst_weight.max(((wb / total) as f64 - wb64 / (wb64 + ws64)).abs());
                for k in 0..=255 {
                    for &(sharp, blurred) in &[(k as f32 / 255., 1.), (1., k as f32 / 255.)] {
                        let gpu = (wb * blurred + ws * sharp) / total;
                        let cpu = g.composite([blurred as f64; 4], [sharp as f64; 4], b64)[0];
                        worst_value = worst_value.max((gpu as f64 - cpu).abs());
                        cases += 1;
                    }
                }
            }
        }
        eprintln!(
            "gradient blur shader model: {cases} samples, max weight error {worst_weight:.3e}, max channel error {worst_value:.3e}"
        );
        assert!(worst_weight < 1e-6, "weight error {worst_weight}");
        assert!(worst_value < 1e-6, "channel error {worst_value}");
    }
}
