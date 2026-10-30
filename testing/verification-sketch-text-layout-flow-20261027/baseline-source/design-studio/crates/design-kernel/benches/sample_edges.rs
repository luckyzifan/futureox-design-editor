use futureox_design_kernel::{
    math::{Point, Rect},
    path::Contour,
    raster::rasterize_msaa4,
};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};
fn main() {
    for count in [1000, 10000] {
        let c = Contour {
            closed: true,
            points: (0..count)
                .map(|i| {
                    let a = i as f64 / count as f64 * std::f64::consts::TAU;
                    Point::new(256.125 + 200. * a.cos(), 512.375 + 480. * a.sin())
                })
                .collect(),
        };
        let mut times = vec![];
        let mut digest = String::new();
        for i in 0..8 {
            let start = Instant::now();
            let mask = black_box(rasterize_msaa4(
                std::slice::from_ref(&c),
                Rect {
                    x: 0,
                    y: 0,
                    w: 512,
                    h: 1024,
                },
                false,
            ));
            if i > 0 {
                times.push(start.elapsed().as_secs_f64() * 1000.);
            }
            let mut sha = Sha256::new();
            for a in &mask.data {
                sha.update(a.to_bits().to_le_bytes());
            }
            digest = format!("{:x}", sha.finalize());
        }
        times.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"edges":count,"output":[512,1024],"medianMs":times[times.len()/2],"p95Ms":times[times.len()-1],"maskSha256":digest,"scope":"rotated four-sample CPU edge traversal; no scene compilation or PNG encoding"})
        );
    }
}
