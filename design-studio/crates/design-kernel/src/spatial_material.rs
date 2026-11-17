//! Material regions for projected solid planes. Resolve depth per geometric
//! cell so an intersecting translucent layer never loses the layer behind it.
use crate::{
    boolean::{Operation, boolean_with_rules},
    math::{Point, Transform},
    path::Contour,
    scene::{Node, Paint},
    software_raster::{encode_unorm8, over, straight_rgba8},
    spatial::outline_geometry,
    spatial_curve::project_contours,
    spatial_depth::PlaneDepth,
    vector_geometry::VectorGeometry,
};

pub(crate) const INTERSECTION_BUDGET: usize = 20_000_000;

pub(crate) struct Appearance {
    pub geometry: VectorGeometry,
    pub rgb: [u8; 3],
    pub alpha: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InsetStroke {
    pub interior: String,
    pub fill: [u8; 3],
    pub stroke: [u8; 3],
}

/// Only a single opaque fill and inside stroke can be refined without
/// changing another projected face's coverage or assuming a paint order.
pub(crate) fn inset_colors(node: &Node, cells: &[Appearance]) -> Option<([u8; 3], [u8; 3])> {
    if node.opacity != 1. || cells.len() != 2 || cells.iter().any(|cell| cell.alpha != 255) {
        return None;
    }
    let mut fills = node.fills.iter().filter(|paint| paint.visible && paint.opacity > 0.);
    let mut strokes = node.strokes.iter().filter(|stroke| {
        stroke.visible && stroke.width > 0. && stroke.paint.visible && stroke.paint.opacity > 0.
    });
    let (fill, stroke) = (fills.next()?, strokes.next()?);
    if fills.next().is_some() || strokes.next().is_some() || stroke.align != "inside"
        || fill.opacity != 1. || stroke.paint.opacity != 1.
    {
        return None;
    }
    let color = |paint: &Paint| {
        let [r, g, b, _] = rgb(paint).ok()?.map(encode_unorm8);
        Some([r, g, b])
    };
    let fill = color(fill)?;
    let stroke = color(&stroke.paint)?;
    (fill != stroke && cells.iter().any(|cell| cell.rgb == fill)
        && cells.iter().any(|cell| cell.rgb == stroke)).then_some((fill, stroke))
}

const MAX_CONVEX_INSET_EDGES: usize = 16;

struct InsetEdge {
    origin: Point,
    normal: Point,
    radius: f64,
}

/// Exact area for straight convex insets. Curved or larger paths use the
/// existing scanline area renderer.
pub(crate) struct ConvexInset(Vec<InsetEdge>);

impl ConvexInset {
    pub(crate) fn new(contours: &[Contour]) -> Option<Self> {
        let [contour] = contours else { return None };
        let points = &contour.points;
        if !contour.closed || !(3..=MAX_CONVEX_INSET_EDGES).contains(&points.len()) {
            return None;
        }
        let pairs = points.iter().copied().zip(points.iter().copied().cycle().skip(1));
        let start = points[0];
        let area = pairs.clone().map(|(a, b)| (a - start).cross(b - start)).sum::<f64>();
        if area.abs() < 1e-10 {
            return None;
        }
        let mut edges = Vec::with_capacity(points.len());
        for (a, b) in pairs {
            let direction = b - a;
            let length = direction.length();
            if length < 1e-10 {
                continue;
            }
            let normal = Point::new(-direction.y, direction.x) * (area.signum() / length);
            if points.iter().any(|point| (*point - a).dot(normal) < -1e-8) {
                return None;
            }
            edges.push(InsetEdge {
                origin: a,
                normal,
                radius: (normal.x.abs() + normal.y.abs()) * 0.5,
            });
        }
        Some(Self(edges))
    }

