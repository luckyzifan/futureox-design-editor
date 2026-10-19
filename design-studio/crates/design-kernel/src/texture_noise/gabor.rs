//! Deterministic Gabor-kernel displacement field for GRAIN-class textures.
//! Port of the reverse-engineered reference generator (fidelity corpus
//! markers-2026-10-11/gabor-generator.py, parameters in grain-notes.md):
//! Hann-windowed kernels on a jittered half-size grid, uniform orientations,
//! carrier wavelength 2.2 noise sizes, output displacement std = radius/4.
//! Coordinates are normalized by the authored noise size, so the field scales
//! exactly with noise_size. The deterministic constants are a kernel-local
//! SplitMix64 hash; Figma's own generator constants remain unidentified, so
//! this reproduces the statistical fingerprint, not Figma's bytes.

// Kernel grid spacing, carrier wavelength and envelope widths, in noise sizes.
const SPACING: f64 = 0.5;
const CARRIER: f64 = 2.2;
const SIGMA_ALONG: f64 = 0.625;
const SIGMA_ACROSS: f64 = 0.5625;
/// Hann window radius in units of normalized envelope distance.
const SUPPORT: f64 = 3.0;
const AMPLITUDE_STD: f64 = 0.45;

/// In-expectation std of the raw dense sum. Independent mean-zero kernels on
/// a jittered grid make Campbell's shot-noise variance exact:
/// density · E[a²] · E[cos²] · ∫∫W², with ∫∫W² over the elliptical Hann
/// support equal to σ_along·σ_across·(9/2π)·(3π²/4 − 4).
fn field_std() -> f64 {
    let envelope = SIGMA_ALONG
        * SIGMA_ACROSS
        * (9. / (2. * std::f64::consts::PI))
        * (3. * std::f64::consts::PI * std::f64::consts::PI / 4. - 4.);
    (envelope / (SPACING * SPACING) * AMPLITUDE_STD * AMPLITUDE_STD * 0.5).sqrt()
}

fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

fn uniform(i: i64, j: i64, channel: u64, slot: u64) -> f64 {
    let h = mix(mix(i as u64)
        ^ mix(j as u64).rotate_left(21)
        ^ mix(channel).rotate_left(42)
        ^ mix(slot));
    ((h >> 11) as f64) * (1. / 9_007_199_254_740_992.)
}

/// Raw field in noise-size units; std is `field_std()` in expectation.
pub fn field(point: [f64; 2], channel: usize) -> f64 {
    let base = [
        (point[0] / SPACING).floor() as i64,
        (point[1] / SPACING).floor() as i64,
    ];
    // Envelope support plus the half-cell center jitter, in grid cells.
    let reach = ((SUPPORT * SIGMA_ALONG + SPACING) / SPACING).ceil() as i64;
    let mut sum = 0.;
    for di in -reach..=reach {
        for dj in -reach..=reach {
            let (i, j) = (base[0] + di, base[1] + dj);
            let c = [
                (i as f64 + uniform(i, j, channel as u64, 0)) * SPACING,
                (j as f64 + uniform(i, j, channel as u64, 1)) * SPACING,
            ];
            let d = [point[0] - c[0], point[1] - c[1]];
            let theta = uniform(i, j, channel as u64, 2) * std::f64::consts::PI;
            let (u1, u0) = theta.sin_cos();
            let along = d[0] * u0 + d[1] * u1;
            let across = d[1] * u0 - d[0] * u1;
            let rr = ((along / SIGMA_ALONG).powi(2) + (across / SIGMA_ACROSS).powi(2)).sqrt();
            if rr >= SUPPORT {
                continue;
            }
            let window = 0.5 * (1. + (std::f64::consts::PI * rr / SUPPORT).cos());
            let radius =
                (-2. * uniform(i, j, channel as u64, 3).max(f64::MIN_POSITIVE).ln()).sqrt();
            let amplitude = AMPLITUDE_STD
                * radius
                * (std::f64::consts::TAU * uniform(i, j, channel as u64, 4)).cos();
            let phase = std::f64::consts::TAU * uniform(i, j, channel as u64, 5);
            sum += amplitude * (std::f64::consts::TAU / CARRIER * along + phase).cos() * window;
        }
    }
    sum
}

