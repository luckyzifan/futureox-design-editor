//! Nested 3D scenes for a parent frame.
//!
//! Figma's Keep nested layers 3D is `transform-style: preserve-3d`. The default
//! Turn into flat plane composites children in layer order. Perspective is the
//! parent camera: a smaller distance is a closer viewpoint. Positive Z points
//! toward the viewer. Fixed-order poses match CSS
//! `translateZ() rotateX() rotateY() rotateZ()` (rotations run first, then Z
//! moves along the parent axis). Depth is visible when the parent preserves 3D
//! or applies perspective; overlapping preserve-3D surfaces use that Z, and
//! equal Z keeps layer order.

use crate::{
    blend::{Pixel, Surface, over},
    color,
    math::{Point, Rect, Transform},
    scene::{Document, Node},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

fn yes() -> bool {
    true
}
fn is_true(value: &bool) -> bool {
    *value
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene3d {
    pub perspective: f64,
    pub preserve3d: bool,
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub visible: bool,
}

impl Scene3d {
    pub fn new(perspective: f64, preserve3d: bool) -> Self {
        Self {
            perspective,
            preserve3d,
            visible: true,
        }
    }

    /// `{ perspective: -1, preserve3d: false }` with the effect visible is the
    /// unconfigured scene and is stored as absence.
    pub fn canonical(self) -> Option<Self> {
        if self.perspective == -1. && !self.preserve3d && self.visible {
            None
        } else {
            Some(self)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Transform3d {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "FIXED_ORDER")]
    FixedOrder {
        #[serde(rename = "translateZ")]
        translate_z: f64,
        #[serde(rename = "rotateX")]
        rotate_x: f64,
        #[serde(rename = "rotateY")]
        rotate_y: f64,
        #[serde(rename = "rotateZ")]
        rotate_z: f64,
        #[serde(
            default = "yes",
            rename = "backfaceVisible",
            skip_serializing_if = "is_true"
        )]
        backface_visible: bool,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        visible: bool,
    },
}

impl Transform3d {
    pub fn fixed(translate_z: f64, rotate_x: f64, rotate_y: f64, rotate_z: f64) -> Self {
        Self::FixedOrder {
            translate_z,
            rotate_x,
            rotate_y,
            rotate_z,
            backface_visible: true,
            visible: true,
        }
    }

    pub fn with_backface(mut self, visible: bool) -> Self {
        if let Self::FixedOrder {
            backface_visible, ..
        } = &mut self
        {
            *backface_visible = visible;
        }
        self
    }

    pub fn hidden(mut self) -> Self {
        if let Self::FixedOrder { visible, .. } = &mut self {
            *visible = false;
        }
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum OriginUnit {
    #[serde(rename = "PERCENT")]
    Percent,
    #[serde(rename = "PIXELS")]
    Pixels,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginAxis {
    pub unit: OriginUnit,
    pub value: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformOrigin {
    pub x: OriginAxis,
    pub y: OriginAxis,
}

impl TransformOrigin {
    pub fn percent(x: f64, y: f64) -> Self {
        Self {
            x: OriginAxis {
                unit: OriginUnit::Percent,
                value: x,
            },
            y: OriginAxis {
                unit: OriginUnit::Percent,
                value: y,
            },
        }
    }
}

pub fn node_uses_schema24(node: &Node) -> bool {
    node.scene3d.is_some() || node.transform3d.is_some() || node.transform_origin.is_some()
}

pub fn validate_node(node: &Node) -> Result<(), String> {
    if let Some(scene) = &node.scene3d {
        if node.kind != "frame" {
            return Err("3D scenes belong on frames".into());
        }
        if !scene.perspective.is_finite() || scene.perspective.abs() > 1e7 {
            return Err("Invalid 3D perspective".into());
        }
    }
    if let Some(transform) = &node.transform3d {
        if let Transform3d::FixedOrder {
            translate_z,
            rotate_x,
            rotate_y,
            rotate_z,
            ..
        } = transform.as_ref()
            && [translate_z, rotate_x, rotate_y, rotate_z]
                .iter()
                .any(|value| !value.is_finite() || value.abs() > 1e7)
        {
            return Err("Invalid 3D transform".into());
        }
    }
    if let Some(origin) = &node.transform_origin {
        for axis in [origin.x, origin.y] {
            if !axis.value.is_finite() || axis.value.abs() > 1e7 {
                return Err("Invalid 3D origin".into());
            }
        }
    }
    Ok(())
}

pub fn preserves(node: &Node) -> bool {
    node.scene3d
        .as_deref()
        .is_some_and(|scene| scene.preserve3d)
}

#[derive(Clone, Copy)]
struct Persp {
    distance: f64,
    origin_x: f64,
    origin_y: f64,
}

fn active_perspective(node: &Node) -> Option<Persp> {
    let scene = node.scene3d.as_deref()?;
    if !scene.visible || scene.perspective < 0. {
        return None;
    }
    Some(Persp {
        distance: scene.perspective.max(1.),
        origin_x: node.width * 0.5,
        origin_y: node.height * 0.5,
    })
}

struct Pose {
    translate_z: f64,
    rotate_x: f64,
    rotate_y: f64,
    rotate_z: f64,
    backface_visible: bool,
}

fn fixed_pose(node: &Node) -> Option<Pose> {
    match node.transform3d.as_deref() {
        Some(Transform3d::FixedOrder {
            translate_z,
            rotate_x,
            rotate_y,
            rotate_z,
            backface_visible,
            visible: true,
        }) => Some(Pose {
            translate_z: *translate_z,
            rotate_x: *rotate_x,
            rotate_y: *rotate_y,
            rotate_z: *rotate_z,
            backface_visible: *backface_visible,
        }),
        _ => None,
    }
}

/// The container's own pose moves or turns its flattened plane.
pub fn spins(node: &Node) -> bool {
    let Some(pose) = fixed_pose(node) else {
        return false;
    };
    pose.rotate_x != 0.
        || pose.rotate_y != 0.
        || pose.rotate_z != 0.
        || (pose.translate_z != 0. && (preserves(node) || active_perspective(node).is_some()))
}

fn child_needs_scene(child: &Node, parent: &Node) -> bool {
    if preserves(child) {
        return true;
    }
    let Some(pose) = fixed_pose(child) else {
        return false;
    };
    if pose.rotate_x != 0. || pose.rotate_y != 0. || pose.rotate_z != 0. {
        return true;
    }
    pose.translate_z != 0. && (preserves(parent) || active_perspective(parent).is_some())
}

pub fn container_uses_scene(doc: &Document, node: &Node) -> bool {
    if node.render_children().is_empty() {
        return false;
    }
    if doc.mask_child(node).is_some() && !preserves(node) {
        return false;
    }
    if preserves(node) || spins(node) {
        return true;
    }
    node.render_children().iter().any(|id| {
        doc.nodes
            .get(id)
            .is_some_and(|child| child_needs_scene(child, node))
    })
}

pub struct SceneIndex {
    containers: HashSet<String>,
}

impl SceneIndex {
    pub fn contains(&self, id: &str) -> bool {
        self.containers.contains(id)
    }
}

pub fn index(doc: &Document) -> Option<SceneIndex> {
    if !doc.nodes.values().any(node_uses_schema24) {
        return None;
    }
    let containers = doc
        .nodes
        .values()
        .filter(|node| container_uses_scene(doc, node))
        .map(|node| node.id.clone())
        .collect::<HashSet<_>>();
    (!containers.is_empty()).then_some(SceneIndex { containers })
}

#[derive(Clone, Copy)]
pub(crate) struct V3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Copy)]
struct M4([[f64; 4]; 4]);

fn ident() -> M4 {
    M4([
        [1., 0., 0., 0.],
        [0., 1., 0., 0.],
        [0., 0., 1., 0.],
        [0., 0., 0., 1.],
    ])
}

fn mul(a: M4, b: M4) -> M4 {
    let mut out = [[0.; 4]; 4];
    for row in 0..4 {
        for col in 0..4 {
            out[row][col] = a.0[row][0] * b.0[0][col]
                + a.0[row][1] * b.0[1][col]
                + a.0[row][2] * b.0[2][col]
                + a.0[row][3] * b.0[3][col];
        }
    }
    M4(out)
}

fn apply(m: M4, p: V3) -> V3 {
    V3 {
        x: m.0[0][0] * p.x + m.0[0][1] * p.y + m.0[0][2] * p.z + m.0[0][3],
        y: m.0[1][0] * p.x + m.0[1][1] * p.y + m.0[1][2] * p.z + m.0[1][3],
        z: m.0[2][0] * p.x + m.0[2][1] * p.y + m.0[2][2] * p.z + m.0[2][3],
    }
}

fn normal_z(m: M4) -> f64 {
    m.0[2][2]
}

fn rot_x(deg: f64) -> M4 {
    let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
    M4([
        [1., 0., 0., 0.],
        [0., c, -s, 0.],
        [0., s, c, 0.],
        [0., 0., 0., 1.],
    ])
}
fn rot_y(deg: f64) -> M4 {
    let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
    M4([
        [c, 0., s, 0.],
        [0., 1., 0., 0.],
        [-s, 0., c, 0.],
        [0., 0., 0., 1.],
    ])
}
fn rot_z(deg: f64) -> M4 {
    let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
    M4([
        [c, -s, 0., 0.],
        [s, c, 0., 0.],
        [0., 0., 1., 0.],
        [0., 0., 0., 1.],
    ])
}
fn translate(x: f64, y: f64, z: f64) -> M4 {
    M4([
        [1., 0., 0., x],
        [0., 1., 0., y],
        [0., 0., 1., z],
        [0., 0., 0., 1.],
    ])
}

fn origin_xy(node: &Node) -> (f64, f64) {
    let axis = |axis: OriginAxis, extent: f64| match axis.unit {
        OriginUnit::Percent => extent * axis.value / 100.,
        OriginUnit::Pixels => axis.value,
    };
    match node.transform_origin.as_deref() {
        Some(origin) => (axis(origin.x, node.width), axis(origin.y, node.height)),
        None => (node.width * 0.5, node.height * 0.5),
    }
}

fn pose_matrix(node: &Node) -> M4 {
    let Some(pose) = fixed_pose(node) else {
        return ident();
    };
    let (ox, oy) = origin_xy(node);
    mul(
        translate(ox, oy, 0.),
        mul(
            translate(0., 0., pose.translate_z),
            mul(
                rot_x(pose.rotate_x),
                mul(
                    rot_y(pose.rotate_y),
                    mul(rot_z(pose.rotate_z), translate(-ox, -oy, 0.)),
                ),
            ),
        ),
    )
}

fn layout_matrix(transform: Transform) -> M4 {
    let m = transform.0;
    M4([
        [m[0], m[2], 0., m[4]],
        [m[1], m[3], 0., m[5]],
        [0., 0., 1., 0.],
        [0., 0., 0., 1.],
    ])
}

fn placement(node: &Node) -> M4 {
    mul(layout_matrix(node.transform), pose_matrix(node))
}

fn backface_hidden(node: &Node, matrix: M4) -> bool {
    let visible = fixed_pose(node).is_none_or(|pose| pose.backface_visible);
    normal_z(matrix) < -1e-5 && !visible
}

fn fill_pixel(doc: &Document, node: &Node) -> Option<Pixel> {
    if node.kind != "rectangle" && node.kind != "frame" {
        return None;
    }
    if node.corner_radius != 0.
        || node.radii.iter().any(|radius| *radius != 0.)
        || node.smoothing != 0.
    {
        return None;
    }
    if node
        .strokes
        .iter()
        .any(|stroke| stroke.visible && stroke.width > 0.)
        || node.effects.iter().any(|effect| effect.visible)
    {
        return None;
    }
    let mut acc = Pixel::default();
    for paint in node
        .fills
        .iter()
        .filter(|paint| paint.visible && paint.opacity > 0.)
    {
        if paint.kind != "solid" || paint.blend != "normal" {
            return None;
        }
        let src = color::pixel(doc.color_management, &paint.color, paint.opacity as f32).ok()?;
        acc = over(acc, src, "normal");
    }
    Some(acc)
}

pub(crate) struct DrawPlane {
    pub(crate) corners: [V3; 4],
    pub(crate) depth: [f64; 4],
    pub(crate) w: [f64; 4],
    pub(crate) color: Option<[f32; 4]>,
    pub(crate) capture: Option<String>,
}

pub(crate) enum DrawOp {
    Paint2d(String),
    Raster {
        planes: Vec<DrawPlane>,
        depth_test: bool,
    },
}

fn rect_corners(node: &Node) -> [(f64, f64); 4] {
    [
        (0., 0.),
        (node.width, 0.),
        (node.width, node.height),
        (0., node.height),
    ]
}

fn leaf(doc: &Document, node: &Node, matrix: M4) -> Option<DrawPlane> {
    if backface_hidden(node, matrix) || node.opacity <= 0. {
        return None;
    }
    let corners = rect_corners(node).map(|(x, y)| apply(matrix, V3 { x, y, z: 0. }));
    if corners
        .iter()
        .any(|corner| !corner.x.is_finite() || !corner.y.is_finite() || !corner.z.is_finite())
    {
        return None;
    }
    let (mut color, capture) = match fill_pixel(doc, node) {
        Some(pixel) if pixel.0[3] <= 0. => return None,
        Some(pixel) => (Some(pixel.0), None),
        None => (None, Some(node.id.clone())),
    };
    if let Some(channels) = color.as_mut()
        && node.opacity < 1.
    {
        *channels = Pixel(*channels).opacity(node.opacity as f32).0;
    }
    Some(DrawPlane {
        depth: corners.map(|corner| corner.z),
        corners,
        w: [1.; 4],
        color,
        capture,
    })
}

fn present(mut plane: DrawPlane, spin: Option<M4>, persp: Option<Persp>) -> Option<DrawPlane> {
    if let Some(spin) = spin {
        for corner in &mut plane.corners {
            *corner = apply(spin, *corner);
        }
        plane.depth = plane.corners.map(|corner| corner.z);
    }
    if let Some(persp) = persp {
        let mut projected = plane.corners;
        let mut w = [1.; 4];
        for i in 0..4 {
            let corner = plane.corners[i];
            let divisor = 1. - corner.z / persp.distance;
            if !(divisor > 1e-4) {
                return None;
            }
            projected[i] = V3 {
                x: persp.origin_x + (corner.x - persp.origin_x) / divisor,
                y: persp.origin_y + (corner.y - persp.origin_y) / divisor,
                z: 0.,
            };
            w[i] = divisor;
        }
        plane.corners = projected;
        plane.w = w;
    } else {
        plane.w = [1.; 4];
    }
    plane
        .corners
        .iter()
        .all(|corner| corner.x.is_finite() && corner.y.is_finite())
        .then_some(plane)
}

fn drop_onto_plane(plane: DrawPlane, persp: Option<Persp>) -> Option<DrawPlane> {
    let mut plane = present(plane, None, persp)?;
    for corner in &mut plane.corners {
        corner.z = 0.;
    }
    plane.depth = [0.; 4];
    plane.w = [1.; 4];
    Some(plane)
}

fn collect_3d(
    doc: &Document,
    id: &str,
    local_to_container: M4,
    out: &mut Vec<DrawPlane>,
    depth: u32,
) {
    if depth > 64 {
        return;
    }
    let Some(node) = doc.nodes.get(id) else {
        return;
    };
    if !node.visible || node.mask {
        return;
    }
    if preserves(node) && active_perspective(node).is_none() && !node.render_children().is_empty() {
        for child_id in node.render_children() {
            let Some(child) = doc.nodes.get(child_id) else {
                continue;
            };
            collect_3d(
                doc,
                child_id,
                mul(local_to_container, placement(child)),
                out,
                depth + 1,
            );
        }
        return;
    }
    if node.opacity <= 0. {
        return;
    }
    if !node.render_children().is_empty() {
        if backface_hidden(node, local_to_container) {
            return;
        }
        let mut local = Vec::new();
        flatten_children(doc, node, &mut local, depth + 1);
        for plane in local {
            let mut mapped = plane;
            for corner in &mut mapped.corners {
                *corner = apply(local_to_container, *corner);
            }
            mapped.depth = mapped.corners.map(|corner| corner.z);
            out.push(mapped);
        }
        return;
    }
    if let Some(plane) = leaf(doc, node, local_to_container) {
        out.push(plane);
    }
}

fn flatten_children(doc: &Document, node: &Node, out: &mut Vec<DrawPlane>, depth: u32) {
    if depth > 64 {
        return;
    }
    let persp = active_perspective(node);
    for child_id in node.render_children() {
        let Some(child) = doc.nodes.get(child_id) else {
            continue;
        };
        if child.mask || !child.visible {
            continue;
        }
        if preserves(child)
            && active_perspective(child).is_none()
            && !child.render_children().is_empty()
        {
            let mut planes = Vec::new();
            collect_3d(doc, child_id, placement(child), &mut planes, depth + 1);
            out.extend(
                planes
                    .into_iter()
                    .filter_map(|plane| drop_onto_plane(plane, persp)),
            );
        } else if !child.render_children().is_empty() {
            if child.opacity <= 0. {
                continue;
            }
            let mut sub = Vec::new();
            flatten_children(doc, child, &mut sub, depth + 1);
            for plane in sub {
                let mut mapped = plane;
                for corner in &mut mapped.corners {
                    *corner = apply(placement(child), *corner);
                }
                if let Some(flat) = drop_onto_plane(mapped, persp) {
                    out.push(flat);
                }
            }
        } else if let Some(plane) = leaf(doc, child, placement(child))
            && let Some(flat) = drop_onto_plane(plane, persp)
        {
            out.push(flat);
        }
    }
}

fn container_fill(doc: &Document, node: &Node) -> Option<DrawPlane> {
    let pixel = fill_pixel(doc, node)?;
    if pixel.0[3] <= 0. {
        return None;
    }
    let corners = rect_corners(node).map(|(x, y)| V3 { x, y, z: 0. });
    Some(DrawPlane {
        depth: [0.; 4],
        corners,
        w: [1.; 4],
        color: Some(pixel.0),
        capture: None,
    })
}

pub(crate) fn draw_ops(doc: &Document, id: &str) -> Vec<DrawOp> {
    let Some(container) = doc.nodes.get(id) else {
        return Vec::new();
    };
    if backface_hidden(container, pose_matrix(container)) {
        return Vec::new();
    }
    let persp = active_perspective(container);
    let spin = spins(container).then(|| pose_matrix(container));
    if preserves(container) {
        let base = spin.unwrap_or_else(ident);
        let mut planes = Vec::new();
        for child_id in container.render_children() {
            let Some(child) = doc.nodes.get(child_id) else {
                continue;
            };
            if child.mask {
                continue;
            }
            collect_3d(doc, child_id, mul(base, placement(child)), &mut planes, 0);
        }
        let planes = planes
            .into_iter()
            .filter_map(|plane| present(plane, None, persp))
            .collect();
        return vec![DrawOp::Raster {
            planes,
            depth_test: true,
        }];
    }
    let mut ops = Vec::new();
    if let Some(fill) = spin.and_then(|_| container_fill(doc, container))
        && let Some(plane) = present(fill, spin, persp)
    {
        ops.push(DrawOp::Raster {
            planes: vec![plane],
            depth_test: false,
        });
    }
    for child_id in container.render_children() {
        let Some(child) = doc.nodes.get(child_id) else {
            continue;
        };
        if child.mask {
            continue;
        }
        if !child.visible || (!child_needs_scene(child, container) && spin.is_none()) {
            ops.push(DrawOp::Paint2d(child_id.clone()));
            continue;
        }
        if preserves(child)
            && active_perspective(child).is_none()
            && !child.render_children().is_empty()
        {
            let mut planes = Vec::new();
            collect_3d(doc, child_id, placement(child), &mut planes, 0);
            let planes = planes
                .into_iter()
                .filter_map(|plane| present(plane, spin, persp))
                .collect();
            ops.push(DrawOp::Raster {
                planes,
                depth_test: true,
            });
            continue;
        }
        let mut planes = Vec::new();
        if child.render_children().is_empty() {
            if let Some(plane) = leaf(doc, child, placement(child))
                && let Some(plane) = present(plane, spin, persp)
            {
                planes.push(plane);
            }
        } else if child.opacity > 0. {
            let mut local = Vec::new();
            flatten_children(doc, child, &mut local, 0);
            for plane in local {
                let mut mapped = plane;
                for corner in &mut mapped.corners {
                    *corner = apply(placement(child), *corner);
                }
                mapped.depth = mapped.corners.map(|corner| corner.z);
                if let Some(plane) = present(mapped, spin, persp) {
                    planes.push(plane);
                }
            }
        }
        if planes.is_empty() {
            ops.push(DrawOp::Paint2d(child_id.clone()));
        } else {
            ops.push(DrawOp::Raster {
                planes,
                depth_test: false,
            });
        }
    }
    ops
}

pub(crate) fn is_raster(op: &DrawOp) -> bool {
    matches!(op, DrawOp::Raster { .. })
}

pub(crate) fn device_coverage(doc: &Document, id: &str, matrix: Transform) -> Rect {
    let mut rect = Rect::default();
    for op in draw_ops(doc, id) {
        let DrawOp::Raster { planes, .. } = op else {
            continue;
        };
        for plane in planes {
            for corner in plane.corners {
                let point = matrix.point(Point::new(corner.x, corner.y));
                if point.finite() {
                    rect = rect.union(Rect::from_points(std::iter::once(point)));
                }
            }
        }
    }
    if rect.empty() { rect } else { rect.expand(1) }
}

pub(crate) struct ScreenQuad {
    pub x: [f64; 4],
    pub y: [f64; 4],
    pub depth: [f64; 4],
    pub w: [f64; 4],
    pub u: [f64; 4],
    pub v: [f64; 4],
}

struct ScreenVertex {
    x: f64,
    y: f64,
    depth: f64,
    w: f64,
    u: f64,
    v: f64,
}

pub(crate) fn rasterize_quad(
    quad: &ScreenQuad,
    color: Pixel,
    sample: Option<&Surface>,
    pixels: &mut [Pixel],
    rect: Rect,
    depth: Option<&mut [f32]>,
    mask: &dyn Fn(i32, i32) -> f32,
) {
    let v = |i: usize| ScreenVertex {
        x: quad.x[i],
        y: quad.y[i],
        depth: quad.depth[i],
        w: quad.w[i],
        u: quad.u[i],
        v: quad.v[i],
    };
    let mut depth = depth;
    raster_triangle(
        v(0),
        v(1),
        v(2),
        color,
        sample,
        pixels,
        rect,
        depth.as_deref_mut(),
        mask,
    );
    raster_triangle(
        v(0),
        v(2),
        v(3),
        color,
        sample,
        pixels,
        rect,
        depth.as_deref_mut(),
        mask,
    );
}

fn raster_triangle(
    v0: ScreenVertex,
    v1: ScreenVertex,
    v2: ScreenVertex,
    color: Pixel,
    sample: Option<&Surface>,
    pixels: &mut [Pixel],
    rect: Rect,
    mut depth: Option<&mut [f32]>,
    mask: &dyn Fn(i32, i32) -> f32,
) {
    if [v0.w, v1.w, v2.w]
        .iter()
        .any(|w| !w.is_finite() || *w <= 1e-4)
    {
        return;
    }
    let area = (v1.x - v0.x) * (v2.y - v0.y) - (v2.x - v0.x) * (v1.y - v0.y);
    if !area.is_finite() || area.abs() < 1e-8 {
        return;
    }
    let min_x = [v0.x, v1.x, v2.x]
        .into_iter()
        .fold(f64::INFINITY, f64::min)
        .floor() as i32;
    let max_x = [v0.x, v1.x, v2.x]
        .into_iter()
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil() as i32;
    let min_y = [v0.y, v1.y, v2.y]
        .into_iter()
        .fold(f64::INFINITY, f64::min)
        .floor() as i32;
    let max_y = [v0.y, v1.y, v2.y]
        .into_iter()
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil() as i32;
    let (Some(right), Some(bottom)) = (rect.checked_right(), rect.checked_bottom()) else {
        return;
    };
    for y in min_y.max(rect.y)..max_y.min(bottom) {
        for x in min_x.max(rect.x)..max_x.min(right) {
            let px = x as f64 + 0.5;
            let py = y as f64 + 0.5;
            let w0 = ((v1.x - px) * (v2.y - py) - (v2.x - px) * (v1.y - py)) / area;
            let w1 = ((v2.x - px) * (v0.y - py) - (v0.x - px) * (v2.y - py)) / area;
            let w2 = 1. - w0 - w1;
            if w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6 {
                continue;
            }
            let inv = w0 / v0.w + w1 / v1.w + w2 / v2.w;
            if !(inv > 1e-8) {
                continue;
            }
            let depth_z =
                (w0 * v0.depth / v0.w + w1 * v1.depth / v1.w + w2 * v2.depth / v2.w) / inv;
            if !depth_z.is_finite() {
                continue;
            }
            let Some(index) = rect.index(x, y) else {
                continue;
            };
            if depth
                .as_deref()
                .is_some_and(|buffer| depth_z < f64::from(buffer[index]) - 1e-3)
            {
                continue;
            }
            let coverage = mask(x, y);
            if coverage <= 0. {
                continue;
            }
            let mut src = if let Some(surface) = sample {
                let u = (w0 * v0.u / v0.w + w1 * v1.u / v1.w + w2 * v2.u / v2.w) / inv;
                let v = (w0 * v0.v / v0.w + w1 * v1.v / v1.w + w2 * v2.v / v2.w) / inv;
                if !u.is_finite() || !v.is_finite() {
                    continue;
                }
                surface.at(u.floor() as i32, v.floor() as i32)
            } else {
                color
            };
            if coverage < 1. {
                src = src.opacity(coverage);
            }
            if src.0[3] <= 0. {
                continue;
            }
            if let Some(buffer) = depth.as_deref_mut() {
                buffer[index] = depth_z as f32;
            }
            pixels[index] = over(pixels[index], src, "normal");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 24,
            "id": "d",
            "name": "d",
            "pages": [{"id":"p","name":"p","children":["frame"],"background":"#ffffff"}],
            "nodes": {
                "frame": {"id":"frame","kind":"frame","width":300,"height":200,"children":["near","far"],"fills":[],
                    "scene3d": {"perspective":400,"preserve3d":true}},
                "near": {"id":"near","kind":"rectangle","width":80,"height":50,"transform":[1,0,0,1,110,80],
                    "fills":[{"kind":"solid","color":"#ff0000","opacity":1}],
                    "transform3d":{"type":"FIXED_ORDER","translateZ":60,"rotateX":0,"rotateY":0,"rotateZ":0}},
                "far": {"id":"far","kind":"rectangle","width":120,"height":80,"transform":[1,0,0,1,90,60],
                    "fills":[{"kind":"solid","color":"#0000ff","opacity":1}],
                    "transform3d":{"type":"FIXED_ORDER","translateZ":-80,"rotateX":0,"rotateY":0,"rotateZ":0}}
            }
        })).unwrap()
    }

    #[test]
    fn shared_perspective_scales_the_near_card_toward_the_camera() {
        let doc = frame();
        let DrawOp::Raster { planes, depth_test } = &draw_ops(&doc, "frame")[0] else {
            panic!("depth group")
        };
        assert!(*depth_test);
        let near = &planes[0];
        assert!(
            (near.corners[0].x - 102.941176).abs() < 1e-4,
            "{}",
            near.corners[0].x
        );
        assert!(
            (near.corners[0].y - 76.470588).abs() < 1e-4,
            "{}",
            near.corners[0].y
        );
        assert!((near.depth[0] - 60.).abs() < 1e-9);
        assert!(near.depth[0] > planes[1].depth[0]);
    }

    #[test]
    fn canonical_scene_is_absent_and_keep_3d_round_trips() {
        assert!(Scene3d::new(-1., false).canonical().is_none());
        let kept = Scene3d::new(400., true);
        let json = serde_json::to_value(&kept).unwrap();
        assert_eq!(json["preserve3d"], true);
        assert!(json.get("visible").is_none());
        let back = Transform3d::fixed(0., 0., 180., 0.).with_backface(false);
        let value = serde_json::to_value(&back).unwrap();
        assert_eq!(value["backfaceVisible"], false);
        assert_eq!(serde_json::from_value::<Transform3d>(value).unwrap(), back);
    }
}
