//! Curve graph Boolean operations. Cubic segments remain cubic after clipping.
//! Uses flo_curves' Bézier clipping/intersection graph; signed winding is selected
//! per operand, including self intersections and coincident contours.
use crate::{
    boolean::Operation,
    math::{Point, Transform},
    path::{Command, Path},
    scene::{Document, Edge, Network, Vertex},
};
use flo_curves::{Coord2, bezier::path::*};

pub fn curves(path: &Path, m: Transform) -> Result<Vec<SimpleBezierPath>, String> {
    let mut out = Vec::new();
    let mut parts = Vec::new();
    let mut start = Point::default();
    let mut pen = start;
    let c = |p: Point| {
        let p = m.point(p);
        Coord2(p.x, p.y)
    };
    for cmd in &path.commands {
        match *cmd {
            Command::Move(p) => {
                if !parts.is_empty() {
                    return Err("Boolean operands must be closed".into());
                }
                start = p;
                pen = p;
            }
            Command::Line(p) => {
                parts.push((c(pen.lerp(p, 1. / 3.)), c(pen.lerp(p, 2. / 3.)), c(p)));
                pen = p;
            }
            Command::Quad(q, p) => {
                parts.push((c(pen.lerp(q, 2. / 3.)), c(p.lerp(q, 2. / 3.)), c(p)));
                pen = p;
            }
            Command::Cubic(a, b, p) => {
                parts.push((c(a), c(b), c(p)));
                pen = p;
            }
            Command::Arc {
                center,
                radius,
                start: a,
                sweep,
            } => {
                // flo_curves only accepts polynomial cubics: the exact conic
                // decomposition happens first, the bounded `to_cubic`
                // downgrade is the final step at this engine boundary.
                let pieces = crate::path::rational_arc(
                    center,
                    radius,
                    a,
                    sweep,
                    std::f64::consts::FRAC_PI_4,
                )?;
                if pieces.is_empty() {
                    let end = center + Point::new(radius.x * a.cos(), radius.y * a.sin());
                    parts.push((c(end), c(end), c(end)));
                    pen = end;
                }
                for (from, piece) in pieces {
                    let (b1, b2, end) = piece.to_cubic(from);
                    parts.push((c(b1), c(b2), c(end)));
                    pen = end;
                }
            }
            Command::SmoothCorner(corner) => {
                // Preserve the pre-existing polygon approximation at the curve
                // Boolean boundary; flo_curves has no superellipse primitive.
                for p in corner.legacy_points() {
                    parts.push((c(pen.lerp(p, 1. / 3.)), c(pen.lerp(p, 2. / 3.)), c(p)));
                    pen = p;
                }
            }
            Command::Close => {
                if (pen - start).length() > 1e-10 {
                    parts.push((
                        c(pen.lerp(start, 1. / 3.)),
                        c(pen.lerp(start, 2. / 3.)),
                        c(start),
                    ));
                }
                if !parts.is_empty() {
                    out.push((c(start), std::mem::take(&mut parts)));
                }
                pen = start;
            }
        }
    }
    if !parts.is_empty() {
        return Err("Boolean operands must be closed".into());
    }
    Ok(out)
}
pub fn network(paths: Vec<SimpleBezierPath>) -> Network {
    let mut g = Network {
        vertices: vec![],
        edges: vec![],
        filled_faces: None,
        fill_rule: "evenodd".into(),
    };
    for (start, segments) in paths {
        if segments.is_empty() {
            continue;
        }
        let base = g.vertices.len();
        g.vertices.push(Vertex {
            id: base.to_string(),
            x: start.0,
            y: start.1,
        });
        for (i, (a, b, p)) in segments.iter().enumerate() {
            let last = i + 1 == segments.len() && (p.0 - start.0).hypot(p.1 - start.1) < 0.01;
            let to = if last { base } else { g.vertices.len() };
            if !last {
                g.vertices.push(Vertex {
                    id: to.to_string(),
                    x: p.0,
                    y: p.1,
                });
            }
            g.edges.push(Edge {
                id: g.edges.len().to_string(),
                from: (base + i).to_string(),
                to: to.to_string(),
                c1: Some(Point::new(a.0, a.1)),
                c2: Some(Point::new(b.0, b.1)),
            });
        }
    }
    g
}
// Routing must use the same source-segment unit as `combine`, not serialized
// commands: Move/Close are not edges, while arcs and smooth corners expand.
// Avoid building a second full curve graph just to select the representation.
fn source_segment_count(path: &Path) -> Result<usize, String> {
    let mut count = 0;
    let mut start = Point::default();
    let mut pen = start;
    for command in &path.commands {
        match *command {
            Command::Move(p) => { start = p; pen = p; }
            Command::Line(p) | Command::Quad(_, p) | Command::Cubic(_, _, p) => {
                count += 1;
                pen = p;
            }
            Command::Arc { center, radius, start: angle, sweep } => {
                // Use the existing decomposition and endpoint, including its
                // degenerate zero-sweep segment and subdivision guard.
                let pieces = crate::path::rational_arc(
                    center, radius, angle, sweep, std::f64::consts::FRAC_PI_4,
                )?;
                count += pieces.len().max(1);
                pen = pieces.last().map(|(_, piece)| piece.end).unwrap_or_else(||
                    center + Point::new(radius.x * angle.cos(), radius.y * angle.sin()));
            }
            Command::SmoothCorner(corner) => {
                for point in corner.legacy_points() { count += 1; pen = point; }
            }
            Command::Close => {
                if (pen - start).length() > 1e-10 { count += 1; }
                pen = start;
            }
        }
    }
    Ok(count)
}

