use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects::{portable_tent_blur_edge, tent_blur},
    math::Rect,
};
use std::{hint::black_box, time::Instant};
fn main() {
    let mut s = Surface::new(Rect::new(0, 0, 256, 256)).unwrap();
    for (i, p) in s.pixels.iter_mut().enumerate() {
        *p = Pixel::rgba(0.2, 0.4, 0.8, (i * 17 % 251) as f32 / 250.);
    }
    for radius in [8.375, 16.1, 64.25, 128.3, 511.125] {
        for portable in [false, true] {
            let mut times = vec![];
            for i in 0..7 {
                let start = Instant::now();
                black_box(if portable {
                    portable_tent_blur_edge(&s, radius, false).unwrap()
                } else {
                    tent_blur(&s, radius).unwrap()
                });
                if i > 0 {
                    times.push(start.elapsed().as_secs_f64() * 1000.);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "{}",
                serde_json::json!({"radius":radius,"portableQ24":portable,"medianMs":times[3],"p95Ms":times[5],"size":[256,256]})
            );
        }
    }
}