    pub(crate) fn coverage(&self, center: Point) -> f32 {
        let mut mixed = false;
        for edge in &self.0 {
            let signed = (center - edge.origin).dot(edge.normal);
            if signed <= -edge.radius {
                return 0.;
            }
            mixed |= signed < edge.radius;
        }
        if !mixed {
            return 1.;
        }
        // Clipping a convex polygon by one line adds at most one vertex.
        let mut polygon = [Point::default(); 4 + MAX_CONVEX_INSET_EDGES];
        let mut clipped = [Point::default(); 4 + MAX_CONVEX_INSET_EDGES];
        polygon[..4].copy_from_slice(&[
            Point::new(-0.5, -0.5), Point::new(0.5, -0.5),
            Point::new(0.5, 0.5), Point::new(-0.5, 0.5),
        ]);
        let mut count = 4;
        for edge in &self.0 {
            let signed = (center - edge.origin).dot(edge.normal);
            if signed >= edge.radius {
                continue;
            }
            let mut next = 0;
            for i in 0..count {
                let a = polygon[i];
                let b = polygon[(i + 1) % count];
                let da = a.dot(edge.normal) + signed;
                let db = b.dot(edge.normal) + signed;
                if da >= 0. {
                    clipped[next] = a;
                    next += 1;
                }
                if da * db < 0. {
                    clipped[next] = a.lerp(b, da / (da - db));
                    next += 1;
                }
            }
            if next < 3 {
                return 0.;
            }
            count = next;
            std::mem::swap(&mut polygon, &mut clipped);
        }
        let mut area = 0.;
        for i in 0..count {
            area += polygon[i].cross(polygon[(i + 1) % count]);
        }
        (area * 0.5).clamp(0., 1.) as f32
    }
}

#[derive(Clone)]
pub(crate) struct Shape {
    pub contours: Vec<Contour>,
    pub even_odd: bool,
}

impl Shape {
    fn bounds(&self) -> Option<[f64; 4]> {
        let mut points = self.contours.iter().flat_map(|c| &c.points);
        let p = points.next()?;
        Some(points.fold([p.x, p.y, p.x, p.y], |[l, t, r, b], p| {
            [l.min(p.x), t.min(p.y), r.max(p.x), b.max(p.y)]
        }))
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.bounds()
            .zip(other.bounds())
            .is_some_and(|([l, t, r, b], [x, y, z, w])| l < z && x < r && t < w && y < b)
    }
}

pub(crate) fn combine(
    a: &Shape,
    b: &Shape,
    op: Operation,
    remaining: &mut usize,
) -> Result<Shape, String> {
    let edges = a
        .contours
        .iter()
        .chain(&b.contours)
        .map(|c| c.points.len())
        .sum::<usize>();
    let pairs = edges.saturating_mul(edges.saturating_sub(1)) / 2;
    *remaining = remaining
        .checked_sub(pairs)
        .ok_or("Projected material intersection budget exceeded")?;
    let contours = boolean_with_rules(
        &[a.contours.clone(), b.contours.clone()],
        op,
        &[a.even_odd, b.even_odd],
    )?;
    Ok(Shape {
        contours,
        even_odd: true,
    })
}

pub(crate) struct Material {
    pub shape: Shape,
    color: [f32; 4],
}

fn rgb(paint: &Paint) -> Result<[f32; 4], String> {
    let code = paint
        .color
        .strip_prefix('#')
        .ok_or("Projected materials require normal sRGB solid paint")?;
    if paint.kind != "solid" || paint.blend != "normal" || code.len() != 6 {
        return Err("Projected materials require normal sRGB solid paint".into());
    }
    let raw = u32::from_str_radix(code, 16).map_err(|_| "Invalid projected material color")?;
    let a = paint.opacity as f32;
    Ok([
        ((raw >> 16) & 255) as f32 * a / 255.,
        ((raw >> 8) & 255) as f32 * a / 255.,
        (raw & 255) as f32 * a / 255.,
        a,
    ])
}

pub(crate) fn has_strokes(node: &Node) -> bool {
    node.strokes
        .iter()
        .any(|s| s.visible && s.paint.visible && s.width > 0. && s.paint.opacity > 0.)
}

pub(crate) fn needs_cells(node: &Node) -> bool {
    node.opacity < 1. || has_strokes(node) || node.fills.iter().any(|p| p.visible && p.opacity < 1.)
}

pub(crate) fn materials(
    node: &Node,
    tolerance: f64,
    project: impl Fn(Point) -> Result<(Point, f64), String>,
    remaining: &mut usize,
) -> Result<(Shape, Vec<Material>), String> {
    let (fill, stroke) = node.paths()?;
    let body = Shape {
        contours: project_contours(&fill, tolerance, &project)?,
        even_odd: node.fill_even_odd(),
    };
    let mut paints = Vec::new();
    if !body.contours.is_empty() {
        for paint in node.fills.iter().filter(|p| p.visible && p.opacity > 0.) {
            paints.push(Material {
                shape: body.clone(),
                color: rgb(paint)?,
            });
        }
    }
    if has_strokes(node) {
        // Expand in the authored plane before applying perspective. Expanding
        // the projected centerline would leave the stroke uniformly wide.
        let density = [
            Point::default(),
            Point::new(node.width, 0.),
            Point::new(0., node.height),
            Point::new(node.width, node.height),
        ]
        .into_iter()
        .try_fold(1_f64, |largest, p| {
            let center = project(p)?.0;
            let x = (project(p + Point::new(0.01, 0.))?.0 - center).length() * 100.;
            let y = (project(p + Point::new(0., 0.01))?.0 - center).length() * 100.;
            Ok::<_, String>(largest.max(x + y))
        })?;
        let local_tolerance = tolerance / density.max(1.);
        let centerline = stroke.flatten(Transform::default(), local_tolerance)?;
        for stroke in node
            .strokes
            .iter()
            .filter(|s| s.visible && s.paint.visible && s.width > 0. && s.paint.opacity > 0.)
        {
            let mut contours = crate::stroke::expand(&centerline, stroke, local_tolerance, 0.)?;
            for contour in &mut contours {
                for p in &mut contour.points {
                    *p = project(*p)?.0;
                }
            }
            let region = Shape {
                contours,
                even_odd: false,
            };
            let region = match stroke.align.as_str() {
                "inside" => combine(&region, &body, Operation::Intersect, remaining)?,
                "outside" => combine(&region, &body, Operation::Subtract, remaining)?,
                _ => region,
            };
            if !region.contours.is_empty() {
                paints.push(Material {
                    shape: region,
                    color: rgb(&stroke.paint)?,
                });
            }
        }
    }
    let mut outline = if let Some(p) = paints.first() {
        p.shape.clone()
    } else {
        Shape {
            contours: Vec::new(),
            even_odd: true,
        }
    };
    if has_strokes(node) {
        for paint in paints.iter().skip(1) {
            outline = combine(&outline, &paint.shape, Operation::Union, remaining)?;
        }
    }
    Ok((outline, paints))
}

pub(crate) struct MaterialPlane<'a> {
    pub paints: &'a [Material],
    pub depth: PlaneDepth,
    pub opacity: f64,
}