pub fn combine(inputs: &[(Path, Transform, bool)], op: Operation) -> Result<Network, String> {
    if inputs.is_empty() || inputs.len() > 64 {
        return Err("Select 1–64 curve operands".into());
    }
    let paths = inputs
        .iter()
        .map(|(p, m, _)| curves(p, *m))
        .collect::<Result<Vec<_>, _>>()?;
    let edges: usize = paths.iter().flatten().map(|p| p.1.len()).sum();
    // Real native compound masks contain several thousand authored segments.
    // Keep the 64-operand and 10000-output caps; no unbounded admission.
    if edges > 8192 {
        return Err("Curve Boolean exceeds 8192 source segments; split the operation".into());
    }
    if edges == 0 {
        return Ok(network(vec![]));
    }
    Ok(network(clip_paths(&paths, inputs, op, 10000)?))
}

// Curve control hulls conservatively bound every intersection. Limit the
// sweep work as well as segment storage before admitting a dense render path.
fn admit_dense_paths(paths: &[Vec<SimpleBezierPath>]) -> Result<(), String> {
    let mut hulls = Vec::new();
    for path in paths.iter().flatten() {
        let mut from = path.0;
        for &(a,b,to) in &path.1 {
            let points = [from,a,b,to];
            let x = points.iter().map(|p|p.0).fold(f64::INFINITY,f64::min)-0.001;
            let y = points.iter().map(|p|p.1).fold(f64::INFINITY,f64::min)-0.001;
            let xx = points.iter().map(|p|p.0).fold(f64::NEG_INFINITY,f64::max)+0.001;
            let yy = points.iter().map(|p|p.1).fold(f64::NEG_INFINITY,f64::max)+0.001;
            if ![x,y,xx,yy].iter().all(|v|v.is_finite()) { return Err("Invalid dense Boolean bounds".into()); }
            hulls.push([x,y,xx,yy]); from=to;
        }
    }
    if hulls.len() > crate::vector_geometry::MAX_COMMANDS { return Err("Dense Boolean input command budget exceeded".into()); }
    // Select the sparser axis. A tall narrow contour can have thousands of
    // disjoint edges sharing x; counting only x would falsely reject it.
    let sweep_work = |axis:usize| {
        let mut starts:Vec<_>=hulls.iter().map(|h|h[axis]).collect();
        let mut ends:Vec<_>=hulls.iter().map(|h|h[axis+2]).collect();
        starts.sort_by(f64::total_cmp);ends.sort_by(f64::total_cmp);
        starts.iter().enumerate().map(|(i,start)| i.saturating_sub(ends.partition_point(|end|end<start))).sum::<usize>()
    };
    let work=[sweep_work(0),sweep_work(1)];let axis=usize::from(work[1]<work[0]);
    // At most the pair work of the former 8192-edge all-pairs ceiling.
    // Count actual 2D hull overlaps separately: parallel, disjoint segments
    // sharing one coordinate must not be mistaken for intersections.
    if work[axis] > 32_000_000 {return Err("Dense Boolean intersection work budget exceeded".into());}
    hulls.sort_by(|a,b|a[axis].total_cmp(&b[axis]));
    let other=1-axis;let mut active:Vec<[f64;4]>=Vec::new();let mut overlaps=0usize;
    for hull in hulls {
        active.retain(|old|old[axis+2]>=hull[axis]);
        overlaps+=active.iter().filter(|old|old[other]<=hull[other+2]&&old[other+2]>=hull[other]).count();
        if overlaps>2_000_000{return Err("Dense Boolean intersection work budget exceeded".into());}
        active.push(hull);
    }
    Ok(())
}

