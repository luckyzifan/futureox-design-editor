//! Whether a rotation preview may be drawn from the object's own paint.
//! A framebuffer crop is not that paint: encoded alpha already mixed the
//! background in, and a viewport slice cannot supply pixels that rotate in
//! from outside the screen.

/// `#RRGGBB` is opaque. `#RRGGBBAA` is opaque only when the alpha byte is 255.
/// Any other spelling is not treated as an opaque screenshot source.
pub fn color_fully_opaque(color: &str, opacity: f64) -> bool {
    if !opacity.is_finite() || opacity < 1. - 1e-9 {
        return false;
    }
    let digits = match color.strip_prefix('#') {
        Some(rest) => rest,
        None => return false,
    };
    if digits.len() != 6 && digits.len() != 8 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    if digits.len() == 6 {
        return true;
    }
    match u32::from_str_radix(&digits[6..8], 16) {
        Ok(255) => true,
        _ => false,
    }
}

/// Y-down clockwise rotation around `center`, matching [`crate::figma_rotation`].
pub fn rotate_point(x: f64, y: f64, center: (f64, f64), degrees: f64) -> Option<(f64, f64)> {
    if ![x, y, center.0, center.1, degrees].iter().all(|v| v.is_finite()) {
        return None;
    }
    let (sin, cos) = degrees.to_radians().sin_cos();
    let dx = x - center.0;
    let dy = y - center.1;
    Some((cos * dx - sin * dy + center.0, sin * dx + cos * dy + center.1))
}

fn rect_contains(rect: (f64, f64, f64, f64), point: (f64, f64), eps: f64) -> bool {
    point.0 >= rect.0 - eps
        && point.1 >= rect.1 - eps
        && point.0 <= rect.0 + rect.2 + eps
        && point.1 <= rect.1 + rect.3 + eps
}

fn clip_edge(input: &[(f64, f64)], inside: impl Fn((f64, f64)) -> bool, intersect: impl Fn((f64, f64), (f64, f64)) -> (f64, f64)) -> Vec<(f64, f64)> {
    let mut output = Vec::new();
    if input.is_empty() {
        return output;
    }
    let mut previous = *input.last().unwrap();
    let mut previous_in = inside(previous);
    for &current in input {
        let current_in = inside(current);
        if current_in {
            if !previous_in {
                output.push(intersect(previous, current));
            }
            output.push(current);
        } else if previous_in {
            output.push(intersect(previous, current));
        }
        previous = current;
        previous_in = current_in;
    }
    output
}

fn intersect_x(a: (f64, f64), b: (f64, f64), x: f64) -> (f64, f64) {
    let t = if (b.0 - a.0).abs() < 1e-15 { 0. } else { (x - a.0) / (b.0 - a.0) };
    (x, a.1 + t * (b.1 - a.1))
}

fn intersect_y(a: (f64, f64), b: (f64, f64), y: f64) -> (f64, f64) {
    let t = if (b.1 - a.1).abs() < 1e-15 { 0. } else { (y - a.1) / (b.1 - a.1) };
    (a.0 + t * (b.0 - a.0), y)
}

/// `subject` clipped to an axis-aligned rectangle.
fn clip_rect(subject: &[(f64, f64)], rect: (f64, f64, f64, f64)) -> Vec<(f64, f64)> {
    let right = rect.0 + rect.2;
    let bottom = rect.1 + rect.3;
    let left = clip_edge(subject, |p| p.0 >= rect.0, |a, b| intersect_x(a, b, rect.0));
    let right_edge = clip_edge(&left, |p| p.0 <= right, |a, b| intersect_x(a, b, right));
    let top = clip_edge(&right_edge, |p| p.1 >= rect.1, |a, b| intersect_y(a, b, rect.1));
    clip_edge(&top, |p| p.1 <= bottom, |a, b| intersect_y(a, b, bottom))
}

