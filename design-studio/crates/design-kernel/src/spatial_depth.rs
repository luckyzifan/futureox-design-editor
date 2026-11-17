//! Resolve opaque faces in a shared 3D space before their ordinary paint
//! passes. Depth is affine in screen x/y after the homogeneous divide when
//! expressed as reciprocal distance. That makes an intersection a half-plane.
use crate::{
    boolean::{Operation, boolean_with_rules},
    math::{Point, Transform},
    path::Contour,
    scene::{Document, Node},
    spatial::{Camera, Pose, Projection, outline_geometry, sin_cos},
    spatial_curve::{PAGE_TOLERANCE, project_contours},
};
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
struct Affine3([[f64; 4]; 3]);

impl Affine3 {
    fn embed(transform: Transform) -> Self {
        let [a, b, c, d, x, y] = transform.0;
        Self([[a, c, 0., x], [b, d, 0., y], [0., 0., 1., 0.]])
    }

    fn offset(x: f64, y: f64, z: f64) -> Self {
        Self([[1., 0., 0., x], [0., 1., 0., y], [0., 0., 1., z]])
    }

    fn pose(node: &Node, pose: Option<Pose>) -> Self {
        let Some(pose) = pose else { return Self::offset(0., 0., 0.) };
        let (sx, cx) = sin_cos(pose.rotate_x);
        let (sy, cy) = sin_cos(pose.rotate_y);
        let (sz, cz) = sin_cos(pose.rotate_z);
        let x = node.width * pose.origin[0];
        let y = node.height * pose.origin[1];
        Self::offset(x, y, pose.depth)
            .concat(Self([[1., 0., 0., 0.], [0., cx, -sx, 0.], [0., sx, cx, 0.]]))
            .concat(Self([[cy, 0., sy, 0.], [0., 1., 0., 0.], [-sy, 0., cy, 0.]]))
            .concat(Self([[cz, -sz, 0., 0.], [sz, cz, 0., 0.], [0., 0., 1., 0.]]))
            .concat(Self::offset(-x, -y, 0.))
    }

    fn concat(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|row| std::array::from_fn(|col| {
            let a = self.0[row];
            a[0] * rhs.0[0][col] + a[1] * rhs.0[1][col] + a[2] * rhs.0[2][col]
                + if col == 3 { a[3] } else { 0. }
        })))
    }

    fn flatten(mut self) -> Self {
        for row in &mut self.0 { row[2] = 0.; }
        self
    }

    fn point(self, p: Point) -> [f64; 3] {
        self.0.map(|row| row[0] * p.x + row[1] * p.y + row[3])
    }
}

#[derive(Clone, Copy)]
struct PlaneDepth([f64; 3]);

impl PlaneDepth {
    fn at(self, p: Point) -> f64 { self.0[0] * p.x + self.0[1] * p.y + self.0[2] }

    fn difference(self, other: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] - other.0[i]))
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[derive(Clone, Copy)]
struct Lens {
    camera: Camera,
    inverse: Transform,
}

impl Lens {
    fn cross_plane_coordinates(self, point: [f64; 3]) -> Result<(Point, f64), String> {
        let [x, y, z] = point;
        let scene = self.camera.parent_to_scene.point(Point::new(x, y));
        let w = 1. - z / self.camera.distance;
        if !w.is_finite() || w < 1. / 32. {
            return Err("The layer crosses the perspective camera's near plane".into());
        }
        let center = self.camera.center;
        let result = self.inverse.point(center + (scene - center) * (1. / w));
        if !result.finite() || result.x.abs().max(result.y.abs()) > 1e7 {
            return Err("Perspective output exceeds the scene coordinate budget".into());
        }
        Ok((result, w))
    }
}

fn depth_plane(
    node: &Node,
    world: Affine3,
    lens: Option<Lens>,
    project: impl Fn(Point) -> Result<(Point, f64), String>,
) -> Result<PlaneDepth, String> {
    let corners = [Point::default(), Point::new(node.width, 0.), Point::new(0., node.height)];
    let [[x, y, z], a, b] = corners.map(|corner| world.point(corner));
    if lens.is_none() {
        let inverse = Transform([
            (a[0] - x) / node.width, (a[1] - y) / node.width,
            (b[0] - x) / node.height, (b[1] - y) / node.height, x, y,
        ]).inverse()?.0;
        let dx = (a[2] - z) / node.width;
        let dy = (b[2] - z) / node.height;
        return Ok(PlaneDepth([dx * inverse[0] + dy * inverse[1], dx * inverse[2] + dy * inverse[3],
            z + dx * inverse[4] + dy * inverse[5]]));
    }
    let homogeneous = |corner| -> Result<[f64; 3], String> {
        let (point, w) = project(corner)?;
        Ok([point.x * w, point.y * w, w])
    };
    let [c, a, b] = [homogeneous(corners[0])?, homogeneous(corners[1])?, homogeneous(corners[2])?];
    let u = std::array::from_fn(|i| (a[i] - c[i]) / node.width);
    let v = std::array::from_fn(|i| (b[i] - c[i]) / node.height);
    // Last row of H⁻¹. Applying it to [screen x, screen y, 1] gives 1/w.
    let plane = cross(u, v);
    let norm = dot(plane, c);
    if !norm.is_finite() || norm.abs() <= 1e-15 { return Err("Invalid projected depth plane".into()); }
    Ok(PlaneDepth(plane.map(|v| v / norm)))
}