fn clip_paths(paths: &[Vec<SimpleBezierPath>], inputs: &[(Path,Transform,bool)], op:Operation, output_limit:usize) -> Result<Vec<SimpleBezierPath>,String> {
    let accuracy = 0.001;
    let mut graph = GraphPath::new();
    for (i, p) in paths.iter().enumerate() {
        // flo_curves makes every input contour clockwise. A nonzero operand
        // with several contours needs the original sign when crossings cancel.
        let signed = op == Operation::CompoundNonzero || (!inputs[i].2 && p.len() > 1);
        let mut operand = GraphPath::from_merged_paths(p.iter().map(|path| {
            let label = if signed && matches!(PathDirection::from(path), PathDirection::Anticlockwise) {
                i + inputs.len()
            } else { i };
            (path, PathLabel(label as u32))
        }));
        // Operand self-intersections are split before cross-operand clipping.
        operand.self_collide(accuracy);
        if operand.num_points() > crate::vector_geometry::MAX_COMMANDS { return Err("Boolean intersection graph budget exceeded".into()); }
        graph = if i == 0 {
            graph.merge(operand)
        } else {
            graph.collide(operand, accuracy)
        };
        if graph.num_points() > crate::vector_geometry::MAX_COMMANDS { return Err("Boolean intersection graph budget exceeded".into()); }
    }
    graph.round(accuracy);
    graph.set_edge_kinds_by_ray_casting(|counts| {
        let winding = |i: usize| i64::from(counts.get(i).copied().unwrap_or(0))
            - i64::from(counts.get(i + inputs.len()).copied().unwrap_or(0));
        let filled: Vec<_> = inputs
            .iter()
            .enumerate()
            .map(|(i, (_, _, evenodd))| {
                let w = winding(i);
                if *evenodd { w.abs() % 2 != 0 } else { w != 0 }
            })
            .collect();
        match op {
            Operation::Union => filled.iter().any(|v| *v),
            Operation::Subtract => filled[0] && !filled[1..].iter().any(|v| *v),
            Operation::Intersect => filled.iter().all(|v| *v),
            Operation::Exclude => filled.iter().filter(|v| **v).count() % 2 != 0,
            Operation::CompoundNonzero => (0..inputs.len()).map(winding).sum::<i64>() != 0,
            Operation::CompoundEvenodd => counts.iter().map(|v|i64::from(*v)).sum::<i64>().abs()%2!=0,
        }
    });
    graph.heal_exterior_gaps();
    let result: Vec<SimpleBezierPath> = graph.exterior_paths();
    if result.iter().map(|p| p.1.len()).sum::<usize>() > output_limit {
        return Err("Curve Boolean output budget exceeded".into());
    }
    Ok(result)
}

fn combine_dense(inputs:&[(Path,Transform,bool)], op:Operation) -> Result<crate::vector_geometry::VectorGeometry,String> {
    let paths=inputs.iter().map(|(p,m,_)|curves(p,*m)).collect::<Result<Vec<_>,_>>()?;
    admit_dense_paths(&paths)?;
    // Dense imported contours can have thousands of distinct segments inside
    // flo_curves' fixed 0.001 coincidence tolerance. Scale this derived work
    // space by an exact power of two; preserve authored f64 inputs and tighten
    // clipping to 2^-10 of the ordinary local tolerance, never coarsen it.
    const WORK_SCALE:f64=1024.;
    let scale=|p:Coord2|Coord2(p.0*WORK_SCALE,p.1*WORK_SCALE);
    let working:Vec<Vec<SimpleBezierPath>>=paths.iter().map(|operand|operand.iter().map(|(start,curves)|
        (scale(*start),curves.iter().map(|(a,b,to)|(scale(*a),scale(*b),scale(*to))).collect())).collect()).collect();
    let result=clip_paths(&working, inputs, op, crate::vector_geometry::MAX_COMMANDS)?;
    let unscale=|p:Coord2|Point::new(p.0/WORK_SCALE,p.1/WORK_SCALE);
    let mut path=Path::default();
    for (start,segments) in result {
        if segments.is_empty() {continue;}
        path.commands.push(Command::Move(unscale(start)));
        for (a,b,p) in segments {path.commands.push(Command::Cubic(unscale(a),unscale(b),unscale(p)));}
        path.commands.push(Command::Close);
    }
    crate::vector_geometry::VectorGeometry::from_paths(&path,&path,"evenodd")
}
thread_local! {
    // Pure exact operands/results only; no document IDs, fonts, GPU resources,
    // revision authority or mutable node ownership cross this cache boundary.
    // The pre-existing cache retains its 8 MiB/1024-entry admission limits.
    static RESOLUTION_MEMO: std::cell::RefCell<crate::curve_boolean_cache::Cache> = Default::default();
}
pub fn resolve(doc: &mut Document) -> Result<(), String> {resolve_roots(doc,None)}
pub(crate) fn resolve_roots(doc:&mut Document,roots:Option<&std::collections::BTreeSet<String>>)->Result<(),String>{
    let roots: Vec<_> = doc.pages.iter().flat_map(|page| page.children.iter())
        .filter(|id| roots.is_none_or(|roots| roots.contains(*id))).cloned().collect();
    resolve_subtrees(doc, roots)
}

