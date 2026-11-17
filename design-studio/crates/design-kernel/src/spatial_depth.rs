//! Resolve opaque faces in a shared 3D space before their ordinary paint
//! passes. Depth is affine in screen x/y after the homogeneous divide when
//! expressed as projected z/w. That makes an intersection a half-plane.
use crate::{
    boolean::{Operation, boolean_with_rules},
    math::{Point, Transform},
    path::Contour,
    scene::{Document, Node},
    spatial::{Camera, Pose, Projection, outline_geometry, sin_cos},
    spatial_curve::PAGE_TOLERANCE,
    spatial_material::{self, INTERSECTION_BUDGET, Material, MaterialPlane},
};
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
struct SpatialMatrix([[f64; 4]; 4]);

impl SpatialMatrix {
    fn embed(transform: Transform) -> Self {
        let [a, b, c, d, x, y] = transform.0;
        Self([
            [a, c, 0., x],
            [b, d, 0., y],
            [0., 0., 1., 0.],
            [0., 0., 0., 1.],
        ])
    }

    fn offset(x: f64, y: f64, z: f64) -> Self {
        Self([
            [1., 0., 0., x],
            [0., 1., 0., y],
            [0., 0., 1., z],
            [0., 0., 0., 1.],
        ])
    }

    fn pose(node: &Node, pose: Option<Pose>) -> Self {
        let Some(pose) = pose else {
            return Self::offset(0., 0., 0.);
        };
        let (sx, cx) = sin_cos(pose.rotate_x);
        let (sy, cy) = sin_cos(pose.rotate_y);
        let (sz, cz) = sin_cos(pose.rotate_z);
        let x = node.width * pose.origin[0];
        let y = node.height * pose.origin[1];
        Self::offset(x, y, pose.depth)
            .concat(Self([
                [1., 0., 0., 0.],
                [0., cx, -sx, 0.],
                [0., sx, cx, 0.],
                [0., 0., 0., 1.],
            ]))
            .concat(Self([
                [cy, 0., sy, 0.],
                [0., 1., 0., 0.],
                [-sy, 0., cy, 0.],
                [0., 0., 0., 1.],
            ]))
            .concat(Self([
                [cz, -sz, 0., 0.],
                [sz, cz, 0., 0.],
                [0., 0., 1., 0.],
                [0., 0., 0., 1.],
            ]))
            .concat(Self::offset(-x, -y, 0.))
    }

    fn perspective(distance: f64, center: Point) -> Self {
        Self([
            [1., 0., -center.x / distance, 0.],
            [0., 1., -center.y / distance, 0.],
            [0., 0., 1., 0.],
            [0., 0., -1. / distance, 1.],
        ])
    }

    fn concat(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|row| {
            std::array::from_fn(|col| (0..4).map(|i| self.0[row][i] * rhs.0[i][col]).sum())
        }))
    }

    fn flatten(self) -> Self {
        self.concat(Self([
            [1., 0., 0., 0.],
            [0., 1., 0., 0.],
            [0., 0., 0., 0.],
            [0., 0., 0., 1.],
        ]))
    }

    fn point(self, p: Point) -> Result<(Point, f64, f64), String> {
        let [x, y, z, w] = self.0.map(|row| row[0] * p.x + row[1] * p.y + row[3]);
        if !w.is_finite() || w < 1. / 32. {
            return Err("The layer crosses the perspective camera's near plane".into());
        }
        let projected = Point::new(x / w, y / w);
        let depth = z / w;
        if !projected.finite()
            || !depth.is_finite()
            || projected.x.abs().max(projected.y.abs()) > 1e7
        {
            return Err("Perspective output exceeds the scene coordinate budget".into());
        }
        Ok((projected, w, depth))
    }
}

#[derive(Clone, Copy)]
pub(crate) struct PlaneDepth(pub(crate) [f64; 3]);

impl PlaneDepth {
    pub(crate) fn at(self, p: Point) -> f64 {
        self.0[0] * p.x + self.0[1] * p.y + self.0[2]
    }