/// GRAIN displacement in node units for the node-centered coordinate `q`.
/// Each output channel is an independent field; std per channel is radius/4.
pub fn displacement(q: [f64; 2], noise_size: [f64; 2], radius: f64) -> Result<[f64; 2], String> {
    if q.iter().any(|v| !v.is_finite())
        || noise_size.iter().any(|v| !v.is_finite() || *v <= 0.)
        || !radius.is_finite()
        || radius < 0.
    {
        return Err("Invalid Gabor noise coordinate/size/radius".into());
    }
    if radius == 0. {
        return Ok([0.; 2]);
    }
    let scale = radius / 4. / field_std();
    let p = [q[0] / noise_size[0], q[1] / noise_size[1]];
    let out = [field(p, 0) * scale, field(p, 1) * scale];
    if out.iter().any(|v| !v.is_finite()) {
        return Err("Nonfinite Gabor noise displacement".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(size: usize, noise_size: f64, radius: f64) -> Vec<f64> {
        let mut out = Vec::with_capacity(size * size);
        for y in 0..size {
            for x in 0..size {
                out.push(
                    displacement([x as f64 + 0.5, y as f64 + 0.5], [noise_size; 2], radius)
                        .unwrap()[0],
                );
            }
        }
        out
    }
    fn mean_std(v: &[f64]) -> (f64, f64) {
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len() as f64;
        (mean, var.sqrt())
    }
    /// Directional autocorrelation at an integer (dx, dy) lag, normalized.
    fn autocorrelation(v: &[f64], size: usize, dx: usize, dy: usize) -> f64 {
        let (mean, std) = mean_std(v);
        let mut sum = 0.;
        let mut count = 0;
        for y in 0..size - dy {
            for x in 0..size - dx {
                sum += (v[y * size + x] - mean) * (v[(y + dy) * size + x + dx] - mean);
                count += 1;
            }
        }
        sum / count as f64 / (std * std)
    }

    #[test]
    fn same_parameters_produce_identical_bits() {
        let a = displacement([13.25, -7.5], [8., 16.], 64.).unwrap();
        let b = displacement([13.25, -7.5], [8., 16.], 64.).unwrap();
        assert_eq!(a.map(f64::to_bits), b.map(f64::to_bits));
        assert_eq!(displacement([1., 2.], [8., 8.], 0.).unwrap(), [0.; 2]);
        assert!(displacement([0.; 2], [0., 8.], 1.).is_err());
        assert!(displacement([0.; 2], [8., 8.], -1.).is_err());
        assert!(displacement([f64::NAN, 0.], [8., 8.], 1.).is_err());
    }

    #[test]
    fn amplitude_law_and_noise_size_scaling_hold() {
        let (_, std64) = mean_std(&grid(128, 8., 64.));
        assert!((std64 / 16. - 1.).abs() < 0.15, "std {std64} vs radius/4");
        let p = [37.25, 11.5];
        let a = displacement(p, [8., 8.], 64.).unwrap();
        let b = displacement(p, [8., 8.], 32.).unwrap();
        assert!((a[0] / b[0] - 2.).abs() < 1e-12 && (a[1] / b[1] - 2.).abs() < 1e-12);
        // Doubling the noise size is exactly a coordinate rescale.
        let wide = displacement([p[0] * 2., p[1] * 2.], [16., 16.], 64.).unwrap();
        assert_eq!(a.map(f64::to_bits), wide.map(f64::to_bits));
    }

    #[test]
    fn spectrum_is_narrowband_at_the_carrier_wavelength() {
        let size = 128;
        let v = grid(size, 8., 64.);
        let (mean, _) = mean_std(&v);
        // Radial power of the 2D spectrum. The carrier at noise size 8 is a
        // ring of radius 128/17.6 ≈ 7.3 bins; a 1D row projection would
        // smear that ring down to DC and is not a valid narrowband check.
        let mut f: Vec<(f64, f64)> = v.iter().map(|x| (x - mean, 0.)).collect();
        fft2(&mut f, size);
        let mut radial = [0f64; 16];
        for y in 0..size {
            for x in 0..size {
                let fx = x.min(size - x) as f64;
                let fy = y.min(size - y) as f64;
                let r = (fx * fx + fy * fy).sqrt();
                let bin = r.round() as usize;
                if (1..16).contains(&bin) {
                    let (re, im) = f[y * size + x];
                    radial[bin] += re * re + im * im;
                }
            }
        }
        let total: f64 = radial[1..].iter().sum();
        let peak = (1..16)
            .max_by(|&a, &b| radial[a].total_cmp(&radial[b]))
            .unwrap();
        assert!((5..=9).contains(&peak), "peak ring {peak}, carrier ~7.3");
        let band: f64 = radial[4..=11].iter().sum();
        assert!(band / total > 0.6, "narrowband share {}", band / total);
        let low: f64 = radial[1..=2].iter().sum();
        assert!(low / total < 0.1, "low-frequency share {}", low / total);
    }

    fn fft2(f: &mut [(f64, f64)], size: usize) {
        let pass = |f: &mut [(f64, f64)], stride: usize, offset: usize| {
            let mut row: Vec<(f64, f64)> = (0..size).map(|i| f[offset + i * stride]).collect();
            fft(&mut row);
            for (i, v) in row.into_iter().enumerate() {
                f[offset + i * stride] = v;
            }
        };
        for y in 0..size {
            pass(f, 1, y * size);
        }
        for x in 0..size {
            pass(f, size, x);
        }
    }
    fn fft(v: &mut [(f64, f64)]) {
        let n = v.len();
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                v.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = -std::f64::consts::TAU / len as f64;
            for base in (0..n).step_by(len) {
                for k in 0..half {
                    let (s, c) = (step * k as f64).sin_cos();
                    let (ar, ai) = v[base + k];
                    let (br, bi) = v[base + k + half];
                    let (tr, ti) = (br * c - bi * s, br * s + bi * c);
                    v[base + k] = (ar + tr, ai + ti);
                    v[base + k + half] = (ar - tr, ai - ti);
                }
            }
            len *= 2;
        }
    }

    #[test]
    fn radial_autocorrelation_matches_the_gabor_fingerprint() {
        let size = 128;
        let v = grid(size, 8., 64.);
        // Fingerprint targets for noise size 8 (grain-notes.md / generator):
        // smooth core, first zero crossing near 0.8-1.0 sizes, shallow
        // negative lobe near 1.25 sizes, no long-range correlation.
        let lags: Vec<f64> = (0..=16).map(|l| autocorrelation(&v, size, l, 0)).collect();
        assert!(lags[1] > 0.85, "{}", lags[1]);
        assert!(lags[5] > 0.1, "{}", lags[5]);
        assert!(lags[6] > lags[7] && lags[7] > lags[8], "{lags:?}");
        let zero = (6..=10).find(|&l| lags[l] < 0.);
        assert!(zero.is_some(), "no zero crossing in 6..=10 px: {lags:?}");
        let lobe = lags[8..=13].iter().copied().fold(0_f64, f64::min);
        assert!((-0.35..-0.02).contains(&lobe), "negative lobe {lobe}");
        assert!(lags[16].abs() < 0.2, "long-range {}", lags[16]);
    }

    #[test]
    fn field_is_statistically_isotropic() {
        let size = 128;
        let v = grid(size, 8., 64.);
        for lag in [2, 4, 6, 8] {
            let x = autocorrelation(&v, size, lag, 0);
            let y = autocorrelation(&v, size, 0, lag);
            assert!((x - y).abs() < 0.08, "lag {lag}: x {x} vs y {y}");
        }
        // The two displacement channels are independent draws of one model.
        let a = grid(size, 8., 64.);
        let b: Vec<f64> = (0..size * size)
            .map(|i| {
                displacement(
                    [(i % size) as f64 + 0.5, (i / size) as f64 + 0.5],
                    [8., 8.],
                    64.,
                )
                .unwrap()[1]
            })
            .collect();
        assert!(a.iter().zip(&b).any(|(x, y)| x.to_bits() != y.to_bits()));
        let (_, sa) = mean_std(&a);
        let (_, sb) = mean_std(&b);
        assert!((sa / sb - 1.).abs() < 0.1, "{sa} vs {sb}");
    }
}
