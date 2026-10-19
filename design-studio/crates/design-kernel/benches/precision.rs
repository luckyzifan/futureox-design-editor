//! Bounded numerical-contract costs; time and byte counts, no speed claim.
use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects,
    math::{Rect, Transform},
};
use std::{hint::black_box, time::Instant};
fn main() {
    for (w, h) in [(64, 64), (256, 256)] {
        let mut source = Surface::new(Rect::new(-17, 29, w, h)).unwrap();
        for (i, p) in source.pixels.iter_mut().enumerate() {
            *p = Pixel([
                ((i * 37) % 997) as f32 / 97.,
                -(((i * 13) % 571) as f32) / 777.,
                0.2357,
                0.43123,
            ]);
        }
        for radius in [0.5, 4.25, 16.125, 32.125, 64.125] {
            for name in ["certified-gaussian", "exact-hdr-tent"] {
                let mut times = Vec::new();
                for run in 0..5 {
                    let start = Instant::now();
                    let out = if name == "certified-gaussian" {
                        effects::blur(black_box(&source), radius / 2.).unwrap()
                    } else {
                        effects::linear_tent_blur(black_box(&source), radius, false).unwrap()
                    };
                    black_box(out);
                    if run > 0 {
                        times.push(start.elapsed().as_secs_f64() * 1000.);
                    }
                }
                times.sort_by(f64::total_cmp);
                println!(
                    "{{\"operation\":\"{name}\",\"radius\":{radius},\"width\":{w},\"height\":{h},\"p50Ms\":{},\"maximumMs\":{}}}",
                    (times[1] + times[2]) / 2.,
                    times[3]
                );
            }
        }
        let transform = Transform([0.93, 0.37, -0.24, 1.11, 17.125, -23.375]);
        let start = Instant::now();
        let values = effects::texture_sampling_grid(source.rect, 3.7, transform).unwrap();
        println!(
            "{{\"operation\":\"texture-address-compile\",\"width\":{w},\"height\":{h},\"milliseconds\":{},\"uploadBytes\":{}}}",
            start.elapsed().as_secs_f64() * 1000.,
            values.len() * 4
        );
        black_box(values);
    }
}