#[derive(Clone)]
struct Cell {
    shape: Shape,
    paints: Vec<(usize, usize)>,
}

fn clip_side(
    cell: &Shape,
    depth: PlaneDepth,
    remaining: &mut usize,
) -> Result<Option<(Shape, Shape)>, String> {
    let Some([l, t, r, b]) = cell.bounds() else {
        return Ok(None);
    };
    let corners = [
        Point::new(l, t),
        Point::new(r, t),
        Point::new(r, b),
        Point::new(l, b),
    ];
    let values = corners.map(|p| depth.at(p));
    if values.iter().all(|v| *v <= 1e-12) || values.iter().all(|v| *v >= -1e-12) {
        return Ok(None);
    }
    let mut points = Vec::new();
    for i in 0..4 {
        let j = (i + 1) % 4;
        if values[i] >= 0. {
            points.push(corners[i]);
        }
        if (values[i] >= 0.) != (values[j] >= 0.) {
            points.push(corners[i].lerp(corners[j], values[i] / (values[i] - values[j])));
        }
    }
    let plane = Shape {
        contours: vec![Contour {
            points,
            closed: true,
        }],
        even_odd: true,
    };
    Ok(Some((
        combine(cell, &plane, Operation::Intersect, remaining)?,
        combine(cell, &plane, Operation::Subtract, remaining)?,
    )))
}