    pub(crate) fn difference(self, other: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] - other.0[i]))
    }
}

// z/w is affine in the divided x and y for a projected plane. This
// remains true after composing several local lenses and rigid poses.
fn depth_plane(a: Point, b: Point, c: Point, za: f64, zb: f64, zc: f64) -> PlaneDepth {
    let x = b - a;
    let y = c - a;
    let area = x.cross(y);
    let zx = ((zb - za) * y.y - (zc - za) * x.y) / area;
    let zy = (x.x * (zc - za) - y.x * (zb - za)) / area;
    PlaneDepth([zx, zy, za - zx * a.x - zy * a.y])
}

#[derive(Clone, Copy)]
struct Box2 {
    min: Point,
    max: Point,
}

impl Box2 {
    fn of(contours: &[Contour]) -> Option<Self> {
        let mut points = contours
            .iter()
            .flat_map(|contour| contour.points.iter().copied());
        let first = points.next()?;
        Some(points.fold(
            Self {
                min: first,
                max: first,
            },
            |bounds, p| Self {
                min: Point::new(bounds.min.x.min(p.x), bounds.min.y.min(p.y)),
                max: Point::new(bounds.max.x.max(p.x), bounds.max.y.max(p.y)),
            },
        ))
    }

    fn overlaps(self, other: Self) -> bool {
        self.min.x < other.max.x
            && self.max.x > other.min.x
            && self.min.y < other.max.y
            && self.max.y > other.min.y
    }

    fn corners(self) -> [Point; 4] {
        [
            self.min,
            Point::new(self.max.x, self.min.y),
            self.max,
            Point::new(self.min.x, self.max.y),
        ]
    }
}

struct Face<'a> {
    node: &'a Node,
    scene_to_local: Transform,
    outline: Vec<Contour>,
    bounds: Box2,
    depth: PlaneDepth,
    even_odd: bool,
    paints: Vec<Material>,
}

fn bounded_boolean(
    inputs: &[Vec<Contour>],
    operation: Operation,
    rules: &[bool],
    remaining: &mut usize,
) -> Result<Vec<Contour>, String> {
    let edges = inputs
        .iter()
        .flatten()
        .map(|c| c.points.len())
        .sum::<usize>();
    // The shared arrangement engine bounds one operation. A 3D scene also
    // has to bound the sum across all of its overlapping faces.
    let possible_pairs = edges.saturating_mul(edges.saturating_sub(1)) / 2;
    *remaining = remaining
        .checked_sub(possible_pairs)
        .ok_or("Shared 3D intersection budget exceeded")?;
    boolean_with_rules(inputs, operation, rules)
}

fn above(face: &Face<'_>, other: &Face<'_>, remaining: &mut usize) -> Result<Vec<Contour>, String> {
    if !face.bounds.overlaps(other.bounds) {
        return Ok(Vec::new());
    }
    let delta = face.depth.difference(other.depth);
    let corners = face.bounds.corners();
    // Ties keep authored painter order.
    let values = corners.map(|p| delta.at(p) - 1e-12);
    if values.iter().all(|v| *v <= 0.) {
        return Ok(Vec::new());
    }
    if values.iter().all(|v| *v > 0.) {
        return Ok(face.outline.clone());
    }
    let mut points = Vec::new();
    for i in 0..4 {
        let j = (i + 1) % 4;
        if values[i] > 0. {
            points.push(corners[i]);
        }
        if (values[i] > 0.) != (values[j] > 0.) {
            points.push(corners[i].lerp(corners[j], values[i] / (values[i] - values[j])));
        }
    }
    let clip = Contour {
        points,
        closed: true,
    };
    bounded_boolean(
        &[face.outline.clone(), vec![clip]],
        Operation::Intersect,
        &[face.even_odd, true],
        remaining,
    )
}

