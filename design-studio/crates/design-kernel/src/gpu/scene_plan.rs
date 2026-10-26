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
    /// Parent ID and one opaque solid colour shared by every contributing leaf.
    /// GPU adapters still certify the actual uploaded four-sample programs.
    pub opaque_solid_groups: Vec<(String,String)>,
    /// Consecutive opaque runs, in original painter order; no sorting by color.
    pub opaque_solid_runs: Vec<(String,usize,usize,String)>,
    /// A subtree can execute each correlated sample independently only when
    /// no descendant consumes a mask, clip, effect or pass-through backdrop.
    pub sample_independent_nodes: Vec<String>,
    /// The same validated postorder also builds recursive resource identities.
    /// It is native preparation state, not another browser-side graph.
    #[serde(skip)]
    pub(crate) source_order: Result<Vec<String>,String>,
}
#[derive(Deserialize)]
struct PaintInput { #[serde(default)] kind: String, image: Option<String>, #[serde(default)] color:String,
    #[serde(default)] visible:bool, #[serde(default)] opacity:f64, #[serde(default)] blend:String }
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
    #[serde(default)] opacity:f64,#[serde(default)] blend:String,#[serde(default)] clip:bool,
    #[serde(default)] mask:bool,mask_id:Option<String>,#[serde(default)] passthrough:bool,fill:Option<PathInput>,
}
#[derive(Deserialize)]#[serde(rename_all="camelCase")]
struct PathInput{sample_count:Option<u32>,area:Option<serde::de::IgnoredAny>}
fn identity() -> [f64; 6] { [1.,0.,0.,1.,0.,0.] }
struct NodePlan<'a> { children: &'a [String], matrix: [f64;6], effects: Vec<EffectPlan<'a>>, replay: bool, images: Vec<(u8,usize)>,opaque_solid:Option<&'a str>,sample_independent:bool }
fn opaque_hex(value:&str)->bool{value.len()==7&&value.starts_with('#')&&value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)}
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
    let source_order=(|| {
        let mut states=BTreeMap::<&str,u8>::new();let mut order=Vec::new();
        for root in nodes.keys() {
            let mut stack=vec![(*root,false)];
            while let Some((id,exit))=stack.pop(){
                if exit{states.insert(id,2);order.push(id.to_owned());continue;}
                match states.get(id){Some(2)=>continue,Some(1)=>return Err("Cyclic compiled scene".to_owned()),_=>{}}
                let Some(node)=nodes.get(id)else{continue};states.insert(id,1);stack.push((id,true));
                stack.extend(node.children.iter().rev().filter(|child|nodes.contains_key(child.as_str())).map(|child|(child.as_str(),false)));
            }
        }
        Ok(order)
    })();
    let mut independent=BTreeSet::new();
    if let Ok(order)=&source_order {
        for id in order {let node=&nodes[id.as_str()];
            if node.sample_independent&&node.children.iter().all(|id|!nodes.contains_key(id.as_str())||independent.contains(id)) {
                independent.insert(id.clone());
            }
        }
    }
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
    let mut opaque_solid_groups=Vec::new();
    for (&id,parent) in &nodes {
        let children=parent.children.iter().filter_map(|id|nodes.get(id.as_str())).collect::<Vec<_>>();
        if children.len()<8{continue;}
        if let Some(color)=children[0].opaque_solid {
            if children.iter().all(|child|child.opaque_solid==Some(color)) {opaque_solid_groups.push((id.to_owned(),color.to_owned()));}
        }
    }
    let mut opaque_solid_runs=Vec::new();
    for (&id,parent) in &nodes {
        let colors=parent.children.iter().map(|id|nodes.get(id.as_str()).and_then(|n|n.opaque_solid)).collect::<Option<Vec<_>>>();
        let Some(colors)=colors else{continue};
        let mut runs=Vec::new();let mut start=0;
        while start<colors.len(){let mut end=start+1;while end<colors.len()&&colors[end]==colors[start]{end+=1;}
            runs.push((id.to_owned(),start,end,colors[start].to_owned()));start=end;}
        if runs.len()>1&&runs.iter().all(|(_,start,end,_)|end-start>=8){opaque_solid_runs.extend(runs);}
    }
    ScenePlan {version:1,nodes:order.into_iter().map(str::to_owned).collect(),roots:roots.to_vec(),parents:parents.into_iter().collect(),
        root_for:root_for.into_iter().collect(),unknown_effect_subtrees:propagated.into_iter().collect(),image_uses:uses,features,opaque_solid_groups,opaque_solid_runs,
        sample_independent_nodes:independent.into_iter().collect(),source_order}
}
impl GpuScene {
    pub fn scene_plan(&self) -> ScenePlan {
        build(&self.roots,self.nodes.iter().map(|(id,n)| (id.as_str(),NodePlan {children:&n.children,matrix:n.matrix.0,effects:n.effects.iter().map(|e|EffectPlan {kind:&e.kind,visible:e.visible,radius:e.radius,glass:e.glass.is_some()}).collect(),
            sample_independent:!n.passthrough&&!n.mask&&n.mask_id.as_ref().is_none_or(String::is_empty)&&!n.clip&&!n.effects.iter().any(|e|e.visible),
            opaque_solid:if n.opacity==1.&&n.blend=="normal"&&!n.clip&&!n.mask&&!n.passthrough&&n.children.is_empty()&&n.strokes.is_empty()&&
                n.effects.iter().all(|e|!e.visible)&&n.texture_replay.is_none()&&n.fill.sample_count==Some(4)&&n.fill.area.is_some()&&n.fills.len()==1&&
                n.fills[0].visible&&n.fills[0].kind=="solid"&&n.fills[0].blend=="normal"&&n.fills[0].opacity==1.&&opaque_hex(&n.fills[0].color)
                {Some(n.fills[0].color.as_str())}else{None},
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
        sample_independent:!n.passthrough&&!n.mask&&n.mask_id.as_ref().is_none_or(String::is_empty)&&!n.clip&&!n.effects.iter().any(|e|e.visible),
        opaque_solid:if n.opacity==1.&&n.blend=="normal"&&!n.clip&&!n.mask&&!n.passthrough&&n.children.is_empty()&&n.strokes.is_empty()&&n.effects.iter().all(|e|!e.visible)&&
            n.texture_replay.is_none()&&n.fill.as_ref().is_some_and(|p|p.sample_count==Some(4)&&p.area.is_some())&&n.fills.len()==1&&
            n.fills[0].visible&&n.fills[0].kind=="solid"&&n.fills[0].blend=="normal"&&n.fills[0].opacity==1.&&opaque_hex(&n.fills[0].color)
            {Some(n.fills[0].color.as_str())}else{None},
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

#[cfg(test)]
mod opaque_group_tests {
    use super::*;
    use serde_json::{json,Value};
    fn scene()->Value {
        let mut nodes=serde_json::Map::new();
        for i in 0..8 {nodes.insert(i.to_string(),json!({"opacity":1,"blend":"normal",
            "fill":{"sampleCount":4,"area":{"first":0,"count":7}},
            "fills":[{"kind":"solid","color":"#2b74ff","visible":true,"opacity":1,"blend":"normal"}]}));}
        nodes.insert("parent".into(),json!({"children":(0..8).map(|i|i.to_string()).collect::<Vec<_>>()}));
        json!({"roots":["parent"],"nodes":nodes})
    }
    fn groups(scene:&Value)->Value {serde_json::from_str::<Value>(&from_json(&scene.to_string()).unwrap()).unwrap()["opaqueSolidGroups"].clone()}
    #[test] fn native_group_requires_every_leaf_to_be_the_same_opaque_solid() {
        assert_eq!(groups(&scene()),json!([["parent","#2b74ff"]]));
        for (path,value) in [
            ("/nodes/0/opacity",json!(0.5)),("/nodes/0/blend",json!("multiply")),
            ("/nodes/0/fill/sampleCount",json!(16)),("/nodes/0/fill/area",Value::Null),
            ("/nodes/0/fills/0/color",json!("#2b74fe")),("/nodes/0/fills/0/color",json!("#2b74ff80")),
            ("/nodes/0/fills/0/opacity",json!(0.9)),("/nodes/0/fills/0/visible",json!(false)),
            ("/nodes/0/fills/0/kind",json!("gradient")),("/nodes/0/fills/0/blend",json!("screen")),
        ] {let mut s=scene();*s.pointer_mut(path).unwrap()=value;assert_eq!(groups(&s),json!([]),"{path}");}
        for (key,value) in [("clip",json!(true)),("mask",json!(true)),("passthrough",json!(true)),
            ("textureReplay",json!({})),("children",json!(["other"])),
            ("effects",json!([{"kind":"unknown","visible":true}])),
            ("strokes",json!([{"paint":{"kind":"solid"}}]))] {
            let mut s=scene();s["nodes"]["0"][key]=value;assert_eq!(groups(&s),json!([]),"{key}");
        }
        let mut s=scene();s["nodes"]["parent"]["children"].as_array_mut().unwrap().pop();assert_eq!(groups(&s),json!([]));
    }
}

#[cfg(test)]
mod sample_plan_tests {
    use super::*;
    use serde_json::{json,Value};
    #[test] fn consecutive_opaque_colors_keep_painter_order_and_reject_short_or_effectful_runs(){
        let ids=(0..24).map(|i|format!("n{i}")).collect::<Vec<_>>();
        let mut nodes=serde_json::Map::new();
        nodes.insert("root".into(),json!({"children":ids}));
        for (i,id) in ids.iter().enumerate(){nodes.insert(id.clone(),json!({"opacity":1,"blend":"normal","fill":{"sampleCount":4,"area":{}},
            "fills":[{"kind":"solid","color":if (8..16).contains(&i){"#0000ff"}else{"#ff0000"},"visible":true,"opacity":1,"blend":"normal"}]}));}
        let mut scene=json!({"roots":["root"],"nodes":nodes});
        let runs=|s:&Value|serde_json::from_str::<Value>(&from_json(&s.to_string()).unwrap()).unwrap()["opaqueSolidRuns"].clone();
        assert_eq!(runs(&scene),json!([["root",0,8,"#ff0000"],["root",8,16,"#0000ff"],["root",16,24,"#ff0000"]]));
        scene["nodes"]["n8"]["opacity"]=json!(0.5);assert_eq!(runs(&scene),json!([]));
    }
    fn independent(scene:&Value)->Value {
        serde_json::from_str::<Value>(&from_json(&scene.to_string()).unwrap()).unwrap()["sampleIndependentNodes"].clone()
    }
    #[test]
    fn every_descendant_dependency_blocks_its_ancestors_only() {
        let scene=json!({"roots":["root"],"nodes":{
            "root":{"children":["branch","sibling","missing"]},
            "branch":{"children":["leaf"]},"leaf":{},"sibling":{},"detached":{}}});
        assert_eq!(independent(&scene),json!(["branch","detached","leaf","root","sibling"]));
        for patch in [json!({"mask":true}),json!({"maskId":"owner"}),json!({"clip":true}),
            json!({"passthrough":true}),json!({"effects":[{"kind":"blur","visible":true}]}),
            json!({"effects":[{"kind":"future","visible":true}]})] {
            let mut changed=scene.clone();changed["nodes"]["leaf"]=patch;
            assert_eq!(independent(&changed),json!(["detached","sibling"]));
        }
        let mut invisible=scene.clone();invisible["nodes"]["leaf"]=json!({"maskId":"","effects":[{"kind":"future","visible":false}]});
        assert_eq!(independent(&invisible),independent(&scene));
    }
    #[test]
    fn postorder_is_shared_and_iterative_and_cycles_cannot_prove_independence() {
        let children=(0..10000).map(|i|if i+1<10000{vec![(i+1).to_string()]}else{vec![]}).collect::<Vec<_>>();
        let ids=(0..children.len()).map(|i|i.to_string()).collect::<Vec<_>>();
        let make=|children:&Vec<Vec<String>>|build(&[ids[0].clone()],ids.iter().enumerate().map(|(i,id)|(id.as_str(),NodePlan{
            children:&children[i],matrix:identity(),effects:vec![],replay:false,images:vec![],opaque_solid:None,sample_independent:true})).collect());
        let plan=make(&children);assert_eq!(plan.sample_independent_nodes.len(),10000);
        let order=plan.source_order.unwrap();assert_eq!(order.first(),Some(&ids[9999]));assert_eq!(order.last(),Some(&ids[0]));
        let mut cyclic=children;cyclic[9999].push(ids[0].clone());let plan=make(&cyclic);
        assert_eq!(plan.source_order.unwrap_err(),"Cyclic compiled scene");assert!(plan.sample_independent_nodes.is_empty());
    }
}
