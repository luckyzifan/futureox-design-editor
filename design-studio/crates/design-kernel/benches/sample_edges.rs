use futureox_design_kernel::{
    math::{Point, Rect},
    path::Contour,
    raster::{Mask, RasterWorkspace, SampleMasks, try_rasterize_sample},
};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};
fn summary(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    let n = samples.len();
    serde_json::json!({"samples":n,"medianMs":(samples[(n-1)/2]+samples[n/2])/2.,"p95Ms":samples[(n*95).div_ceil(100)-1],"maxMs":samples[n-1],"percentile":"nearest-rank"})
}
fn separate(cs: &[Contour], r: Rect) -> [Mask; 4] {
    std::array::from_fn(|s| try_rasterize_sample(cs, r, false, Some(s)).unwrap())
}
fn tiny(path: &tiny_skia::Path, r: Rect) -> [tiny_skia::Mask; 4] {
    std::array::from_fn(|s| {
        let (sx, sy) = futureox_design_kernel::fidelity::SAMPLE_OFFSETS[s];
        let mut mask = tiny_skia::Mask::new(r.w, r.h).unwrap();
        mask.fill_path(
            path,
            tiny_skia::FillRule::Winding,
            false,
            tiny_skia::Transform::from_translate(
                0.5 - sx as f32 - r.x as f32,
                0.5 - sy as f32 - r.y as f32,
            ),
        );
        mask
    })
}
fn verify(
    packed: &SampleMasks,
    independent: &[Mask; 4],
    reference: &[tiny_skia::Mask; 4],
    r: Rect,
) -> (String, usize) {
    let mut sha = Sha256::new();
    let mut differences = 0;
    for s in 0..4 {
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                let value = packed.at(s, x, y);
                assert_eq!(value, independent[s].at(x, y));
                sha.update(value.to_bits().to_le_bytes());
                differences += usize::from(
                    (value == 1.)
                        != (reference[s].data()
                            [((y - r.y) as u32 * r.w + (x - r.x) as u32) as usize]
                            != 0),
                );
            }
        }
    }
    (format!("{:x}", sha.finalize()), differences)
}
fn main() {
    for (name, count) in [
        ("ellipse", 1000),
        ("ellipse", 10000),
        ("star", 1000),
        ("retraced", 256),
    ] {
        // Explicit f32-roundtrip input: identical flattened points for both libraries.
        let c = Contour {
            closed: true,
            points: (0..count)
                .map(|i| {
                    let a = i as f64 / count as f64 * std::f64::consts::TAU;
                    let scale = if name == "star" && i % 2 == 1 {
                        0.25
                    } else {
                        1.
                    };
                    let p = if name == "retraced" {
                        Point::new(256., if i % 2 == 0 { 32. } else { 992. })
                    } else {
                        Point::new(
                            256.125 + 200. * scale * a.cos(),
                            512.375 + 480. * scale * a.sin(),
                        )
                    };
                    Point::new(f64::from(p.x as f32), f64::from(p.y as f32))
                })
                .collect(),
        };
        let cs = [c];
        let r = Rect::from_points(cs[0].points.iter().copied())
            .expand(1)
            .intersect(Rect::new(0, 0, 512, 1024));
        let mut builder = tiny_skia::PathBuilder::new();
        builder.move_to(cs[0].points[0].x as f32, cs[0].points[0].y as f32);
        for p in &cs[0].points[1..] {
            builder.line_to(p.x as f32, p.y as f32);
        }
        builder.close();
        let path = builder.finish().unwrap();
        let mut workspace = RasterWorkspace::default();
        let mut times: [Vec<f64>; 3] = std::array::from_fn(|_| Vec::new());
        let packed = workspace.samples(&cs, r, false).unwrap();
        let (digest, differences) = verify(&packed, &separate(&cs, r), &tiny(&path, r), r);
        for i in 0..105 {
            let order = if i % 2 == 0 { [0, 1, 2] } else { [2, 1, 0] };
            for mode in order {
                let start = Instant::now();
                match mode {
                    0 => {
                        black_box(separate(&cs, r));
                    }
                    1 => {
                        black_box(workspace.samples(&cs, r, false).unwrap());
                    }
                    _ => {
                        black_box(tiny(&path, r));
                    }
                }
                if i >= 5 {
                    times[mode].push(start.elapsed().as_secs_f64() * 1000.);
                }
            }
        }
        let [a, b, c] = times;
        println!(
            "{}",
            serde_json::json!({"case":name,"edges":count,"rect":r,"fourIndependent":summary(a),"sharedCompact":summary(b),"tinySkia012FourBinaryPasses":summary(c),"legacyMaskBytes":r.pixels()*16,"compactMaskBytes":packed.storage_bytes(),"maskSha256":digest,"tinySkiaDifferentSamples":differences,"scope":"isolated CPU, identical flattened f32-representable input, four binary phases; conversion/hash excluded; tiny-skia uses fixed-point edges so mismatches prohibit an equivalent-quality speed claim"})
        );
    }
}
