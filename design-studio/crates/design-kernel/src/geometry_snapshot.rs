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
fn subtree_effect_halo(doc: &Document, node: &Node, matrix: Transform) -> i32 {
    let mut halo = effect_halo(node, matrix);
    for child_id in node.render_children() {
        let Some(child) = doc.nodes.get(child_id) else { continue };
        if !child.visible { continue; }
        halo = halo.max(subtree_effect_halo(doc, child, matrix.concat(child.transform)));
    }
    halo
}
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
    pub(crate) support_culled: bool,
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
impl Prepared {
    pub(crate) fn culled(matrix: Transform, fill: Arc<Vec<Contour>>) -> Self {
        Self { support_culled: false, fill_bounds: None, matrix, fill,
            fill_program_bounds: Rect::default(), strokes: Vec::new(), stroke_program_bounds: Vec::new(),
            bounds: Rect::default(), halo: 0, segments: 0 }
    }
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
    prepare_node_geometry_impl(id,parent,context,paths,local_strokes,prepared,segments,true)
}
fn prepare_node_geometry_impl(
    id: &str, parent: Transform, context: (&Document, &Fonts, Rect, bool),
    paths: &mut HashMap<String, crate::path::SharedPaths>,
    local_strokes: &mut crate::resident_strokes::ResidentStrokes,
    prepared: &mut HashMap<String, Prepared>, segments: &mut usize, early: bool,
) -> Result<Rect, String> {
    prepare_node_geometry_supported::<false>(id,parent,context,paths,local_strokes,prepared,segments,early,None,None)
}
pub(crate) fn prepare_node_geometry_indexed(
    id:&str,parent:Transform,context:(&Document,&Fonts,Rect,bool),
    paths:&mut HashMap<String,crate::path::SharedPaths>,local_strokes:&mut crate::resident_strokes::ResidentStrokes,
    prepared:&mut HashMap<String,Prepared>,segments:&mut usize,support:Option<&crate::world_support::WorldSupport>,
) -> Result<Rect,String>{
    prepare_node_geometry_supported::<false>(id,parent,context,paths,local_strokes,prepared,segments,true,support.map(|index|(index,parent)),None)
}
pub(crate) fn prepare_cpu_frame_geometry(
    id: &str, camera: Transform, context: (&Document, &Fonts, Rect, bool),
    paths: &mut HashMap<String, crate::path::SharedPaths>, strokes: &mut crate::resident_strokes::ResidentStrokes,
    prepared: &mut HashMap<String, Prepared>, segments: &mut usize, reuse: &mut crate::cpu_frame_plan::FrameGeometry,
) -> Result<Rect, String> {
    prepare_node_geometry_supported::<true>(id, camera, context, paths, strokes, prepared, segments, true, None, Some(reuse))
}
fn prepare_node_geometry_supported<const FRAME: bool>(
    id:&str,parent:Transform,context:(&Document,&Fonts,Rect,bool),
    paths:&mut HashMap<String,crate::path::SharedPaths>,local_strokes:&mut crate::resident_strokes::ResidentStrokes,
    prepared:&mut HashMap<String,Prepared>,segments:&mut usize,early:bool,
    support:Option<(&crate::world_support::WorldSupport,Transform)>,
    mut reuse:Option<&mut crate::cpu_frame_plan::FrameGeometry>,
) -> Result<Rect,String>{
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
    if FRAME && let Some(hit) = reuse.as_deref().and_then(|cache| cache.get(n, matrix, guard)) {
        account_segments(segments, hit.segments)?;
        let bounds = hit.bounds;
        prepared.insert(id.to_owned(), hit);
        return Ok(bounds);
    }
    let scale = matrix.max_scale().max(1e-6);
    if support.is_some_and(|(index,camera)|index.culls(id,camera,guard)) {
        prepared.insert(id.to_owned(),Prepared{support_culled:true,fill_bounds:None,matrix,fill:Arc::new(Vec::new()),
            fill_program_bounds:Rect::default(),strokes:Vec::new(),stroke_program_bounds:Vec::new(),bounds:Rect::default(),halo:0,segments:0});
        return Ok(Rect::default());
    }
    if early && !paths.contains_key(id) {
        if let Some(bounds) = crate::geometry_support::leaf_control_bounds(n,matrix) {
            let halo = n.effect_outset(scale);
            let stroke = n.strokes.iter().filter(|s|s.visible)
                .map(|s|stroke::maximum_width(s)*4.*scale).fold(0.,f64::max);
            if halo.is_finite() && halo.ceil() <= 16_000_000. && stroke.is_finite() {
                let padding=(halo.ceil() as i32).saturating_add(stroke.ceil() as i32).saturating_add(2);
                if bounds.expand(padding).intersect(guard).empty() {
                    prepared.insert(id.to_owned(),Prepared{support_culled:false,fill_bounds:None,matrix,fill:Arc::new(Vec::new()),
                        fill_program_bounds:Rect::default(),strokes:Vec::new(),stroke_program_bounds:Vec::new(),
                        bounds:Rect::default(),halo:0,segments:0});
                    return Ok(Rect::default());
                }
            }
        }
    }
    // A clipped frame cannot expose descendants outside its own clip. The
    // prepare guard already contains the page's effect halo, so a frame box
    // that misses the guard also misses with its own shadow or blur. Stroke
    // padding is not part of that halo. Reject the branch before shaping text.
    if n.kind == "frame" && n.clip && !n.mask && n.blend == "normal"
        && n.boolean_operation.is_none()
    {
        if let Some(bounds) = crate::geometry_support::primitive_device_box(n, matrix) {
            let stroke = n.strokes.iter().filter(|s| s.visible)
                .map(|s| stroke::maximum_width(s) * 4. * scale).fold(0., f64::max);
            if stroke.is_finite() {
                let padding = (stroke.ceil() as i32).saturating_add(2);
                // Descendant effects can extend past the clip by their own
                // device halo. The box already misses the guard; add that
                // reach before skipping the branch.
                if bounds.expand(padding).intersect(guard).empty() {
                    let reach = subtree_effect_halo(doc, n, matrix);
                    if bounds.expand(padding.saturating_add(reach)).intersect(guard).empty() {
                        if FRAME && let Some(cache) = reuse.as_deref_mut() { cache.cull(n, matrix, bounds); }
                        prepared.insert(id.to_owned(), Prepared { support_culled:false,fill_bounds: None, matrix,
                            fill: Arc::new(Vec::new()), fill_program_bounds:Rect::default(),strokes: Vec::new(),stroke_program_bounds:Vec::new(), bounds: Rect::default(), halo: 0, segments: 0 });
                        return Ok(Rect::default());
                    }
                }
            }
        }
    }
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
            if FRAME && let Some(cache) = reuse.as_deref_mut() { cache.cull(n, matrix, bound); }
            prepared.insert(id.to_owned(), Prepared { support_culled:false,fill_bounds: None, matrix,
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
    let support_bounds = if n.children.is_empty() { conservative.expand(padding) } else { Rect::default() };
    if n.children.is_empty() && support_bounds.intersect(guard).empty() {
        if FRAME && let Some(cache) = reuse.as_deref_mut() { cache.cull(n, matrix, support_bounds); }
        prepared.insert(
            id.to_owned(),
            Prepared {
                support_culled:false,
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
    let mut fill = fill_path.flatten_for_fill(
        matrix,
        if compatible {
            0.0001220703125
        } else {
            0.015625
        },
        guard,
    )?;
    // Analytic Sketch text uses a FreeType mask. Figma profiles keep the
    // outlines; WASM has no FreeType and also keeps them.
    if !compatible {
        if let Some(mask) = crate::font_splash::sketch_device_mask(n, fonts, matrix) {
            fill = mask;
        }
    }
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
        child_bounds = child_bounds.union(prepare_node_geometry_supported::<FRAME>(
            child, matrix, context, paths, local_strokes, prepared, segments, early,support,reuse.as_deref_mut(),
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
            support_culled:false,
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
    if FRAME && n.children.is_empty() && !(n.kind == "frame" && n.clip)
        && let Some(cache) = reuse {
        cache.shape(n, support_bounds, guard, paths[id].pair().0, &prepared[id]);
    }
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

#[cfg(test)]
mod early_support_tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Document {
        let mut doc:Document=serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"support",
            "pages":[{"id":"p","name":"p","children":[],"background":"#ffffff"}],"nodes":{}})).unwrap();
        let node:Node=serde_json::from_value(json!({"id":"n","kind":"vector","width":20,"height":20,
            "fills":[{"kind":"solid","color":"#123456"}],
            "vectorGeometry":{"fillRule":"nonzero","fill":[{"move":[0.,0.]},{"cubic":[-2.,6.,24.,6.,20.,20.]},{"line":[0.,20.]},"close"]}})).unwrap();
        for i in 0..1001 {
            let mut n=node.clone();n.id=format!("n{i}");
            n.transform=Transform([1.,0.,0.,1.,if i==0 {0.}else{10000.+i as f64*24.},0.]);
            doc.pages[0].children.push(n.id.clone());doc.nodes.insert(n.id.clone(),n);
        }
        doc
    }
    fn prepare(doc:&Document,camera:Transform,guard:Rect,early:bool)->(HashMap<String,Prepared>,usize){
        let fonts=Fonts::new();let mut paths=HashMap::new();let mut strokes=Default::default();let mut prepared=HashMap::new();let mut segments=0;
        for root in &doc.pages[0].children {
            prepare_node_geometry_impl(root,camera,(doc,&fonts,guard,true),&mut paths,&mut strokes,&mut prepared,&mut segments,early).unwrap();
        }
        (prepared,paths.len())
    }
    #[test]
    fn distant_authored_curves_do_not_materialize_paths_and_keep_exact_prepared_output(){
        let doc=fixture();
        let (reference,old_paths)=prepare(&doc,Transform::default(),Rect::new(-1,-1,66,66),false);
        let (candidate,new_paths)=prepare(&doc,Transform::default(),Rect::new(-1,-1,66,66),true);
        assert_eq!(old_paths,1001);assert_eq!(new_paths,1);
        for (id,a) in reference {let b=&candidate[&id];assert_eq!(a.bounds,b.bounds);assert_eq!(a.matrix,b.matrix);
            assert_eq!(a.halo,b.halo);assert_eq!(a.segments,b.segments);
            assert_eq!(serde_json::to_vec(&*a.fill).unwrap(),serde_json::to_vec(&*b.fill).unwrap());}
    }
    #[test]
    fn transformed_curve_and_shadow_neighbourhoods_keep_the_original_geometry(){
        let mut doc=fixture();doc.pages[0].children.truncate(1);doc.nodes.retain(|id,_|id=="n0");
        let n=doc.nodes.get_mut("n0").unwrap();
        n.effects=serde_json::from_value(json!([{"kind":"shadow","radius":8,"x":12,"y":-3,"color":"#000000"}])).unwrap();
        for x in [-60.,-30.,-12.5,0.,63.5,90.] {for angle in [-0.4_f64,0.,0.7] {
            let camera=Transform([angle.cos(),angle.sin(),-angle.sin(),angle.cos(),x,12.375]);
            let (a,_)=prepare(&doc,camera,Rect::new(-1,-1,66,66),false);
            let (b,_)=prepare(&doc,camera,Rect::new(-1,-1,66,66),true);
            assert_eq!(a["n0"].bounds,b["n0"].bounds);
            assert_eq!(serde_json::to_vec(&*a["n0"].fill).unwrap(),serde_json::to_vec(&*b["n0"].fill).unwrap());
        }}
    }
    #[test]
    fn a_distant_clip_frame_with_a_shadow_does_not_build_descendant_paths() {
        let mut doc: Document = serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"support",
            "pages":[{"id":"p","name":"p","children":["frame"],"background":"#ffffff"}],"nodes":{}})).unwrap();
        let mut frame: Node = serde_json::from_value(json!({"id":"frame","kind":"frame","width":100,"height":80,"clip":true,
            "effects":[{"kind":"shadow","visible":true,"radius":8,"x":4,"y":6,"color":"#000000"}]})).unwrap();
        frame.children.push("child".into());
        frame.transform = Transform([1., 0., 0., 1., 5000., 5000.]);
        let child: Node = serde_json::from_value(json!({"id":"child","kind":"rectangle","width":40,"height":20})).unwrap();
        doc.nodes.insert(frame.id.clone(), frame);
        doc.nodes.insert(child.id.clone(), child);
        let (prepared, paths) = prepare(&doc, Transform::default(), Rect::new(0, 0, 64, 64), true);
        assert_eq!(paths, 0, "descendant geometry was built");
        assert!(prepared["frame"].fill.is_empty());
        assert!(prepared["frame"].bounds.empty());
    }
}