/// Source pixels that land inside `viewport` after `degrees` around `center`
/// are exactly `source ∩ inverse(viewport)`. A screenshot crop supplies the
/// rotation only when it contains that whole set.
pub fn screenshot_rotation_supplies(
    source: (f64, f64, f64, f64),
    crop: (f64, f64, f64, f64),
    center: (f64, f64),
    degrees: f64,
    viewport: (f64, f64, f64, f64),
) -> bool {
    if source.2 <= 0. || source.3 <= 0. || crop.2 <= 0. || crop.3 <= 0. || viewport.2 <= 0. || viewport.3 <= 0. {
        return false;
    }
    let corners = [
        (viewport.0, viewport.1),
        (viewport.0 + viewport.2, viewport.1),
        (viewport.0 + viewport.2, viewport.1 + viewport.3),
        (viewport.0, viewport.1 + viewport.3),
    ];
    let mut preimage = Vec::with_capacity(4);
    for (x, y) in corners {
        match rotate_point(x, y, center, -degrees) {
            Some(point) => preimage.push(point),
            None => return false,
        }
    }
    let needed = clip_rect(&preimage, source);
    if needed.is_empty() {
        return true;
    }
    needed.iter().all(|point| rect_contains(crop, *point, 1e-6))
}

fn rect_corners(rect: (f64, f64, f64, f64)) -> [(f64, f64); 4] {
    [
        (rect.0, rect.1),
        (rect.0 + rect.2, rect.1),
        (rect.0 + rect.2, rect.1 + rect.3),
        (rect.0, rect.1 + rect.3),
    ]
}

fn edges_cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let cross = |p: (f64, f64), q: (f64, f64), r: (f64, f64)| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    let ab_c = cross(a, b, c);
    let ab_d = cross(a, b, d);
    let cd_a = cross(c, d, a);
    let cd_b = cross(c, d, b);
    ab_c * ab_d < 0. && cd_a * cd_b < 0.
}