#[derive(Clone, Copy)]
struct Box2 { min: Point, max: Point }

impl Box2 {
    fn of(contours: &[Contour]) -> Option<Self> {
        let mut points = contours.iter().flat_map(|contour| contour.points.iter().copied());
        let first = points.next()?;
        Some(points.fold(Self { min: first, max: first }, |bounds, p| Self {
            min: Point::new(bounds.min.x.min(p.x), bounds.min.y.min(p.y)),
            max: Point::new(bounds.max.x.max(p.x), bounds.max.y.max(p.y)),
        }))
    }

    fn overlaps(self, other: Self) -> bool {
        self.min.x < other.max.x && self.max.x > other.min.x && self.min.y < other.max.y && self.max.y > other.min.y
    }

    fn corners(self) -> [Point; 4] {
        [self.min, Point::new(self.max.x, self.min.y), self.max, Point::new(self.min.x, self.max.y)]
    }
}

struct Face<'a> {
    node: &'a Node,
    scene_to_local: Transform,
    outline: Vec<Contour>,
    bounds: Box2,
    depth: PlaneDepth,
}

fn bounded_boolean(
    inputs: &[Vec<Contour>], operation: Operation, rules: &[bool], remaining: &mut usize,
) -> Result<Vec<Contour>, String> {
    let edges = inputs.iter().flatten().map(|c| c.points.len()).sum::<usize>();
    // The shared arrangement engine bounds one operation. A 3D scene also
    // has to bound the sum across all of its overlapping faces.
    let possible_pairs = edges.saturating_mul(edges.saturating_sub(1)) / 2;
    *remaining = remaining.checked_sub(possible_pairs).ok_or("Shared 3D intersection budget exceeded")?;
    boolean_with_rules(inputs, operation, rules)
}

fn above(face: &Face<'_>, other: &Face<'_>, remaining: &mut usize) -> Result<Vec<Contour>, String> {
    if !face.bounds.overlaps(other.bounds) { return Ok(Vec::new()); }
    let delta = face.depth.difference(other.depth);
    let corners = face.bounds.corners();
    // Ties keep authored painter order.
    let values = corners.map(|p| delta.at(p) - 1e-12);
    if values.iter().all(|v| *v <= 0.) { return Ok(Vec::new()); }
    if values.iter().all(|v| *v > 0.) { return Ok(face.outline.clone()); }
    let mut points = Vec::new();
    for i in 0..4 {
        let j = (i + 1) % 4;
        if values[i] > 0. { points.push(corners[i]); }
        if (values[i] > 0.) != (values[j] > 0.) {
            points.push(corners[i].lerp(corners[j], values[i] / (values[i] - values[j])));
        }
    }
    let clip = Contour { points, closed: true };
    bounded_boolean(&[face.outline.clone(), vec![clip]], Operation::Intersect,
        &[face.node.fill_even_odd(), true], remaining)
}

fn accepts_flat_style(node: &Node) -> bool {
    node.opacity == 1. && matches!(node.blend.as_str(), "normal" | "pass-through")
        && !node.mask && node.mask_chain.is_none() && node.repeat.is_none()
        && node.boolean_operation.is_none() && node.vector_brush.is_none() && node.path_offset == 0.
        && node.bindings.is_empty() && node.style_refs.is_empty() && node.instance.is_none()
        && !node.strokes.iter().any(|stroke| stroke.visible && stroke.paint.visible && stroke.width > 0.)
        && !node.effects.iter().any(|effect| effect.visible)
}

fn opaque_paint(node: &Node) -> bool {
    node.fills.iter().filter(|p| p.visible).all(|p| p.kind == "solid" && p.opacity == 1.
        && p.blend == "normal" && p.color.len() == 7 && p.color.starts_with('#'))
}

struct Collector<'a> {
    doc: &'a Document,
    lens: Option<Lens>,
    tolerance: f64,
    faces: Vec<Face<'a>>,
    points: usize,
    patches: BTreeMap<String, Projection>,
}

