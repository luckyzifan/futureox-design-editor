//! Native frame placement translated into the shared affine vocabulary.
use crate::math::Transform;

/// Sketch rotates counter-clockwise around the local frame center; screen
/// coordinates point down. Flips share that center and precede rotation.
pub(crate) fn layer_transform(frame: [f64; 4], rotation: f64, flip: [bool; 2]) -> Transform {
    let [x, y, width, height] = frame;
    let (s, c) = (-rotation.to_radians()).sin_cos();
    let sx = if flip[0] { -1. } else { 1. };
    let sy = if flip[1] { -1. } else { 1. };
    let (a, b, cc, d) = (c * sx, s * sx, -s * sy, c * sy);
    Transform([
        a,
        b,
        cc,
        d,
        x + width / 2. - a * width / 2. - cc * height / 2.,
        y + height / 2. - b * width / 2. - d * height / 2.,
    ])
}