pub(crate) fn resolve_subtrees(doc: &mut Document, roots: Vec<String>) -> Result<(), String> {
    RESOLUTION_MEMO.with(|memo| resolve_with_cache(doc, &mut memo.borrow_mut(), true, roots))
}
#[cfg(test)]
fn resolve_cached(doc: &mut Document, memoize: bool) -> Result<(), String> {
    let roots = doc.pages.iter().flat_map(|page| page.children.iter().cloned()).collect();
    resolve_with_cache(doc, &mut crate::curve_boolean_cache::Cache::default(), memoize, roots)
}
/// Tie the source outline to the complete editable geometry of a flat
/// boolean. Any changed operand falls back to the ordinary boolean solver.
pub(crate) fn fig_outline_key(node: &crate::scene::Node, children: &[&crate::scene::Node]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let geometry = node.vector_geometry.as_ref()?;
    if children.is_empty() || children.len() > 64 || children.iter().any(|child|
        !child.children.is_empty() || child.boolean_operation.is_some() || child.instance.is_some() ||
        child.kind == "text" || child.vector_brush.is_some() || !child.style_refs.is_empty() || !child.bindings.is_empty())
    {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(node.width, node.height, node.boolean_operation, geometry)).ok()?);
    for child in children {
        let fills = child.fills.iter().any(|p| p.visible && p.opacity > 0.);
        let strokes: Vec<_> = child.strokes.iter().map(|s| (
            s.width, &s.align, &s.cap, &s.join, &s.dash, s.dash_offset, s.visible, s.paint.visible,
            s.paint.opacity > 0., &s.width_profile, s.start_marker, s.end_marker,
        )).collect();
        hash.update(serde_json::to_vec(&(child.kind.as_str(), child.transform, child.width, child.height,
            child.visible, child.radii, child.smoothing, child.arc, child.corner_radius, child.points, child.inner_radius,
            &child.network, &child.vector_geometry, child.path_offset, fills, strokes)).ok()?);
    }
    Some(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

// Figma can boolean-combine the painted area of an open stroke, whose fill
// path is empty. Expand in local space before applying the operand transform.
fn stroke_operand(node: &crate::scene::Node) -> Result<Option<Path>, String> {
    let strokes = node.strokes.iter().filter(|s| s.visible && s.paint.visible && s.paint.opacity > 0. && s.width > 0.);
    let mut outline = Path::default();
    for stroke in strokes {
        let local = node.paths()?.1.flatten(Transform::default(), 0.005)?;
        for contour in crate::stroke::expand(&local, stroke, 0.005, 0.)? {
            if outline.commands.len().saturating_add(contour.points.len()).saturating_add(1) > crate::vector_geometry::MAX_COMMANDS {
                return Err("Boolean stroke command budget exceeded".into());
            }
            outline.commands.extend(Path::polygon(&contour.points, true).commands);
        }
    }
    Ok((!outline.commands.is_empty()).then_some(outline))
}

fn resolve_with_cache(doc: &mut Document, cache: &mut crate::curve_boolean_cache::Cache, memoize: bool, roots: Vec<String>) -> Result<(), String> {
    fn visit(doc: &mut Document, id: &str, depth: usize, cache: &mut crate::curve_boolean_cache::Cache, memoize: bool) -> Result<(), String> {
        if depth > 64 {
            return Err("Boolean depth exceeded".into());
        }
        let children = doc.nodes.get(id).ok_or_else(|| format!("Missing boolean subtree node {id}"))?
            .children.clone();
        for child in &children {
            visit(doc, child, depth + 1, cache, memoize)?;
        }
        if let Some(op) = doc.nodes[id].boolean_operation {
            let node = &doc.nodes[id];
            if let Some(source) = crate::interop::sketch_binding(doc, node, "figBooleanOutlineKey")
                && fig_outline_key(node, &children.iter().map(|id| &doc.nodes[id]).collect::<Vec<_>>()).as_deref() == Some(source)
            {
                return Ok(());
            }
            let stroke_operands = crate::interop::sketch_binding(doc, &doc.nodes[id], "figBooleanStrokeOperands") == Some("true");
            let inputs = children
                .iter()
                .filter(|c| doc.nodes[*c].visible)
                .map(|c| {
                    let n = &doc.nodes[c];
                    if stroke_operands && !n.fills.iter().any(|p| p.visible && p.opacity > 0.)
                        && let Some(path) = stroke_operand(n)?
                    {
                        return Ok((path, n.transform, false));
                    }
                    Ok((
                        if op.compound_rule().is_some() && n.boolean_operation.is_none() {
                            if let Some(network)=&n.network {
                                // Native contour traversal carries winding direction.
                                // Planar face reconstruction can reverse the inner loop.
                                let path = crate::vector_geometry::VectorGeometry::ordered_network(network, true)
                                    .and_then(|geometry| geometry.paths()).map(|paths| paths.0);
                                match path {
                                    Ok(path) => path,
                                    Err(_) if crate::interop::sketch_binding(doc, n, "sketchOpenPath") == Some("true")
                                        && network.vertices.first().zip(network.vertices.last())
                                            .is_some_and(|(first, last)| first.point() == last.point()) =>
                                    {
                                        // Some Sketch contours store their last anchor at
                                        // their first while retaining an open stroke flag.
                                        // They enclose a region in the parent compound fill.
                                        let (_, mut contour) = crate::vector_geometry::VectorGeometry::ordered_network(network, false)?.paths()?;
                                        contour.commands.push(Command::Close);
                                        contour
                                    }
                                    Err(_) => n.paths()?.0,
                                }
                            } else { n.paths()?.0 }
                        } else { n.paths()?.0 },
                        n.transform,
                        n.fill_even_odd(),
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            if let Some(rule)=op.compound_rule() {
                if doc.schema_version<16{return Err("Compound paths require schema 16".into());}
                let key=crate::curve_boolean_cache::Cache::key(&inputs,op);
                let geometry=if let Some(value)=memoize.then(||cache.get_geometry(&key)).flatten(){value}else{
                    let mut path=Path::default();
                    for (input,matrix,_) in &inputs {
                        for (start,segments) in curves(input,*matrix)? {
                            if path.commands.len().saturating_add(segments.len()).saturating_add(2)>crate::vector_geometry::MAX_COMMANDS{return Err("Compound path command budget exceeded".into());}
                            path.commands.push(Command::Move(Point::new(start.0,start.1)));
                            for (a,b,to) in segments {path.commands.push(Command::Cubic(Point::new(a.0,a.1),Point::new(b.0,b.1),Point::new(to.0,to.1)));}
                            path.commands.push(Command::Close);
                        }
                    }
                    let value=crate::vector_geometry::VectorGeometry::from_paths(&path,&path,rule)?;
                    if memoize{cache.insert_geometry(key,&value);}value
                };
                let node=doc.nodes.get_mut(id).unwrap();node.network=None;node.vector_geometry=Some(geometry.into());
                return Ok(());
            }
            let segments = inputs.iter().try_fold(0usize, |count, (path, _, _)| {
                source_segment_count(path).map(|segments| count + segments)
            }).map_err(|error| format!("Boolean node {id}: {error}"))?;
            if segments > 8192 {
                if doc.schema_version < 16 { return Err("Dense Boolean render geometry requires schema 16".into()); }
                let key=crate::curve_boolean_cache::Cache::key(&inputs,op);
                let geometry=if let Some(value)=memoize.then(||cache.get_geometry(&key)).flatten(){value}else{
                    let value=combine_dense(&inputs,op).map_err(|e|format!("Boolean node {id}: {e}"))?;
                    if memoize{cache.insert_geometry(key,&value);}value
                };
                let node=doc.nodes.get_mut(id).unwrap(); node.network=None;node.vector_geometry=Some(geometry.into());
                return Ok(());
            }
            let g = if inputs.is_empty() {
                network(vec![])
            } else {
                let key = crate::curve_boolean_cache::Cache::key(&inputs, op);
                if let Some(cached) = memoize.then(|| cache.get(&key)).flatten() { cached } else {
                    let result = combine(&inputs, op).map_err(|e| format!("Boolean node {id}: {e}"))?;
                    if memoize { cache.insert(key, &result); } result
                }
            };
            let node=doc.nodes.get_mut(id).unwrap();node.vector_geometry=None;node.network=Some((g).into());
        }
        Ok(())
    }
    for id in roots {
        visit(doc, &id, 0, cache, memoize)?;
    }
    Ok(())
}

/// An operand pose can leave the resolved outline unchanged (for example an
/// open contour in a union). Evaluate that complete, bounded Boolean again
/// before reporting zero page damage. Never infer this from its bounds.
pub(crate) fn operand_keeps_outline(doc: &Document, parent: &str, operand: &str, pose: Transform) -> bool {
    let Some(group) = doc.nodes.get(parent) else { return false; };
    if group.boolean_operation.is_none() || group.children.len() > 32 || !group.children.iter().any(|id| id == operand) {
        return false;
    }
    let geometry_items = |n: &crate::scene::Node| {
        n.network.as_ref().map_or(0, |g| g.vertices.len()+g.edges.len()) +
            n.vector_geometry.as_ref().map_or(0, |g| g.fill.len()+g.stroke.as_ref().map_or(0,Vec::len))
    };
    let mut total = geometry_items(group);
    if total > 4096 { return false; }
    let Some(page) = doc.pages.first() else { return false; };
    let mut island = Document {
        fd_compatibility: None, reviews: vec![], design_system: None, prototype: None,
        schema_version: doc.schema_version, color_management: doc.color_management,
        raster_profile: doc.raster_profile, id: doc.id.clone(), name: doc.name.clone(),
        pages: vec![crate::scene::Page { id: page.id.clone(), name: page.name.clone(), background: page.background.clone(),
            guides: vec![], children: vec![parent.to_owned()] }],
        nodes: Default::default(), fonts: Default::default(), animations: vec![],
    };
    for id in &group.children {
        let Some(node) = doc.nodes.get(id) else { return false; };
        if !node.children.is_empty() || node.kind == "text" || node.boolean_operation.is_some() ||
            node.network.as_ref().is_some_and(|net| net.edges.len()>512) ||
            node.vector_geometry.as_ref().is_some_and(|geometry|geometry.fill.len()>512) { return false; }
        total = total.saturating_add(geometry_items(node));
        if total > 4096 { return false; }
        let mut copy = node.clone();
        if id == operand { copy.transform = pose; }
        island.nodes.insert(id.clone(),copy);
    }
    island.nodes.insert(parent.to_owned(),group.clone());
    if resolve(&mut island).is_err() { return false; }
    let next=&island.nodes[parent];
    if next.network != group.network || next.vector_geometry != group.vector_geometry { return false; }
    // PartialEq collapses signed zero. Keep the same serialized coordinate bits
    // for the no-damage receipt as for geometry/packet identity.
    let shape = |n: &crate::scene::Node| serde_json::to_vec(&(&n.network,&n.vector_geometry)).ok();
    shape(next).is_some_and(|encoded| shape(group).as_ref()==Some(&encoded))
}
#[cfg(test)]
mod memo_tests {
    use super::*;
    #[test]
    fn union_keeps_opposite_winding_holes_in_one_operand() {
        fn rect(path: &mut Path, lo: f64, hi: f64, reverse: bool) {
            let corners = if reverse { [(lo,lo), (lo,hi), (hi,hi), (hi,lo)] }
                else { [(lo,lo), (hi,lo), (hi,hi), (lo,hi)] };
            for (i,(x,y)) in corners.into_iter().enumerate() {
                let p = Point::new(x,y);
                path.commands.push(if i == 0 { Command::Move(p) } else { Command::Line(p) });
            }
            path.commands.push(Command::Close);
        }
        for (inner_reversed, evenodd, contours) in [(true,false,2), (false,false,1), (false,true,2)] {
            let mut path = Path::default();
            rect(&mut path, 0., 20., false);
            rect(&mut path, 5., 15., inner_reversed);
            let inputs = [(path, Transform::default(), evenodd)];
            let curves = [curves(&inputs[0].0, inputs[0].1).unwrap()];
            assert_eq!(clip_paths(&curves,&inputs,Operation::Union,100).unwrap().len(), contours);
        }
    }
    #[test]
    fn repeated_boolean_geometry_matches_uncached_resolution() {
        let mut nodes=serde_json::Map::new();let mut roots=Vec::new();
        for i in 0..32 {
            let id=format!("b{i}");let a=format!("a{i}");let b=format!("c{i}");roots.push(id.clone());
            nodes.insert(id.clone(),serde_json::json!({"id":id,"kind":"group","width":80,"height":80,"booleanOperation": (["union","subtract","intersect","exclude"][i%4]),"children":[a,b]}));
            for (id,x) in [(a,0.),(b,20.125)] {nodes.insert(id.clone(),serde_json::json!({"id":id,"kind":"ellipse","width":48,"height":48,"transform":[1,0,0,1,x,0]}));}
        }
        let mut fast:Document=serde_json::from_value(serde_json::json!({"schemaVersion":5,"id":"d","name":"memo","pages":[{"id":"p","name":"p","background":"#ffffff","children":roots}],"nodes":nodes})).unwrap();
        let mut reference=fast.clone();resolve_cached(&mut fast,true).unwrap();resolve_cached(&mut reference,false).unwrap();
        assert_eq!(serde_json::to_vec(&fast).unwrap(),serde_json::to_vec(&reference).unwrap());
    }
    #[test]
    fn persistent_memo_is_geometry_exact_across_material_edits() {
        let mut doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":16,"id":"d","name":"cache","pages":[{"id":"p","name":"p","background":"#ffffff","children":["b"]}],"nodes":{
            "b":{"id":"b","kind":"vector","width":80,"height":80,"booleanOperation":"union","children":["a","c"]},
            "a":{"id":"a","kind":"ellipse","width":48,"height":48},"c":{"id":"c","kind":"ellipse","width":48,"height":48,"transform":[1,0,0,1,20.125,0]}}})).unwrap();
        RESOLUTION_MEMO.with(|memo|*memo.borrow_mut()=Default::default());
        resolve(&mut doc).unwrap();let initial=doc.nodes["b"].network.clone();
        doc.nodes.get_mut("a").unwrap().opacity=0.375;
        resolve(&mut doc).unwrap();assert_eq!(doc.nodes["b"].network,initial);
        assert!(RESOLUTION_MEMO.with(|memo|memo.borrow().hits)>0);
        let mut reference=doc.clone();doc.nodes.get_mut("c").unwrap().transform.0[4]+=7.;reference.nodes.get_mut("c").unwrap().transform.0[4]+=7.;
        resolve(&mut doc).unwrap();resolve_cached(&mut reference,false).unwrap();assert_eq!(doc,reference);assert_ne!(doc.nodes["b"].network,initial);
    }
    #[test]
    fn dense_render_boolean_retains_source_and_rejects_dense_intersection_storms() {
        use crate::vector_geometry::{Curve,VectorGeometry};
        let mut fill=vec![Curve::Move([0.,0.])];
        for side in 0..4 {for step in 1..=2200 {let t=step as f64/2200.;fill.push(Curve::Line(match side {0=>[40.*t,0.],1=>[40.,40.*t],2=>[40.*(1.-t),40.],_=>[0.,40.*(1.-t)]}));}}
        fill.push(Curve::Close);let geometry=VectorGeometry{fill_rule:"nonzero".into(),fill,stroke:None};
        let mut doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":16,"id":"d","name":"dense","pages":[{"id":"p","name":"p","background":"#ffffff","children":["b"]}],"nodes":{
            "b":{"id":"b","kind":"vector","width":40,"height":40,"booleanOperation":"union","children":["a"]},
            "a":{"id":"a","kind":"vector","width":40,"height":40,"vectorGeometry":geometry}}})).unwrap();
        doc.validate().unwrap();let source=doc.nodes["a"].clone();resolve(&mut doc).unwrap();doc.validate().unwrap();
        assert_eq!(doc.nodes["a"],source);assert!(doc.nodes["b"].boolean_operation.is_some());assert!(doc.nodes["b"].vector_geometry.is_some());
        let path=doc.nodes["b"].paths().unwrap().0;
        let input=source.paths().unwrap().0;
        // Dense representation takes the same established clipping algebra as
        // a four-edge rectangle, retaining the original source independently.
        let simple=Path{commands:vec![Command::Move(Point::new(0.,0.)),Command::Line(Point::new(40.,0.)),Command::Line(Point::new(40.,40.)),Command::Line(Point::new(0.,40.)),Command::Close], ..Path::default()};
        let expected=combine(&[(simple,Transform::default(),false)],Operation::Union).unwrap();
        assert_eq!(path.control_bounds(Transform::default()),expected.paths().unwrap().0.control_bounds(Transform::default()));
        assert!(combine(&[(input,Transform::default(),false)],Operation::Union).is_err(),"point-editing path keeps its original segment limit");
        let storm=vec![(Coord2(0.,0.),vec![(Coord2(0.,1.),Coord2(1.,0.),Coord2(1.,1.));9000])];
        assert!(admit_dense_paths(&[storm]).unwrap_err().contains("work budget"));
    }

    #[test]
    fn source_segment_count_matches_curve_expansion_and_closure() {
        use crate::path::SmoothCorner;
        let origin = Point::default();
        let explicit = Path { commands: vec![
            Command::Move(origin), Command::Line(Point::new(10., 0.)),
            Command::Line(origin), Command::Close,
        ], ..Path::default() };
        let implicit = Path { commands: vec![
            Command::Move(origin), Command::Line(Point::new(10., 0.)), Command::Close,
        ], ..Path::default() };
        assert_eq!(source_segment_count(&explicit).unwrap(), 2);
        assert_eq!(source_segment_count(&implicit).unwrap(), 2);
        let mut multiple = explicit.clone(); multiple.commands.extend(implicit.commands.clone());
        assert_eq!(source_segment_count(&multiple).unwrap(), 4);
        let cubic = Path { commands: vec![Command::Move(origin),
            Command::Quad(Point::new(2., 3.), Point::new(5., 0.)),
            Command::Cubic(Point::new(6., 1.), Point::new(6., 2.), origin), Command::Close], ..Path::default() };
        let smooth = Path { commands: vec![Command::Move(origin),
            Command::SmoothCorner(SmoothCorner { center: origin, radius: 5., power: 4., quadrant: 1 }), Command::Close], ..Path::default() };
        let arcs = [0., std::f64::consts::FRAC_PI_2, -std::f64::consts::TAU].map(|sweep| Path {
            commands: vec![Command::Move(Point::new(5., 0.)), Command::Arc {
                center: origin, radius: Point::new(5., 5.), start: 0., sweep,
            }, Command::Close],
            ..Path::default()
        });
        for path in [explicit, implicit, multiple, cubic, smooth].into_iter().chain(arcs) {
            let actual: usize = curves(&path, Transform::default()).unwrap().iter().map(|(_, pieces)| pieces.len()).sum();
            assert_eq!(source_segment_count(&path).unwrap(), actual);
        }
    }

    fn legacy_ring_document(segments: usize) -> Document {
        let vertices: Vec<_> = (0..segments).map(|i| {
            let angle = std::f64::consts::TAU * i as f64 / segments as f64;
            serde_json::json!({"id": i.to_string(), "x": 100. + 100. * angle.cos(), "y": 100. + 100. * angle.sin()})
        }).collect();
        let edges: Vec<_> = (0..segments).map(|i| serde_json::json!({
            "id": i.to_string(), "from": i.to_string(), "to": ((i + 1) % segments).to_string(),
        })).collect();
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 15, "id": "legacy", "name": "legacy segment limit",
            "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["result"]}],
            "nodes": {
                "result": {"id": "result", "kind": "vector", "width": 200, "height": 200,
                    "booleanOperation": "union", "children": ["source"]},
                "source": {"id": "source", "kind": "vector", "width": 200, "height": 200,
                    "network": {"vertices": vertices, "edges": edges, "fillRule": "nonzero"}},
            },
        })).unwrap()
    }

    #[test]
    fn old_schema_accepts_8191_and_8192_source_segments_despite_move_and_close() {
        for segments in [8191, 8192] {
            let mut doc = legacy_ring_document(segments);
            doc.validate().unwrap();
            let source = doc.nodes["source"].clone();
            let path = source.paths().unwrap().0;
            assert!(path.commands.len() > 8192, "this must hit the former false dense route");
            assert_eq!(source_segment_count(&path).unwrap(), segments);
            resolve_cached(&mut doc, false).unwrap();
            doc.validate().unwrap();
            assert_eq!(doc.schema_version, 15);
            assert_eq!(doc.nodes["source"], source);
            assert!(doc.nodes["result"].vector_geometry.is_none());
            assert!(!doc.nodes["result"].network.as_ref().unwrap().edges.is_empty());
        }
    }

    #[test]
    fn old_schema_still_rejects_8193_actual_source_segments_without_mutation() {
        let mut doc = legacy_ring_document(8193);
        doc.validate().unwrap();
        let before = doc.clone();
        assert!(resolve_cached(&mut doc, false).unwrap_err().contains("requires schema 16"));
        assert_eq!(doc, before);
    }

}
