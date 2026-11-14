//! Native frame placement translated into the shared affine vocabulary.
use crate::boolean::Operation;
use crate::math::Transform;

// Sketch File Format BooleanOperation: 2 is Intersection, 3 is Difference.
pub(crate) fn boolean_operation(code: i64) -> Option<Operation> {
    match code {
        0 => Some(Operation::Union),
        1 => Some(Operation::Subtract),
        2 => Some(Operation::Intersect),
        3 => Some(Operation::Exclude),
        _ => None,
    }
}

/// Sketch rotates counter-clockwise around the local frame center; screen
/// coordinates point down. Flips share that center and follow rotation in
/// the parent axes, as in Sketch's exported SVG transform.
pub fn layer_transform(frame: [f64; 4], rotation: f64, flip: [bool; 2]) -> Transform {
    let [x, y, width, height] = frame;
    let (s, c) = (-rotation.to_radians()).sin_cos();
    let sx = if flip[0] { -1. } else { 1. };
    let sy = if flip[1] { -1. } else { 1. };
    let (a, b, cc, d) = (c * sx, s * sy, -s * sx, c * sy);
    Transform([
        a,
        b,
        cc,
        d,
        x + width / 2. - a * width / 2. - cc * height / 2.,
        y + height / 2. - b * width / 2. - d * height / 2.,
    ])
}

/// Recover the native centre-based frame from a rigid affine placement.
pub fn frame_placement(
    transform: Transform,
    width: f64,
    height: f64,
) -> Option<([f64; 4], f64, [bool; 2])> {
    let [a, b, c, d, x, y] = transform.0;
    let determinant = a * d - b * c;
    // FIG sources carry f32-authored matrices: a 45-degree rotation arrives
    // as 0.7071067690849304 with ~6e-8 orthonormality error, so the rigid
    // test must tolerate f32 precision instead of demanding exact f64
    // orthonormality. Genuine scale/shear stay far above this window.
    const EPSILON: f64 = 1e-6;
    if [a, b, c, d, x, y].iter().any(|value| !value.is_finite())
        || (a * a + b * b - 1.).abs() > EPSILON
        || (c * c + d * d - 1.).abs() > EPSILON
        || (a * c + b * d).abs() > EPSILON
        || (determinant.abs() - 1.).abs() > EPSILON
    {
        return None;
    }
    let flip = determinant < 0.;
    let sign = if flip { -1. } else { 1. };
    // Canonicalize a reflection to the horizontal axis. It flips a but not b.
    let rotation = -b.atan2(a * sign).to_degrees();
    Some((
        [
            x - width / 2. + a * width / 2. + c * height / 2.,
            y - height / 2. + b * width / 2. + d * height / 2.,
            width,
            height,
        ],
        rotation,
        [flip, false],
    ))
}
