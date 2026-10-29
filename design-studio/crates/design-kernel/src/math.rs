use serde::{Deserialize, Serialize};
use std::ops::{Add, Mul, Sub};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y
    }
    pub fn cross(self, b: Self) -> f64 {
        self.x * b.y - self.y * b.x
    }
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub fn lerp(self, b: Self, t: f64) -> Self {
        self + (b - self) * t
    }
    pub fn normal(self) -> Self {
        let l = self.length();
        if l < 1e-15 {
            Self::default()
        } else {
            Self::new(-self.y / l, self.x / l)
        }
    }
    pub fn finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}
impl Add for Point {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self::new(self.x + b.x, self.y + b.y)
    }
}
impl Sub for Point {
    type Output = Self;
    fn sub(self, b: Self) -> Self {
        Self::new(self.x - b.x, self.y - b.y)
    }
}
impl Mul<f64> for Point {
    type Output = Self;
    fn mul(self, k: f64) -> Self {
        Self::new(self.x * k, self.y * k)
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Transform(pub [f64; 6]);
impl Default for Transform {
    fn default() -> Self {
        Self([1., 0., 0., 1., 0., 0.])
    }
}
impl Transform {
    pub fn point(self, p: Point) -> Point {
        let m = self.0;
        Point::new(
            m[0] * p.x + m[2] * p.y + m[4],
            m[1] * p.x + m[3] * p.y + m[5],
        )
    }
    pub fn concat(self, b: Self) -> Self {
        let a = self.0;
        let b = b.0;
        Self([
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ])
    }
    pub fn inverse(self) -> Result<Self, String> {
        let m = self.0;
        let d = m[0] * m[3] - m[1] * m[2];
        if !d.is_finite() || d.abs() < 1e-12 {
            return Err("Singular transform".into());
        }
        Ok(Self([
            m[3] / d,
            -m[1] / d,
            -m[2] / d,
            m[0] / d,
            (m[2] * m[5] - m[3] * m[4]) / d,
            (m[1] * m[4] - m[0] * m[5]) / d,
        ]))
    }
    /// Recover a CPU device-to-local inverse after composition shrinks the
    /// determinant below the authored-transform threshold. `samples` encloses
    /// every point evaluated by the caller, including subpixel sample offsets.
    /// Authored validation and GPU callers retain `inverse` and its limits.
    #[inline]
    pub fn inverse_composed(self, samples: Rect) -> Result<Self, String> {
        let m = self.0;
        if m.iter().any(|v| !v.is_finite()) {
            return Err("Nonfinite composed transform".into());
        }
        // Keep established CPU coordinates and pixels bit-for-bit unchanged.
        if let Ok(inverse) = self.inverse() {
            return if inverse.0.iter().all(|v| v.is_finite()) {
                Ok(inverse)
            } else {
                Err("Composed inverse exceeds precision budget".into())
            };
        }
        self.inverse_composed_fallback(samples)
    }
    // Keep the unusual recovery arithmetic and its stack off ordinary paints.
    #[cold]
    fn inverse_composed_fallback(self, samples: Rect) -> Result<Self, String> {
        let m = self.0;
        let sx = m[0].abs().max(m[1].abs());
        let sy = m[2].abs().max(m[3].abs());
        if sx == 0. || sy == 0. {
            return Err("Singular transform".into());
        }
        // Independent column scales retain well-oriented anisotropy. A fixed
        // determinant cutoff after normalization would reject valid axes.
        let a = [[m[0], m[2]], [m[1], m[3]]];
        let n = [[m[0] / sx, m[2] / sy], [m[1] / sx, m[3] / sy]];
        let det = n[0][0] * n[1][1] - n[0][1] * n[1][0];
        if det == 0. || !det.is_finite() {
            return Err("Singular transform".into());
        }
        let normalized = [
            [n[1][1] / det, -n[0][1] / det],
            [-n[1][0] / det, n[0][0] / det],
        ];
        let b = [
            [normalized[0][0] / sx, normalized[0][1] / sx],
            [normalized[1][0] / sy, normalized[1][1] / sy],
        ];
        let t = [m[4], m[5]];
        let q = [
            -(b[0][0] * t[0] + b[0][1] * t[1]),
            -(b[1][0] * t[0] + b[1][1] * t[1]),
        ];
        let inverse = Self([b[0][0], b[1][0], b[0][1], b[1][1], q[0], q[1]]);
        let failure = || "Composed inverse exceeds precision budget".to_string();
        if normalized.iter().flatten().any(|v| !v.is_finite())
            || inverse.0.iter().any(|v| !v.is_finite())
        {
            return Err(failure());
        }
        let mut device_residual = [[0.; 2]; 2];
        for (left, right) in [(n, normalized), (normalized, n), (a, b)] {
            for i in 0..2 {
                for j in 0..2 {
                    let residual =
                        left[i][0] * right[0][j] + left[i][1] * right[1][j] - f64::from(i == j);
                    if !residual.is_finite() || residual.abs() > 64. * f64::EPSILON {
                        return Err(failure());
                    }
                    device_residual[i][j] = residual;
                }
            }
        }
        // Check both orders only in normalized coordinates: inverse*A in the
        // original local units can amplify harmless skinny-axis roundoff.
        let bound = [
            f64::from(samples.x),
            f64::from(samples.y),
            f64::from(samples.x) + f64::from(samples.w),
            f64::from(samples.y) + f64::from(samples.h),
        ]
        .into_iter()
        .map(f64::abs)
        .fold(0., f64::max);
        let local_bound = [
            bound * (b[0][0].abs() + b[0][1].abs()) + q[0].abs(),
            bound * (b[1][0].abs() + b[1][1].abs()) + q[1].abs(),
        ];
        if local_bound.iter().any(|v| !v.is_finite()) {
            return Err(failure());
        }
        for i in 0..2 {
            let extent =
                a[i][0].abs() * local_bound[0] + a[i][1].abs() * local_bound[1] + t[i].abs();
            let translation_residual = a[i][0] * q[0] + a[i][1] * q[1] + t[i];
            // Conservative arithmetic check on the stored composed matrix and
            // actual sampling rectangle, using the strictest fill tolerance.
            // This does not prove authored composition or color discontinuities.
            let error = bound * (device_residual[i][0].abs() + device_residual[i][1].abs())
                + translation_residual.abs()
                + 32. * f64::EPSILON * extent;
            if !extent.is_finite()
                || !translation_residual.is_finite()
                || !error.is_finite()
                || error >= 1. / 8192.
            {
                return Err(failure());
            }
        }
        Ok(inverse)
    }
    pub fn max_scale(self) -> f64 {
        let [a, b, c, d, _, _] = self.0;
        let s = a * a + b * b + c * c + d * d;
        let det = a * d - b * c;
        ((s + (s * s - 4. * det * det).max(0.).sqrt()) * 0.5).sqrt()
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}
impl Rect {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }
    pub fn right(self) -> i32 {
        self.checked_right().expect("Invalid rectangle right edge")
    }
    pub fn bottom(self) -> i32 {
        self.checked_bottom()
            .expect("Invalid rectangle bottom edge")
    }
    pub fn checked_right(self) -> Option<i32> {
        self.x.checked_add(i32::try_from(self.w).ok()?)
    }
    pub fn checked_bottom(self) -> Option<i32> {
        self.y.checked_add(i32::try_from(self.h).ok()?)
    }
    pub fn checked_intersect(self, b: Self) -> Option<Self> {
        let x = self.x.max(b.x);
        let y = self.y.max(b.y);
        Some(Self::new(
            x,
            y,
            u32::try_from(
                (i64::from(self.checked_right()?.min(b.checked_right()?)) - i64::from(x)).max(0),
            )
            .ok()?,
            u32::try_from(
                (i64::from(self.checked_bottom()?.min(b.checked_bottom()?)) - i64::from(y)).max(0),
            )
            .ok()?,
        ))
    }
    pub fn intersect(self, b: Self) -> Self {
        self.checked_intersect(b)
            .expect("Invalid rectangle intersection")
    }
    pub fn union(self, b: Self) -> Self {
        if self.empty() {
            return b;
        }
        if b.empty() {
            return self;
        }
        let x = self.x.min(b.x);
        let y = self.y.min(b.y);
        Self::new(
            x,
            y,
            (self.right().max(b.right()) - x) as u32,
            (self.bottom().max(b.bottom()) - y) as u32,
        )
    }
    pub fn expand(self, n: i32) -> Self {
        Self::new(
            self.x - n,
            self.y - n,
            (self.w as i32 + 2 * n).max(0) as u32,
            (self.h as i32 + 2 * n).max(0) as u32,
        )
    }
    pub fn empty(self) -> bool {
        self.w == 0 || self.h == 0
    }
    pub fn pixels(self) -> usize {
        self.w as usize * self.h as usize
    }
    pub fn index(self, x: i32, y: i32) -> Option<usize> {
        (x >= self.x && x < self.right() && y >= self.y && y < self.bottom())
            .then(|| (y - self.y) as usize * self.w as usize + (x - self.x) as usize)
    }
    pub fn from_points(ps: impl Iterator<Item = Point>) -> Self {
        let mut min = Point::new(f64::INFINITY, f64::INFINITY);
        let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in ps {
            min.x = min.x.min(p.x);
            min.y = min.y.min(p.y);
            max.x = max.x.max(p.x);
            max.y = max.y.max(p.y);
        }
        if !min.finite() || !max.finite() {
            return Self::default();
        }
        // Conservative finite device bounds avoid integer overflow before viewport clipping.
        let bound = 536_870_912.;
        min.x = min.x.clamp(-bound, bound);
        min.y = min.y.clamp(-bound, bound);
        max.x = max.x.clamp(-bound, bound);
        max.y = max.y.clamp(-bound, bound);
        let x = min.x.floor() as i32;
        let y = min.y.floor() as i32;
        Self::new(
            x,
            y,
            (max.x.ceil() as i32 - x).max(1) as u32,
            (max.y.ceil() as i32 - y).max(1) as u32,
        )
    }
}