fn rotated_hits_rect(source: (f64, f64, f64, f64), other: (f64, f64, f64, f64), center: (f64, f64), degrees: f64) -> bool {
    let mut quad = [(0., 0.); 4];
    for (index, (x, y)) in rect_corners(source).into_iter().enumerate() {
        match rotate_point(x, y, center, degrees) {
            Some(point) => quad[index] = point,
            None => return true,
        }
    }
    if quad.iter().any(|point| rect_contains(other, *point, 0.)) || rect_corners(other).iter().any(|point| {
        // Point in the rotated quad by the same winding as the source rectangle.
        let mut winding = 0i32;
        for index in 0..4 {
            let a = quad[index];
            let b = quad[(index + 1) % 4];
            if a.1 <= point.1 && b.1 > point.1 && (b.0 - a.0) * (point.1 - a.1) - (b.1 - a.1) * (point.0 - a.0) > 0. {
                winding += 1;
            } else if a.1 > point.1 && b.1 <= point.1 && (b.0 - a.0) * (point.1 - a.1) - (b.1 - a.1) * (point.0 - a.0) < 0. {
                winding -= 1;
            }
        }
        winding != 0
    }) {
        return true;
    }
    for index in 0..4 {
        let a = quad[index];
        let b = quad[(index + 1) % 4];
        let other_corners = rect_corners(other);
        for other_index in 0..4 {
            let c = other_corners[other_index];
            let d = other_corners[(other_index + 1) % 4];
            if edges_cross(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

/// A framebuffer crop may follow the pointer only when the paint is fully
/// opaque and the crop contains every source pixel that lands in the viewport.
/// Encoded alpha and a viewport slice both fail this.
pub fn rotation_screenshot_admitted(
    color: &str,
    opacity: f64,
    source: (f64, f64, f64, f64),
    crop: (f64, f64, f64, f64),
    center: (f64, f64),
    degrees: f64,
    viewport: (f64, f64, f64, f64),
) -> bool {
    color_fully_opaque(color, opacity) && screenshot_rotation_supplies(source, crop, center, degrees, viewport)
}

/// Draw the object's own paint. `image` means the pixels are the image
/// resource, not `color`. This is not permission to lift a framebuffer crop.
pub fn rotation_source_preview_allowed(
    color: &str,
    opacity: f64,
    image: bool,
    backdrop: bool,
    effects: bool,
    strokes: bool,
    source: (f64, f64, f64, f64),
    center: (f64, f64),
    degrees: f64,
    others: &[(f64, f64, f64, f64)],
) -> bool {
    let paint_opaque = if image {
        opacity.is_finite() && opacity >= 1. - 1e-9
    } else {
        color_fully_opaque(color, opacity)
    };
    if backdrop || effects || strokes || !paint_opaque {
        return false;
    }
    if source.2 <= 0. || source.3 <= 0. {
        return false;
    }
    !others.iter().any(|other| {
        other.2 > 0. && other.3 > 0.
            && (rotated_hits_rect(source, *other, center, 0.)
                || rotated_hits_rect(source, *other, center, degrees))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_footprint_cannot_erase_a_neighbor_when_rotation_moves_away() {
        assert!(!rotation_source_preview_allowed(
            "#ff0000", 1., false, false, false, false,
            (0., 0., 100., 10.), (50., 5.), 90., &[(0., 0., 10., 10.)],
        ));
    }

    #[test]
    fn eight_digit_color_stays_translucent_when_opacity_is_one() {
        assert!(!color_fully_opaque("#ff000080", 1.));
        assert!(color_fully_opaque("#ff0000", 1.));
        assert!(color_fully_opaque("#FF0000FF", 1.));
        assert!(!color_fully_opaque("#ff0000", 0.5));
        assert!(!rotation_source_preview_allowed("#ff000080", 1., false, false, false, false, (0., 0., 40., 20.), (20., 10.), 24., &[]));
        let source = (0., 0., 40., 20.);
        let viewport = (0., 0., 80., 40.);
        assert!(!rotation_screenshot_admitted("#ff000080", 1., source, source, (20., 10.), 24., viewport));
    }

    #[test]
    fn viewport_slice_cannot_supply_pixels_that_rotate_into_view() {
        let source = (-100., -100., 300., 300.);
        let viewport = (0., 0., 100., 100.);
        let center = (50., 50.);
        let degrees = 45_f64;
        let visible = (0., 0., 100., 100.);
        // Independent of screenshot_rotation_supplies: invert the same Y-down
        // clockwise rotation with a local matrix.
        let (sin, cos) = (-degrees).to_radians().sin_cos();
        let dx = 3. - center.0;
        let dy = 3. - center.1;
        let preimage = (cos * dx - sin * dy + center.0, sin * dx + cos * dy + center.1);
        assert!(preimage.0 >= source.0 && preimage.0 <= source.0 + source.2);
        assert!(preimage.1 >= source.1 && preimage.1 <= source.1 + source.3);
        assert!(preimage.0 < visible.0 || preimage.0 > visible.0 + visible.2 || preimage.1 < visible.1 || preimage.1 > visible.1 + visible.3);
        assert_eq!(rotate_point(3., 3., center, -degrees), Some(preimage));
        assert!(!screenshot_rotation_supplies(source, visible, center, degrees, viewport));
        assert!(!rotation_screenshot_admitted("#ff0000", 1., source, visible, center, degrees, viewport));
        // The object itself may still be redrawn from its full geometry.
        // That is not a cropped screenshot.
        assert!(rotation_source_preview_allowed("#ff0000", 1., false, false, false, false, source, center, degrees, &[]));
        assert!(rotation_source_preview_allowed("#ffffff", 1., true, false, false, false, source, center, degrees, &[]));
        assert!(!rotation_source_preview_allowed("#ffffff", 0.4, true, false, false, false, source, center, degrees, &[]));
        // A neighbor in front of the rotated footprint blocks the redraw.
        assert!(!rotation_source_preview_allowed("#ff0000", 1., false, false, false, false, source, center, degrees, &[(40., 40., 20., 20.)]));
    }
}