impl<'a> Collector<'a> {
    fn visit(&mut self, id: &str, parent: Affine3, placement: Transform) -> Result<(), String> {
        let node = &self.doc.nodes[id];
        if !node.visible { return Ok(()); }
        let pose = node.spatial.as_ref().and_then(|effects| effects.pose.filter(|pose| pose.visible));
        let world = parent.concat(Affine3::embed(node.transform)).concat(Affine3::pose(node, pose));
        let placement = placement.concat(node.transform);
        if !node.children.is_empty() {
            let keep_depth = node.spatial.as_ref().is_some_and(|effects| effects.preserve3d);
            if !matches!(node.kind.as_str(), "frame" | "group") || node.clip || !accepts_flat_style(node)
                || !keep_depth && node.fills.iter().any(|paint| paint.visible && paint.opacity > 0.)
                || node.spatial.as_ref().and_then(|s| s.perspective).is_some_and(|view| view.visible)
            {
                return Err("Shared 3D space requires transparent nested containers without clipping or a second perspective".into());
            }
            let child_space = if keep_depth { world } else { world.flatten() };
            if node.spatial.is_some() {
                self.patches.insert(id.into(), Projection {
                    transform: node.transform, visible: true, vector_geometry: None, hide_fills: keep_depth,
                });
            }
            for child in &node.children { self.visit(child, child_space, placement)?; }
            return Ok(());
        }
        if !node.fills.iter().any(|paint| paint.visible && paint.opacity > 0.) {
            if !accepts_flat_style(node) {
                return Err("Shared 3D space currently supports opaque solid vector faces".into());
            }
            // Prevent a second pass processing a 3D setting on an empty face.
            if node.spatial.is_some() {
                self.patches.insert(id.into(), Projection {
                    transform: node.transform, visible: node.visible, vector_geometry: None, hide_fills: false,
                });
            }
            return Ok(());
        }
        if self.faces.len() >= 32 {
            return Err("Shared 3D space exceeds 32 visible faces".into());
        }
        if !matches!(node.kind.as_str(), "rectangle" | "ellipse" | "vector" | "polygon" | "star")
            || !accepts_flat_style(node) || !opaque_paint(node)
        {
            return Err("Shared 3D space currently supports opaque solid vector faces".into());
        }
        let lens = self.lens;
        let project = |point| -> Result<(Point, f64), String> {
            let p = world.point(point);
            if let Some(lens) = lens { lens.cross_plane_coordinates(p) }
            else { Ok((Point::new(p[0], p[1]), 1.)) }
        };
        let (a, _) = project(Point::default())?;
        let (b, _) = project(Point::new(node.width, 0.))?;
        let (c, _) = project(Point::new(0., node.height))?;
        let [ma, mb, mc, md, _, _] = placement.0;
        let orientation = (b - a).cross(c - a) / ((ma * md - mb * mc) * node.width * node.height);
        if orientation.abs() < 1e-12 || orientation < 0. && pose.is_some_and(|pose| !pose.backface_visible) {
            self.patches.insert(id.into(), Projection { transform: node.transform, visible: false, vector_geometry: None, hide_fills: false });
            return Ok(());
        }
        let depth = depth_plane(node, world, lens, project)?;
        let outline = project_contours(&node.paths()?.0, self.tolerance, project)?;
        self.points += outline.iter().map(|c| c.points.len()).sum::<usize>();
        if self.points > 24_000 { return Err("Shared 3D outline budget exceeded".into()); }
        if let Some(bounds) = Box2::of(&outline) {
            self.faces.push(Face { node, scene_to_local: placement.inverse()?, outline, bounds, depth });
        } else {
            self.patches.insert(id.into(), Projection { transform: node.transform, visible: false, vector_geometry: None, hide_fills: false });
        }
        Ok(())
    }
}

pub(crate) fn project_scene(
    doc: &Document,
    frame: &Node,
    camera: Option<Camera>,
    page_from_frame: Transform,
    pose: Option<Pose>,
) -> Result<BTreeMap<String, Projection>, String> {
    if !accepts_flat_style(frame) {
        return Err("Shared 3D frames require opaque normal compositing without enabled strokes or effects".into());
    }
    let lens = camera.map(|camera| -> Result<Lens, String> {
        Ok(Lens { camera, inverse: camera.parent_to_scene.inverse()? })
    }).transpose()?;
    let mut collector = Collector {
        doc, lens, tolerance: PAGE_TOLERANCE / page_from_frame.max_scale().max(1.),
        faces: Vec::new(), points: 0, patches: BTreeMap::new(),
    };
    let local = Affine3::pose(frame, pose);
    for child in &frame.children { collector.visit(child, local, Transform::default())?; }
    // Keep authored paint order. Cut a later face only where an earlier
    // opaque face is nearer; leaving that earlier face underneath avoids
    // alpha seams between two separately antialiased cut edges.
    let mut remaining = 20_000_000;
    for (i, face) in collector.faces.iter().enumerate() {
        let mut inputs = vec![face.outline.clone()];
        let mut rules = vec![face.node.fill_even_odd()];
        for previous in &collector.faces[..i] {
            if !face.bounds.overlaps(previous.bounds) { continue; }
            let behind = above(previous, face, &mut remaining)?;
            if !behind.is_empty() {
                inputs.push(behind);
                rules.push(previous.node.fill_even_odd());
            }
        }
        let visible = if inputs.len() == 1 { inputs.pop().unwrap() }
            else { bounded_boolean(&inputs, Operation::Subtract, &rules, &mut remaining)? };
        let geometry = (!visible.is_empty()).then(||
            outline_geometry(&visible, face.scene_to_local, inputs.len() > 1 || face.node.fill_even_odd())).transpose()?;
        collector.patches.insert(face.node.id.clone(), Projection {
            transform: face.node.transform, visible: geometry.is_some(), vector_geometry: geometry, hide_fills: false,
        });
    }
    Ok(collector.patches)
}
