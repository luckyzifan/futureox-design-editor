use futureox_design_kernel::{
    blend::{Pixel, Surface},
    math::Rect,
};
use std::{hint::black_box, time::Instant};
fn main() {
    for constant in [true, false] {
        let mut input = Surface::new(Rect::new(0, 0, 32, 32)).unwrap();
        for (i, p) in input.pixels.iter_mut().enumerate() {
            *p = if constant {
                Pixel([4.12345, -0.2, 0.2357, 0.43123])
            } else {
                Pixel([
                    (i * 37 % 997) as f32 / 53.,
                    -(i as f32) / 777.,
                    (i * 11 % 977) as f32 / 111.,
                    0.7,
                ])
            };
        }
        for exact in [false, true] {
            let started = Instant::now();
            let mut sum = 0_f64;
            for repeat in 0..8 {
                for y in 0..128 {
                    for x in 0..128 {
                        let (x, y) = (
                            0.5 + (x as f64 + repeat as f64 / 8.) / 128. * 30.,
                            0.5 + y as f64 / 128. * 30.,
                        );
                        let p = if exact {
                            black_box(&input).sample_linear(x, y)
                        } else {
                            black_box(&input).sample(x, y)
                        };
                        sum += black_box(f64::from(p.0[0]));
                    }
                }
            }
            println!(
                "constant={constant} exact={exact} samples=131072 elapsed_ms={:.3} checksum={sum}",
                started.elapsed().as_secs_f64() * 1000.
            );
        }
    }
}
