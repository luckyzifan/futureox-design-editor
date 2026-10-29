//! Shared immutable device geometry; compilation owns cache mutation, renderers
//! consume the prepared paths/bounds without borrowing fonts or document caches.
use crate::{
    font::Fonts,
    math::{Rect, Transform},
    path::Contour,
    scene::{Document, Node},
    stroke,
};
use std::{collections::HashMap, sync::Arc};
fn account_segments(total:&mut usize,additional:usize)->Result<(),String>{
    let next=total.checked_add(additional).ok_or("Scene path address overflow")?;
    if next>crate::capacity::scene_path_limit(){return Err("Scene path budget exceeded".into());}
    *total=next;Ok(())
}
pub(crate) fn effect_halo(n: &Node, m: Transform) -> i32 {
    n.effect_outset(m.max_scale()).ceil() as i32
}
#[derive(Clone)]
pub(crate) struct Prepared {
    pub(crate) fill_bounds: Option<crate::bounds::Bounds>,
    pub(crate) matrix: Transform,
    pub(crate) fill: Arc<Vec<Contour>>,
    pub(crate) fill_program_bounds:Rect,
    pub(crate) strokes: Vec<Arc<Vec<Contour>>>,
    pub(crate) stroke_program_bounds:Vec<Rect>,
    pub(crate) bounds: Rect,
    pub(crate) halo: i32,
    /// Complete subtree count, including cached children, for the same admission budget.
    pub(crate) segments: usize,
}
pub(crate) fn prepare_node_geometry(
    id: &str,
    parent: Transform,
    context: (&Document, &Fonts, Rect, bool),
    paths: &mut HashMap<String, crate::path::SharedPaths>,
    local_strokes: &mut crate::resident_strokes::ResidentStrokes,
    prepared: &mut HashMap<String, Prepared>,
    segments: &mut usize,
) -> Result<Rect, String> {
    crate::render_cancellation::checkpoint()?;
    if let Some(cached) = prepared.get(id) {
        account_segments(segments,cached.segments)?;
        return Ok(cached.bounds);
    }
    let start_segments = *segments;
    let (doc, fonts, guard, compatible) = context;
    let n = &doc.nodes[id];
    if !n.visible {
        return Ok(Rect::default());
    }
    let matrix = parent.concat(n.transform);
    if matrix.0.iter().any(|v| !v.is_finite() || v.abs() > 1e12) {
        return Err("Composed transform exceeds precision budget".into());
    }
    let scale = matrix.max_scale().max(1e-6);
    // A neutral clipped frame cannot expose any descendant outside its own
    // clip. Reject the whole branch before shaping text/building paths in it.
    // The guard already contains the caller's complete backdrop/effect halo.
    if n.kind == "frame" && n.clip && !n.mask && n.blend == "normal"
        && n.effects.iter().all(|effect| !effect.visible)
    {
        let (fill, stroke_path) = n.paths()?;
        let padding = (n.strokes.iter().filter(|s| s.visible)
            .map(|s| stroke::maximum_width(s) * 4. * scale).fold(0., f64::max)).ceil() as i32;
        let bound = fill.control_bounds(matrix).union(stroke_path.control_bounds(matrix))
            .expand(padding.saturating_add(2));
        if bound.intersect(guard).empty() {
            prepared.insert(id.to_owned(), Prepared { fill_bounds: None, matrix,
                fill: Arc::new(Vec::new()), fill_program_bounds:Rect::default(),strokes: Vec::new(),stroke_program_bounds:Vec::new(), bounds: Rect::default(), halo: 0, segments: 0 });
            return Ok(Rect::default());
        }
    }
    if !paths.contains_key(id) {
        let p = if n.kind == "text" {
            crate::path::LocalPaths::Text(fonts.node_path_shared(n)?)
        } else {
            crate::path::LocalPaths::Owned(n.paths()?)
        };
        paths.insert(id.to_owned(), Arc::new(p));
    }
    let (fill_path, stroke_path) = paths[id].pair();
    let conservative = fill_path
        .control_bounds(matrix)
        .union(stroke_path.control_bounds(matrix));
    // Reject in floating point before conversion or padding arithmetic.
    let halo_value = n.effect_outset(scale);
    // Bounds/flattening guards allocate no pixels. Limit their coordinates,
    // and let the renderer admit the actual intersecting effect surfaces.
    if !halo_value.is_finite() || halo_value.ceil() > 16_000_000. {
        return Err("Effect expansion exceeds device coordinate budget".into());
    }
    let own_halo = halo_value.ceil() as i32;
    let padding = own_halo
        .saturating_add(
            n.strokes
                .iter()
                .filter(|s| s.visible)
                .map(|s| stroke::maximum_width(s) * 4. * scale)
                .fold(0., f64::max)
                .ceil() as i32,
        )
        .saturating_add(2);
    if n.children.is_empty() && conservative.expand(padding).intersect(guard).empty() {
        prepared.insert(
            id.to_owned(),
            Prepared {
                fill_bounds: None,
                matrix,
                fill: Arc::new(Vec::new()),
                fill_program_bounds:Rect::default(),
                strokes: Vec::new(),
                stroke_program_bounds:Vec::new(),
                bounds: Rect::default(),
                halo: 0,
                segments: 0,
            },
        );
        return Ok(Rect::default());
    }
    let fill = fill_path.flatten_for_fill(
        matrix,
        if compatible {
            0.0001220703125
        } else {
            0.015625
        },
        guard,
    )?;
    let mut bound = Rect::from_points(fill.iter().flat_map(|p| p.points.iter().copied()));
    let fill_program_bounds=bound.expand(1);
    let mut strokes = Vec::new();
    let mut stroke_program_bounds=Vec::new();
    for s in &n.strokes {
        if !s.visible || s.width <= 0. {
            strokes.push(Arc::new(Vec::new()));
            stroke_program_bounds.push(Rect::default());
            continue;
        }
        let local=local_strokes.get(&paths[id],s,(0.125/scale).min(1.),0.125/scale)?;
        let mut outline = (*local).clone();
        for c in &mut outline {
            for p in &mut c.points {
                *p = matrix.point(*p);
            }
        }
        let stroke_bounds=Rect::from_points(
            outline.iter().flat_map(|c| c.points.iter().copied()),
        );
        bound=bound.union(stroke_bounds);stroke_program_bounds.push(stroke_bounds.expand(1));
        strokes.push(Arc::new(outline));
    }
    let fill_bounds = crate::bounds::path_bounds(fill_path, matrix);
    let own = bound;
    let mut child_bounds = Rect::default();
    for child in n.render_children() {
        child_bounds = child_bounds.union(prepare_node_geometry(
            child, matrix, context, paths, local_strokes, prepared, segments,
        )?);
    }
    if n.clip && !own.empty() {
        child_bounds = child_bounds.intersect(own);
    }
    bound = bound.union(child_bounds);
    let halo = own_halo;
    if !bound.empty() {
        bound = bound.expand(halo + 2);
    }
    for contour in fill.iter().chain(strokes.iter().flat_map(|s|s.iter())) {account_segments(segments,contour.points.len())?;}
    let halo = halo.saturating_add(n.children
            .iter()
            .filter_map(|id| prepared.get(id))
            .map(|p| p.halo)
            .max()
            .unwrap_or(0));
    // This is geometry metadata, not a surface allocation. Actual CPU/GPU
    // admission happens after regional dependency clipping.
    if halo > 16_000_000 {
        return Err("Nested effect expansion exceeds device coordinate budget".into());
    }
    prepared.insert(
        id.to_owned(),
        Prepared {
            fill_bounds,
            matrix,
            fill: Arc::new(fill),
            fill_program_bounds,
            strokes,
            stroke_program_bounds,
            bounds: bound,
            halo,
            segments: *segments - start_segments,
        },
    );
    Ok(bound)
}

#[cfg(test)]
mod source_capacity_tests {
    use super::*;
    #[test]
    #[cfg(not(target_arch="wasm32"))]
    fn native_sources_count_every_path_without_the_ordinary_two_million_quota(){
        let mut count=2_000_000;
        assert_eq!(account_segments(&mut count,1).unwrap_err(),"Scene path budget exceeded");
        crate::capacity::with_source_storage_scope(true,||{
            account_segments(&mut count,3_000_000).unwrap();assert_eq!(count,5_000_000);
            count=usize::MAX;assert_eq!(account_segments(&mut count,1).unwrap_err(),"Scene path address overflow");
        });
        let mut normal=2_000_000;assert!(account_segments(&mut normal,1).is_err());
    }
}
