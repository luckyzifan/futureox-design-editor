//! Platform-independent topology and effect dependencies for a compiled scene.
//! The browser binds these logical IDs to its immutable nodes and GPU owners.
use super::GpuScene;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScenePlan {
    pub version: u32,
    pub nodes: Vec<String>,
    pub roots: Vec<String>,
    pub parents: Vec<(String, String)>,
    pub root_for: Vec<(String, String)>,
    pub unknown_effect_subtrees: Vec<String>,
    /// Node ID, fill/stroke/replay discriminator, paint index. No image copies.
    pub image_uses: Vec<(String, u8, usize)>,
    /// replay, filters, ordinary prefix filter, backdrop prefix filter.
    pub features: u8,
}
#[derive(Deserialize)]
struct PaintInput { #[serde(default)] kind: String, image: Option<String> }
#[derive(Deserialize)]
struct StrokeInput { paint: PaintInput }
#[derive(Deserialize)]
struct ReplayInput {}
#[derive(Deserialize)]
struct EffectInput { kind: String, #[serde(default)] visible: bool, radius: Option<f64>, glass: Option<serde::de::IgnoredAny> }
struct EffectPlan<'a> { kind: &'a str, visible: bool, radius: f64, glass: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeInput {
    #[serde(default)] children: Vec<String>,
    #[serde(default = "identity")] matrix: [f64; 6],
    #[serde(default)] effects: Vec<EffectInput>,
    #[serde(default)] fills: Vec<PaintInput>,
    #[serde(default)] strokes: Vec<StrokeInput>,
    texture_replay: Option<ReplayInput>,
}
fn identity() -> [f64; 6] { [1.,0.,0.,1.,0.,0.] }
struct NodePlan<'a> { children: &'a [String], matrix: [f64;6], effects: Vec<EffectPlan<'a>>, replay: bool, images: Vec<(u8,usize)> }
fn images<'a>(fills: impl Iterator<Item = (&'a str, Option<&'a str>)>, strokes: impl Iterator<Item = (&'a str, Option<&'a str>)>) -> Vec<(u8,usize)> {
    let mut uses = Vec::new();
    for (kind, paints) in [fills.collect::<Vec<_>>(), strokes.collect::<Vec<_>>()].into_iter().enumerate() {
        for (i,(paint,image)) in paints.into_iter().enumerate() {
            if paint == "image" && image.is_some_and(|s|!s.is_empty()) { uses.push((kind as u8,i)); }
        }
    }
    // Existing residency only loads authored fills/strokes. Replay is bound by
    // its own material owner; retain this distinction in the shared plan.
    uses
}
fn build(roots: &[String], nodes: BTreeMap<&str, NodePlan<'_>>) -> ScenePlan {
    let mut parents = BTreeMap::new(); let mut features = 0;
    let mut unknown = BTreeSet::new(); let mut uses = Vec::new();
    let mut order=nodes.keys().copied().collect::<Vec<_>>();
    let ordinal=|id:&str|id.parse::<u32>().ok().filter(|n|*n<u32::MAX&&n.to_string()==id);
    order.sort_by(|a,b|match (ordinal(a),ordinal(b)) { (Some(a),Some(b))=>a.cmp(&b), (Some(_),None)=>std::cmp::Ordering::Less,
        (None,Some(_))=>std::cmp::Ordering::Greater,(None,None)=>a.cmp(b) });
    for &id in &order { let n=&nodes[id];
        for child in n.children { parents.insert(child.clone(), id.to_owned()); }
        features |= u8::from(n.replay);
        for &(kind,index) in &n.images { uses.push((id.to_owned(),kind,index)); }
        let [a,b,c,d,_,_] = n.matrix;
        let s=a*a+b*b+c*c+d*d; let det=a*d-b*c;
        let scale=((s+(s*s-4.*det*det).max(0.).sqrt())/2.).sqrt();
        for e in n.effects.iter().filter(|e|e.visible) {
            if matches!(e.kind,"blur"|"shadow"|"inner-shadow"|"background-blur"|"glass") {features|=2;}
            if !matches!(e.kind,"shadow"|"inner-shadow"|"blur"|"background-blur"|"glass"|"noise"|"texture") {unknown.insert(id.to_owned());}
            let radius=if e.kind=="glass"&&e.glass&&!e.radius.is_nan(){e.radius.max(1.)}else{e.radius}*scale;
            if (32. ..=2048.).contains(&radius) {
                if matches!(e.kind,"blur"|"shadow"|"glass") { features|=4; }
                if e.kind=="background-blur" { features|=8; }
            }
        }
    }
    let mut root_for=BTreeMap::new();
    for root in roots { let mut stack=vec![root.as_str()]; while let Some(id)=stack.pop() {
        if root_for.contains_key(id) {continue;} root_for.insert(id.to_owned(),root.clone());
        if let Some(n)=nodes.get(id) {stack.extend(n.children.iter().map(String::as_str));}
    }}
    let mut propagated=unknown.clone();
    for id in unknown { let mut next=parents.get(&id); while let Some(parent)=next {
        if !propagated.insert(parent.clone()) {break;} next=parents.get(parent);
    }}
    ScenePlan {version:1,nodes:order.into_iter().map(str::to_owned).collect(),roots:roots.to_vec(),parents:parents.into_iter().collect(),
        root_for:root_for.into_iter().collect(),unknown_effect_subtrees:propagated.into_iter().collect(),image_uses:uses,features}
}
impl GpuScene {
    pub fn scene_plan(&self) -> ScenePlan {
        build(&self.roots,self.nodes.iter().map(|(id,n)| (id.as_str(),NodePlan {children:&n.children,matrix:n.matrix.0,effects:n.effects.iter().map(|e|EffectPlan {kind:&e.kind,visible:e.visible,radius:e.radius,glass:e.glass.is_some()}).collect(),
            replay:n.texture_replay.is_some(),images:images(n.fills.iter().map(|p|(p.kind.as_str(),p.image.as_deref())),
                n.strokes.iter().map(|s|(s.paint.kind.as_str(),s.paint.image.as_deref())))})).collect())
    }
}
/// Uncompiled synthetic/adapter scenes use the same core planner. Production
/// packets carry this plan and never serialize the scene back across the boundary.
pub fn from_json(source: &str) -> Result<String,String> {
    #[derive(Deserialize)] struct Input { roots: Vec<String>, nodes: BTreeMap<String,NodeInput> }
    let input:Input=serde_json::from_str(source).map_err(|e|e.to_string())?;
    let nodes=input.nodes.iter().map(|(id,n)|(id.as_str(),NodePlan {children:&n.children,matrix:n.matrix,effects:n.effects.iter().map(|e|EffectPlan {kind:&e.kind,visible:e.visible,radius:e.radius.unwrap_or(f64::NAN),glass:e.glass.is_some()}).collect(),
        replay:n.texture_replay.is_some(),images:images(n.fills.iter().map(|p|(p.kind.as_str(),p.image.as_deref())),
            n.strokes.iter().map(|s|(s.paint.kind.as_str(),s.paint.image.as_deref())))})).collect();
    serde_json::to_string(&build(&input.roots,nodes)).map_err(|e|e.to_string())
}

/// Canonical source semantics independent of relocatable GPU program addresses.
/// This is also the oracle for synthetic adapter scenes lacking a frame receipt.
pub fn source_value(mut value:serde_json::Value)->serde_json::Value {
    if let Some(node)=value.as_object_mut(){node.remove("previewSource");node.remove("previewDynamic");}
    fn path(p:&mut serde_json::Value){
        if let Some(p)=p.as_object_mut(){p.insert("first".into(),serde_json::json!(0));
            for key in ["area","analytic"] {if let Some(v)=p.get_mut(key).and_then(|v|v.as_object_mut()){v.insert("first".into(),serde_json::json!(0));}}
        }
    }
    path(&mut value["fill"]);
    if let Some(strokes)=value.get_mut("strokes").and_then(|v|v.as_array_mut()){for stroke in strokes{path(&mut stroke["path"]);}}
    value
}
pub fn source_key_json(source:&str)->Result<Vec<u8>,String>{
    let value=serde_json::from_str(source).map_err(|e|format!("Invalid compiled source: {e}"))?;
    super::frame_wire::encode(&source_value(value))
}
