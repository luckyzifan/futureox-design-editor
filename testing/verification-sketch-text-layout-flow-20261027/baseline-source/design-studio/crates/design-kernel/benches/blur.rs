use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects,
    math::Rect,
};
use std::{hint::black_box, time::Instant};
fn direct_convolution(source: &Surface, radius: f64) -> Surface {
    let mut src = source.try_clone().unwrap();
    src.quantize_rgba8();
    let integer = radius.fract() == 0. && radius <= 512.;
    for horizontal in [true, false] {
        let mut out = Surface::new(src.rect).unwrap();
        for y in src.rect.y..src.rect.bottom() {
            for x in src.rect.x..src.rect.right() {
                let mut total = [0_f64; 4];
                for i in -(radius.ceil() as i32)..=radius.ceil() as i32 {
                    let p = if horizontal {
                        src.at(x + i, y)
                    } else {
                        src.at(x, y + i)
                    };
                    for (c, value) in total.iter_mut().enumerate() {
                        if integer {
                            let d = i.unsigned_abs() as f64;
                            let numerator = if i == 0 {
                                6. * radius - 2.
                            } else if d < radius {
                                6. * (radius - d)
                            } else {
                                1.
                            };
                            *value += f64::from((p.0[c] * 255.).round_ties_even()) * numerator;
                        } else {
                            *value +=
                                f64::from(p.0[c]) * effects::tent_weight(radius, i.unsigned_abs());
                        }
                    }
                }
                out.pixels[src.rect.index(x, y).unwrap()] = Pixel(total.map(|v| {
                    let byte = if integer {
                        v / (6. * radius * radius)
                    } else {
                        v * 255.
                    };
                    (byte.clamp(0., 255.).round_ties_even() / 255.) as f32
                }));
            }
        }
        src = out;
    }
    src
}

fn main() {
    let mut source = Surface::new(Rect::new(-17, 29, 256, 256)).unwrap();
    for (i, p) in source.pixels.iter_mut().enumerate() {
        *p = Pixel::rgba(0.2, 0.4, 0.8, ((i * 17 % 251) as f32) / 250.);
    }
    for radius in [1., 4., 16., 64.] {
        for name in ["gaussian-box", "tent-direct", "tent-prefix"] {
            let mut times = Vec::new();
            for i in 0..9 {
                let start = Instant::now();
                black_box(match name {
                    "gaussian-box" => effects::blur(black_box(&source), radius / 2.).unwrap(),
                    "tent-direct" => direct_convolution(black_box(&source), radius),
                    _ => effects::tent_blur(black_box(&source), radius).unwrap(),
                });
                if i >= 2 {
                    times.push(start.elapsed().as_secs_f64() * 1000.);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "{{\"filter\":\"{name}\",\"radius\":{radius},\"p50Ms\":{},\"p95Ms\":{},\"width\":256,\"height\":256}}",
                times[3], times[6]
            );
        }
    }
}
