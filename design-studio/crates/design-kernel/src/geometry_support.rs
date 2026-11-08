//! Conservative control hulls read directly from validated authored curves.
//! This is only an early rejection proof. It never produces drawable geometry,
//! changes a sample lattice, or replaces network/path validation at admission.
use crate::{math::{Point, Rect, Transform}, scene::Node, vector_geometry::Curve};

/// Network face extraction and path decoding can be expensive even for leaves
/// far outside the requested sampling guard. Every generated line/Bezier is
/// inside the hull of these original points, including unused network edges.
/// Unknown/generated geometry retains the ordinary path builder.
pub(crate) fn leaf_control_bounds(node: &Node, matrix: Transform) -> Option<Rect> {
    if !node.children.is_empty() || node.kind == "text" || node.vector_brush.is_some()
        || node.path_offset != 0. || node.derived_path.is_some() {
        return None;
    }
    // Store only a local axis-aligned hull, never materialize the path. IEEE
    // multiplication/addition are monotonic in each finite input coordinate;
    // evaluating its four corners with the exact current matrix encloses the
    // same operations on every original control point, including shear.
    let mut hull: Option<[f64;4]> = None;
    let mut add = |p: Point| {
        if let Some(b) = &mut hull {
            b[0] = b[0].min(p.x); b[1] = b[1].min(p.y);
            b[2] = b[2].max(p.x); b[3] = b[3].max(p.y);
        } else { hull = Some([p.x,p.y,p.x,p.y]); }
    };
    if let Some(bounds) = primitive_device_box(node, matrix) {
        return Some(bounds);
    }
    if let Some(network) = &node.network {
        for vertex in &network.vertices { add(vertex.point()); }
        for edge in &network.edges {
            if let Some(p) = edge.c1 {add(p)}
            if let Some(p) = edge.c2 {add(p)}
        }
    } else if let Some(geometry) = &node.vector_geometry {
        for curve in geometry.fill.iter().chain(geometry.stroke.iter().flatten()) {
            let coordinates: &[f64] = match curve {
                Curve::Move(p) | Curve::Line(p) => p,
                Curve::Quad(p) => p,
                Curve::Cubic(p) => p,
                Curve::Close => continue,
            };
            for p in coordinates.chunks_exact(2) {add(Point::new(p[0],p[1]));}
        }
    } else { return None; }
    let Some([x0,y0,x1,y1]) = hull else { return Some(Rect::default()); };
    let points=[Point::new(x0,y0),Point::new(x1,y0),Point::new(x0,y1),Point::new(x1,y1)];
    if points.iter().any(|p| !p.finite()) {return None;}
    let points=points.map(|p|matrix.point(p));
    // Rect's saturation is an allocation guard, not a support certificate.
    // Decline before saturation/non-finite conversion can shrink this hull.
    if points.iter().any(|p|!p.finite()||p.x.abs()>536_870_910.||p.y.abs()>536_870_910.){return None;}
    Some(Rect::from_points(points.into_iter()))
}

/// Device hull of a primitive whose controls lie in its local width/height box.
/// Rounded corners, ellipses, and lines stay inside that box. Stars, text,
/// networks, and offset paths do not use this proof.
pub(crate) fn primitive_device_box(node: &Node, matrix: Transform) -> Option<Rect> {
    if node.vector_brush.is_some()
        || node.path_offset != 0.
        || node.derived_path.is_some()
        || node.network.is_some()
        || node.vector_geometry.is_some()
        || node.arc.is_some()
    {
        return None;
    }
    if !matches!(node.kind.as_str(), "slice" | "frame" | "section" | "rectangle" | "ellipse" | "line") {
        return None;
    }
    let (w, h) = (node.width, node.height);
    if !w.is_finite() || !h.is_finite() || w < 0. || h < 0. {
        return None;
    }
    let points = [
        Point::new(0., 0.),
        Point::new(w, 0.),
        Point::new(0., h),
        Point::new(w, h),
    ]
    .map(|p| matrix.point(p));
    if points.iter().any(|p| !p.finite() || p.x.abs() > 536_870_910. || p.y.abs() > 536_870_910.) {
        return None;
    }
    Some(Rect::from_points(points.into_iter()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn hull_encloses_decoded_controls_for_rotations_shears_and_fractional_origins() {
        let node:Node=serde_json::from_value(json!({"id":"n","kind":"vector","width":10,"height":10,
            "vectorGeometry":{"fillRule":"nonzero","fill":[{"move":[-2.,1.]},{"cubic":[-10.,3.,28.,-14.,11.,8.]},{"line":[4.,17.]},"close"]}})).unwrap();
        let (fill,stroke)=node.paths().unwrap();
        for angle in [-2.1_f64,-0.2,0.,0.8,2.4] { for scale in [0.001,0.125,1.,64.,128.] {
            let m=Transform([angle.cos()*scale,angle.sin()*scale,(angle.sin()+0.3)*scale,angle.cos()*scale,100.25,-64.375]);
            let bound=leaf_control_bounds(&node,m).unwrap();
            let original=fill.control_bounds(m).union(stroke.control_bounds(m));
            assert_eq!(bound.intersect(original),original);
        }}
    }
    #[test]
    fn unknown_geometry_does_not_gain_a_rejection_proof() {
        let mut n:Node=serde_json::from_value(json!({"id":"n","kind":"text","width":10,"height":10,"text":"overflow"})).unwrap();
        assert!(leaf_control_bounds(&n,Transform::default()).is_none());
        n.kind="vector".into();n.path_offset=3.;assert!(leaf_control_bounds(&n,Transform::default()).is_none());
        n.path_offset=0.;n.children.push("child".into());assert!(leaf_control_bounds(&n,Transform::default()).is_none());
    }
}
