//! Cost of the dense rotated-image coordinate grid versus one inverse sample.
//! This is the CPU work a large source bitmap repeats for every pose. It is
//! not a GPU, Electron, or Metal measurement.
use std::time::Instant;

use futureox_design_kernel::{
    math::{Rect, Transform},
    paint::image_sampling_grid_placed,
    scene::Paint,
};

fn stretch_paint() -> Paint {
    serde_json::from_value(serde_json::json!({"kind":"image","color":"#ffffff","fit":"stretch"})).unwrap()
}

fn rotation(degrees: f64, width: f64, height: f64) -> Transform {
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (cx, cy) = (width / 2., height / 2.);
    Transform([
        cos,
        sin,
        -sin,
        cos,
        cx - cos * cx + sin * cy,
        cy - sin * cx - cos * cy,
    ])
}

/// Shader stretch address from the f32 inverse already stored on a GPU node.
fn direct_stretch(inverse: [f64; 6], device: [f64; 2], node: [f64; 2], image: [f64; 2]) -> [f64; 2] {
    let inv = inverse.map(|value| value as f32);
    let q = [
        inv[0] * device[0] as f32 + inv[2] * device[1] as f32 + inv[4],
        inv[1] * device[0] as f32 + inv[3] * device[1] as f32 + inv[5],
    ];
    [
        f64::from(q[0] * image[0] as f32 / node[0] as f32 - 0.5),
        f64::from(q[1] * image[1] as f32 / node[1] as f32 - 0.5),
    ]
}

#[test]
fn large_rotated_grid_costs_more_than_the_inverse_the_display_reuses() {
    let paint = stretch_paint();
    let node = [960., 540.];
    let image = [1920u32, 1080];
    let matrix = rotation(24., node[0], node[1]);
    let inverse = matrix.inverse().unwrap().0;
    let rect = Rect::new(0, 0, 960, 540);
    let started = Instant::now();
    let grid = image_sampling_grid_placed(rect, matrix, node, image, &paint, None, 0, [0, 0]).unwrap();
    let grid_ms = started.elapsed().as_secs_f64() * 1000.;
    let direct_started = Instant::now();
    let mut max_delta = 0_f64;
    let mut compared = 0_u32;
    let inv = Transform(inverse);
    for y in (0..540).step_by(12) {
        for x in (0..960).step_by(12) {
            let device = [f64::from(x) + 0.5, f64::from(y) + 0.5];
            let local = inv.point(futureox_design_kernel::math::Point::new(device[0], device[1]));
            let linear = [local.x / node[0] * f64::from(image[0]), local.y / node[1] * f64::from(image[1])];
            // Outside the rotated quad the grid clamps. Those edges are not the interior sample.
            if linear[0] < 8. || linear[1] < 8. || linear[0] > f64::from(image[0]) - 8. || linear[1] > f64::from(image[1]) - 8. {
                continue;
            }
            let direct = direct_stretch(inverse, device, node, [f64::from(image[0]), f64::from(image[1])]);
            let cell = &grid[((y as usize) * 960 + x as usize) * 4..];
            if cell[0] < 0. { continue; }
            let exact = [f64::from(cell[0]) + f64::from(cell[2]), f64::from(cell[1]) + f64::from(cell[3])];
            max_delta = max_delta.max((direct[0] - exact[0]).abs()).max((direct[1] - exact[1]).abs());
            compared += 1;
        }
    }
    let direct_ms = direct_started.elapsed().as_secs_f64() * 1000.;
    eprintln!(
        "{}",
        serde_json::json!({
            "case": "large-rotated-source",
            "gridPixels": 960 * 540,
            "gridMs": grid_ms,
            "directMs": direct_ms,
            "compared": compared,
            "maxTexelDelta": max_delta,
        })
    );
    assert!(compared > 100, "interior samples missing");
    assert!(max_delta < 0.05, "f32 inverse drifted {max_delta} texels from the dense grid");
    assert!(grid_ms > direct_ms * 20., "grid {grid_ms:.3} ms vs direct {direct_ms:.3} ms");
}