pub(crate) fn appearances(
    planes: &[MaterialPlane<'_>],
    to_local: Transform,
    remaining: &mut usize,
) -> Result<Vec<Appearance>, String> {
    let mut cells: Vec<Cell> = Vec::new();
    for (face, plane) in planes.iter().enumerate() {
        for (index, material) in plane.paints.iter().enumerate() {
            let mut remainder = material.shape.clone();
            let mut next = Vec::new();
            for mut cell in cells.drain(..) {
                if !cell.shape.overlaps(&material.shape) {
                    next.push(cell);
                    continue;
                }
                let intersection = combine(
                    &cell.shape,
                    &material.shape,
                    Operation::Intersect,
                    remaining,
                )?;
                if intersection.contours.is_empty() {
                    next.push(cell);
                    continue;
                }
                if !remainder.contours.is_empty() {
                    remainder = combine(&remainder, &cell.shape, Operation::Subtract, remaining)?;
                }
                let mut paints = cell.paints.clone();
                paints.push((face, index));
                cell.shape = combine(&cell.shape, &material.shape, Operation::Subtract, remaining)?;
                if !cell.shape.contours.is_empty() {
                    next.push(cell);
                }
                next.push(Cell {
                    shape: intersection,
                    paints,
                });
            }
            if !remainder.contours.is_empty() {
                next.push(Cell {
                    shape: remainder,
                    paints: vec![(face, index)],
                });
            }
            if next.len() > 128 {
                return Err("Projected material exceeds 128 coverage cells".into());
            }
            cells = next;
        }
    }
    let mut rendered = Vec::new();
    for cell in cells {
        let faces = cell
            .paints
            .iter()
            .map(|&(face, _)| face)
            .fold(Vec::new(), |mut ids, face| {
                if ids.last() != Some(&face) {
                    ids.push(face);
                }
                ids
            });
        let mut partitions = vec![cell.shape];
        for (i, &a) in faces.iter().enumerate() {
            for &b in &faces[..i] {
                let depth = planes[a].depth.difference(planes[b].depth);
                let mut next = Vec::new();
                for shape in partitions.drain(..) {
                    if let Some((first, second)) = clip_side(&shape, depth, remaining)? {
                        next.extend(
                            [first, second]
                                .into_iter()
                                .filter(|s| !s.contours.is_empty()),
                        );
                    } else {
                        next.push(shape);
                    }
                }
                if next.len() + rendered.len() > 128 {
                    return Err("Projected 3D depth exceeds 128 material cells".into());
                }
                partitions = next;
            }
        }
        for shape in partitions {
            // The vertex mean stays in every depth half-plane of the cell,
            // including concave or multi-contour cells.
            let (sum, n) = shape
                .contours
                .iter()
                .flat_map(|c| &c.points)
                .fold((Point::default(), 0u32), |(sum, n), p| (sum + *p, n + 1));
            if n == 0 {
                continue;
            }
            let sample = sum * (1. / f64::from(n));
            let mut ordered = faces.clone();
            ordered.sort_by(|&a, &b| {
                planes[a]
                    .depth
                    .at(sample)
                    .total_cmp(&planes[b].depth.at(sample))
                    .then(a.cmp(&b))
            });
            let pixel = ordered.into_iter().fold([0.; 4], |dst, face| {
                let src = cell
                    .paints
                    .iter()
                    .filter(|&&(slot, _)| slot == face)
                    .fold([0.; 4], |src, &(_, index)| {
                        over(src, planes[face].paints[index].color)
                    });
                over(dst, src.map(|v| v * planes[face].opacity as f32))
            });
            let [r, g, b, a] = straight_rgba8(pixel.map(encode_unorm8));
            if a != 0 {
                rendered.push(Appearance {
                    geometry: outline_geometry(&shape.contours, to_local, shape.even_odd)?,
                    rgb: [r, g, b],
                    alpha: a,
                });
            }
        }
    }
    Ok(rendered)
}
