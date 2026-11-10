//! CPU timing of the mode-22 uniform-box tap loop for the 117 Image Gaussian
//! at device zoom 64. Analytic tiles use the heavier rational convolution, so
//! this byte loop is a lower bound on filter time per tap, not an
//! Electron/Metal settle time. Plane sizes are the regional plan for device
//! sigma 612.1517944335938 and a 514 output: radii [611, 612, 612].
use std::hint::black_box;
use std::time::Instant;

/// One scanline of the byte shader: for each pixel, sum `2 * radius + 1`
/// samples and divide. This is not a sliding prefix.
fn horizontal_lines(src: &[u8], dst: &mut [u8], width: usize, lines: usize, radius: usize) {
    let denom = (radius * 2 + 1) as u32;
    let half = denom / 2;
    for y in 0..lines {
        let row = y * width;
        for x in 0..width {
            let mut sum = 0u32;
            let left = x as isize - radius as isize;
            for tap in 0..=radius * 2 {
                let at = left + tap as isize;
                let sample = if at < 0 || at >= width as isize { 0 } else { src[row + at as usize] };
                sum += u32::from(sample);
            }
            dst[row + x] = ((sum + half) / denom) as u8;
        }
        black_box(dst[row]);
    }
}

fn vertical_lines(src: &[u8], dst: &mut [u8], width: usize, height: usize, columns: usize, radius: usize) {
    let denom = (radius * 2 + 1) as u32;
    let half = denom / 2;
    for x in 0..columns {
        for y in 0..height {
            let mut sum = 0u32;
            let top = y as isize - radius as isize;
            for tap in 0..=radius * 2 {
                let at = top + tap as isize;
                let sample = if at < 0 || at >= height as isize { 0 } else { src[at as usize * width + x] };
                sum += u32::from(sample);
            }
            dst[y * width + x] = ((sum + half) / denom) as u8;
        }
        black_box(dst[x]);
    }
}

fn time_ms(mut body: impl FnMut()) -> f64 {
    let started = Instant::now();
    body();
    started.elapsed().as_secs_f64() * 1000.
}

fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    samples[samples.len() / 2]
}

/// Manual CPU measurement. Not part of the functional suite and not a
/// Metal/Electron settle time. Run with:
/// `cargo test -p futureox-design-kernel --test column_gaussian_time --release -- --ignored --nocapture`
#[test]
#[ignore]
fn measure_117_column_box_passes() {
    // (width, height, radius, horizontal)
    let passes = [
        (2962usize, 4184usize, 611usize, true),
        (2962, 2962, 611, false),
        (1738, 2962, 612, true),
        (1738, 1738, 612, false),
        (514, 1738, 612, true),
        (514, 514, 612, false),
    ];
    let lines = 8usize;
    let mut src = vec![0u8; 2962 * 4184];
    for (i, value) in src.iter_mut().enumerate() {
        *value = (i % 251) as u8;
    }
    let mut dst = vec![0u8; src.len()];
    let mut per_line = [0f64; 6];
    let mut report = String::new();
    for (index, &(width, height, radius, horizontal)) in passes.iter().enumerate() {
        let mut samples = [0f64; 3];
        for sample in &mut samples {
            *sample = if horizontal {
                time_ms(|| horizontal_lines(&src, &mut dst, width, lines, radius))
            } else {
                time_ms(|| vertical_lines(&src, &mut dst, width, height, lines, radius))
            };
        }
        let med = median(&mut samples);
        per_line[index] = med / lines as f64;
        report.push_str(&format!(
            "pass{index} {} {width}x{height} r={radius} lines={lines} ms={samples:?} median={med:.3} per_line={:.4}\n",
            if horizontal { "H" } else { "V" },
            per_line[index]
        ));
    }
    // Float32x4 blit, the production analytic plane format.
    let overlap_rows = 4184usize - 512;
    let plane = vec![0u8; 2962 * 4184 * 16];
    let mut copied = vec![0u8; plane.len()];
    let mut copy_samples = [0f64; 3];
    for sample in &mut copy_samples {
        *sample = time_ms(|| {
            let bytes = overlap_rows * 2962 * 16;
            copied[..bytes].copy_from_slice(&plane[..bytes]);
            black_box(copied[bytes / 2]);
        });
    }
    let copy_median = median(&mut copy_samples);
    report.push_str(&format!(
        "float_copy overlap_rows={overlap_rows} bytes={} ms={copy_samples:?} median={copy_median:.3}\n",
        overlap_rows * 2962 * 16
    ));
    let full_lines = [4184.0, 2962.0, 2962.0, 1738.0, 1738.0, 514.0];
    let full: f64 = per_line.iter().zip(full_lines).map(|(ms, n)| ms * n).sum();
    // Pass 0 is the only reused plane. A neighbor `steps` tiles away
    // recomputes `steps * 512` fresh rows and blits the overlap.
    let row_ms = per_line[0];
    let mut extrapolate = |rows: usize, steps: &[usize]| {
        let mut candidate = full; // anchor tile
        for &step in steps {
            let fresh = (step * 512) as f64;
            let kept = full_lines[0] - fresh;
            candidate += fresh * row_ms + copy_median * (kept / overlap_rows as f64);
            candidate += full - full_lines[0] * row_ms;
        }
        let baseline = full * (steps.len() + 1) as f64;
        report.push_str(&format!(
            "column_rows={rows} steps={steps:?} baseline_ms={baseline:.1} candidate_ms={candidate:.1} ratio={:.4} save={:.2}%\n",
            candidate / baseline,
            (1. - candidate / baseline) * 100.
        ));
    };
    extrapolate(2, &[1]);
    extrapolate(3, &[1, 1]);
    extrapolate(4, &[1, 1, 2]);
    extrapolate(5, &[1, 1, 2, 2]);
    report.push_str(&format!("full_tile_ms={full:.1} pass0_share={:.4}\n", full_lines[0] * row_ms / full));
    eprintln!("{report}");
    assert!(full > 0.);
}
