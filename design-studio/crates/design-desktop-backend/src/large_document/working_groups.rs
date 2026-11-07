//! Exact authored group placement in the independent source working copy.
//! Sketch's rigid frame codec is an export boundary, not a persistence format.
use super::*;
use futureox_design_kernel::{math::{Point, Transform}, scene::{Document, Node}, sketch::geometry::frame_placement};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(super) struct Placement {
    pub part: usize,
    pub base: Transform,
    pub transform: Transform,
    pub width: f64,
    pub height: f64,
}
pub(super) type Placements = BTreeMap<String, Placement>;

pub(super) fn source<'a>(state:&'a State, part:usize, id:&str)->Option<&'a Placement> {
    state.group_placements.get(id).filter(|p|p.part==part).or_else(||
        state.group_placements.iter().find(|(key,p)|p.part==part&&key.eq_ignore_ascii_case(id)).map(|(_,p)|p))
}

pub(super) fn retained_bytes(values: &Placements) -> usize {
    values.iter().map(|(id,_)|id.len()+std::mem::size_of::<Placement>()+96).sum()
}
pub(super) fn validate(values: &Placements, parts: usize) -> Result<()> {
    for (id, value) in values {
        if id.is_empty() || id.len()>1024 || value.part>=parts ||
            !value.transform.0.iter().all(|v|v.is_finite()) ||
            ![value.width,value.height].iter().all(|v|v.is_finite()&&*v>=0.) ||
            frame_placement(value.base,value.width,value.height).is_none() {
            return Err(issue("Invalid working-copy group placement"));
        }
    }
    Ok(())
}
fn supported(node: &Node) -> bool {
    node.kind=="group" && node.component.is_none() && node.instance.is_none()
}

/// A converted window may contain a referenced master from another part.
/// Admission requires a globally unique source ID; shared dependencies receive
/// the same authored placement before ordinary scene merging and page layout.
pub(super) fn apply(s: &Session, document: &mut Document) -> Result<()> {
    for (id, placement) in &s.state.group_placements {
        if let Some(node)=document.nodes.get_mut(id) {
            if !supported(node) { return Err(issue("Working-copy group owner changed")); }
            node.transform=placement.transform;
        }
    }
    if !s.state.group_placements.is_empty() { document.validate().map_err(issue)?; }
    Ok(())
}

/// Only the codec views remove an unrepresentable group matrix. Authored
/// documents keep their exact f64 matrices. Other field guards still run on
/// the existing Sketch codec, and only a successful checkpoint publishes it.
pub(super) fn codec_views(s: &Session, part: usize, changed: &[(String, usize)],
    before: &Document, after: &Document, next: &mut State) -> Result<Option<(Document,Document)>> {
    let mut views: Option<(Document,Document)>=None;
    for (id, _) in changed {
        let old=&before.nodes[id];let new=&after.nodes[id];
        let prior=s.state.group_placements.get(id);
        let rigid=frame_placement(new.transform,new.width,new.height).is_some();
        if prior.is_none() && (!supported(new) || rigid) { continue; }
        if !supported(old) || !supported(new) || prior.is_some_and(|p|p.part!=part) {
            return Err(issue("Working-copy group owner changed"));
        }
        let owners=s.parts.iter().enumerate().flat_map(|(p,part)|part.index.entries.iter()
            .filter(move|entry|entry.id.eq_ignore_ascii_case(id)).map(move|entry|(p,entry.kind.as_str())))
            .collect::<Vec<_>>();
        if owners!=[(part,"group")] { return Err(issue("Working-copy group source identity is ambiguous")); }
        let base=prior.map(|p|p.base).unwrap_or(old.transform);
        if frame_placement(base,old.width,old.height).is_none() {
            return Err(issue("Working-copy group has no rigid source baseline"));
        }
        let (a,b)=views.get_or_insert_with(||(before.clone(),after.clone()));
        a.nodes.get_mut(id).unwrap().transform=base;
        if rigid {
            // Returning to a representable placement resumes the ordinary
            // source field codec. Undo-to-source removes the overlay entirely.
            next.group_placements.remove(id);
        } else {
            b.nodes.get_mut(id).unwrap().transform=base;
            next.group_placements.insert(id.clone(),Placement {part,base,transform:new.transform,
                width:new.width,height:new.height});
        }
    }
    Ok(views)
}

pub(super) fn bounds(value: &Placement) -> Result<canvas_layout::Box2> {
    let corners=[Point::new(0.,0.),Point::new(value.width,0.),Point::new(0.,value.height),Point::new(value.width,value.height)]
        .map(|p|value.transform.point(p));
    let x=corners.iter().map(|p|p.x).fold(f64::INFINITY,f64::min);
    let y=corners.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
    let width=corners.iter().map(|p|p.x).fold(f64::NEG_INFINITY,f64::max)-x;
    let height=corners.iter().map(|p|p.y).fold(f64::NEG_INFINITY,f64::max)-y;
    if ![x,y,width,height].iter().all(|v|v.is_finite()) { return Err(issue("Working-copy bounds are not representable")); }
    Ok(canvas_layout::Box2 {x,y,width,height})
}