fn accepts_flat_style(node: &Node) -> bool {
    matches!(node.blend.as_str(), "normal" | "pass-through")
        && !node.mask
        && node.mask_chain.is_none()
        && node.repeat.is_none()
        && node.boolean_operation.is_none()
        && node.vector_brush.is_none()
        && node.path_offset == 0.
        && node.bindings.is_empty()
        && node.style_refs.is_empty()
        && node.instance.is_none()
        && !node.effects.iter().any(|effect| effect.visible)
}

fn accepts_container(node: &Node) -> bool {
    accepts_flat_style(node) && node.opacity == 1. && !spatial_material::has_strokes(node)
}

struct Collector<'a> {
    doc: &'a Document,
    tolerance: f64,
    faces: Vec<Face<'a>>,
    points: usize,
    remaining: usize,
    patches: BTreeMap<String, Projection>,
}

impl<'a> Collector<'a> {
    fn visit(
        &mut self,
        id: &str,
        parent: SpatialMatrix,
        placement: Transform,
    ) -> Result<(), String> {
        let node = &self.doc.nodes[id];
        if !node.visible || node.opacity <= 0. {
            return Ok(());
        }
        let pose = node
            .spatial
            .as_ref()
            .and_then(|effects| effects.pose.filter(|pose| pose.visible));
        let world = parent
            .concat(SpatialMatrix::embed(node.transform))
            .concat(SpatialMatrix::pose(node, pose));
        let placement = placement.concat(node.transform);
        if !node.children.is_empty() {
            let keep_depth = node
                .spatial
                .as_ref()
                .is_some_and(|effects| effects.preserve3d);
            if !matches!(node.kind.as_str(), "frame" | "group")
                || node.clip
                || !accepts_container(node)
                || !keep_depth
                    && node
                        .fills
                        .iter()
                        .any(|paint| paint.visible && paint.opacity > 0.)
            {
                return Err(
                    "Shared 3D space requires transparent nested containers without clipping"
                        .into(),
                );
            }
            let mut child_space = if keep_depth { world } else { world.flatten() };
            if let Some(lens) = node
                .spatial
                .as_ref()
                .and_then(|s| s.perspective)
                .filter(|lens| lens.visible)
            {
                child_space = child_space.concat(SpatialMatrix::perspective(
                    lens.distance,
                    Point::new(node.width / 2., node.height / 2.),
                ));
            }
            if node.spatial.is_some() {
                let mut patch = Projection::new(node.transform, true);
                patch.hide_fills = keep_depth;
                self.patches.insert(id.into(), patch);
            }
            for child in &node.children {
                self.visit(child, child_space, placement)?;
            }
            return Ok(());
        }
        if !node
            .fills
            .iter()
            .any(|paint| paint.visible && paint.opacity > 0.)
            && !spatial_material::has_strokes(node)
        {
            if !accepts_flat_style(node) {
                return Err(
                    "Shared 3D space requires normal solid vector faces without other effects"
                        .into(),
                );
            }
            // Prevent a second pass processing a 3D setting on an empty face.
            if node.spatial.is_some() {
                self.patches
                    .insert(id.into(), Projection::new(node.transform, node.visible));
            }
            return Ok(());
        }
        if self.faces.len() >= 32 {
            return Err("Shared 3D space exceeds 32 visible faces".into());
        }
        if !matches!(
            node.kind.as_str(),
            "rectangle" | "ellipse" | "vector" | "polygon" | "star"
        ) || !accepts_flat_style(node)
            || node.blend != "normal"
        {
            return Err(
                "Shared 3D space requires normal solid vector faces without other effects".into(),
            );
        }
        let project = |point| world.point(point).map(|(p, w, _)| (p, w));
        let (a, _, za) = world.point(Point::default())?;
        let (b, _, zb) = world.point(Point::new(node.width, 0.))?;
        let (c, _, zc) = world.point(Point::new(0., node.height))?;
        let [ma, mb, mc, md, _, _] = placement.0;
        let orientation = (b - a).cross(c - a) / ((ma * md - mb * mc) * node.width * node.height);
        if orientation.abs() < 1e-12
            || orientation < 0. && pose.is_some_and(|pose| !pose.backface_visible)
        {
            self.patches
                .insert(id.into(), Projection::new(node.transform, false));
            return Ok(());
        }
        let depth = depth_plane(a, b, c, za, zb, zc);
        let (shape, paints) =
            spatial_material::materials(node, self.tolerance, project, &mut self.remaining)?;
        let outline = shape.contours;
        self.points += outline.iter().map(|c| c.points.len()).sum::<usize>();
        if self.points > 24_000 {
            return Err("Shared 3D outline budget exceeded".into());
        }
        if let Some(bounds) = Box2::of(&outline) {
            self.faces.push(Face {
                node,
                scene_to_local: placement.inverse()?,
                outline,
                bounds,
                depth,
                even_odd: shape.even_odd,
                paints,
            });
        } else {
            self.patches
                .insert(id.into(), Projection::new(node.transform, false));
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
    if !accepts_container(frame) {
        return Err(
            "Shared 3D frames require opaque normal compositing without enabled strokes or effects"
                .into(),
        );
    }
    let mut local = SpatialMatrix::pose(frame, pose);
    if let Some(camera) = camera {
        local = SpatialMatrix::embed(camera.parent_to_scene.inverse()?)
            .concat(SpatialMatrix::perspective(camera.distance, camera.center))
            .concat(SpatialMatrix::embed(camera.parent_to_scene))
            .concat(local);
    }
    let mut collector = Collector {
        doc,
        tolerance: PAGE_TOLERANCE / page_from_frame.max_scale().max(1.),
        faces: Vec::new(),
        points: 0,
        remaining: INTERSECTION_BUDGET,
        patches: BTreeMap::new(),
    };
    for child in &frame.children {
        collector.visit(child, local, Transform::default())?;
    }
    let mut remaining = collector.remaining;
    if collector
        .faces
        .iter()
        .any(|face| spatial_material::needs_cells(face.node))
    {
        if doc.color_management.is_some() {
            return Err("Shared 3D translucent or stroked faces require SDR color".into());
        }
        let planes = collector
            .faces
            .iter()
            .map(|face| MaterialPlane {
                paints: &face.paints,
                depth: face.depth,
                opacity: face.node.opacity,
            })
            .collect::<Vec<_>>();
        let mut patch = Projection::new(frame.transform, frame.visible);
        patch.hide_fills = true;
        patch.composed = true;
        patch.appearances =
            spatial_material::appearances(&planes, Transform::default(), &mut remaining)?;
        collector.patches.insert(frame.id.clone(), patch);
    }
    // For opaque rendering and for picking, cut a later face only where
    // the preceding face is closer. Leave authored IDs and hierarchy intact.
    for (i, face) in collector.faces.iter().enumerate() {
        let mut inputs = vec![face.outline.clone()];
        let mut rules = vec![face.even_odd];
        for previous in &collector.faces[..i] {
            if !face.bounds.overlaps(previous.bounds) {
                continue;
            }
            let behind = above(previous, face, &mut remaining)?;
            if !behind.is_empty() {
                inputs.push(behind);
                rules.push(previous.even_odd);
            }
        }
        let visible = if inputs.len() == 1 {
            inputs.pop().unwrap()
        } else {
            bounded_boolean(&inputs, Operation::Subtract, &rules, &mut remaining)?
        };
        let geometry = (!visible.is_empty())
            .then(|| {
                outline_geometry(
                    &visible,
                    face.scene_to_local,
                    inputs.len() > 1 || face.even_odd,
                )
            })
            .transpose()?;
        let mut patch = Projection::new(face.node.transform, geometry.is_some());
        patch.vector_geometry = geometry;
        patch.hide_strokes = spatial_material::has_strokes(face.node);
        collector.patches.insert(face.node.id.clone(), patch);
    }
    Ok(collector.patches)
}
