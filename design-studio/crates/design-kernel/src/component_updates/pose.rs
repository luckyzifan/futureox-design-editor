//! A document-pose proof over the derivation owner's already validated model.
//! This does not authorize pixel/geometry cache reuse. Render invalidation and
//! fresh affine rasterization still consume the ordinary changed document.
use crate::{editing::DocumentPatch, layout::{self,Flow,SizeMode}, scene::{Document,Node}};

fn dependency_free(n:&Node)->bool {
    n.component.is_none() && !n.component_set && n.component_key.is_none() && n.instance.is_none() &&
        n.instance_origin.is_none() && n.boolean_operation.is_none() && n.bindings.is_empty() &&
        n.style_refs.is_empty() && n.variable_modes.is_empty() && n.repeat.is_none() &&
        n.text_path.is_none() && n.connector.is_none() && n.board.is_none() &&
        n.vector_brush.is_none() && n.path_offset==0.
}
fn ordinary(n:&Node)->bool {
    dependency_free(n) &&
        n.layout.as_ref().is_none_or(|l|l.mode==Flow::None) &&
        n.sizing.as_ref().is_none_or(|s|s.width==SizeMode::Fixed&&s.height==SizeMode::Fixed)
}
/// The moved node may keep children, effects, masks and its own flow. Those do
/// not rewrite its transform when width and height stay put. Ancestors still
/// use `ordinary`: an auto-layout parent would reflow this node.
fn pose_subject(n:&Node)->bool { dependency_free(n) }
fn transform_only(old:&Node,next:&Node)->Result<bool,String> {
    if old.derived_path.is_some() || next.derived_path.is_some() || old.repeat_origin.is_some() || next.repeat_origin.is_some() {
        return Ok(false);
    }
    // These wire-skipped scalars can hide a signed-zero change. All other
    // authored values use their exact canonical JSON, including -0 and f64.
    if old.path_offset.to_bits()!=next.path_offset.to_bits() || old.corner_radius.to_bits()!=next.corner_radius.to_bits() ||
        old.strokes.len()!=next.strokes.len() || old.effects.len()!=next.effects.len() ||
        old.strokes.iter().zip(&next.strokes).any(|(a,b)|a.dash_offset.to_bits()!=b.dash_offset.to_bits()) ||
        old.effects.iter().zip(&next.effects).any(|(a,b)|a.motion_angle.to_bits()!=b.motion_angle.to_bits()) {return Ok(false)}
    let mut candidate=old.clone();candidate.transform=next.transform;
    Ok(serde_json::to_vec(&candidate).map_err(|e|e.to_string())?==serde_json::to_vec(next).map_err(|e|e.to_string())?)
}
pub(super) fn eligible(doc:&Document,patch:&DocumentPatch)->Result<bool,String> {
    // New schemas must explicitly extend this proof. Changing dimensions,
    // topology, or a dependency that full resolution would rewrite still
    // retains the authoritative resolver. An unrelated connector, text path,
    // repeat, board, mask or slot does not.
    if doc.schema_version>21 || !patch.fields.is_empty() || patch.nodes.is_empty() || patch.nodes.len()>16 ||
        !doc.animations.is_empty() || doc.prototype.is_some() {return Ok(false)}
    for(id,next)in &patch.nodes {
        let (Some(old),Some(next))=(doc.nodes.get(id),next)else{return Ok(false)};
        if old.kind=="text" || !pose_subject(next) || !transform_only(old,next)? {return Ok(false)}
    }
    let patched:std::collections::BTreeSet<&str>=patch.nodes.keys().map(String::as_str).collect();
    for node in doc.nodes.values() {
        if let Some(connector)=&node.connector {
            let attached=|id:&Option<String>| id.as_deref().is_some_and(|id| patched.contains(id));
            if attached(&connector.from.node_id) || attached(&connector.to.node_id) {return Ok(false)}
        }
        // Highlighting rewrites text runs of a code block's children. A
        // transform of some other node does not.
        if node.board.as_ref().is_some_and(|board| board.kind=="code-block")
            && node.children.iter().any(|id| patched.contains(id.as_str())) {return Ok(false)}
    }
    let parents=super::parents(doc);
    let candidate=|id:&str|patch.nodes.get(id).and_then(Option::as_ref).unwrap_or(&doc.nodes[id]);
    for id in patch.nodes.keys() {
        for (index,id) in super::ancestors(id,&parents).into_iter().enumerate() {
            let node=candidate(&id);let parent=parents.get(&id).map(|p|candidate(p));
            let fixed=layout::pose_constraint_fixed(node,parent,parent.is_none());
            // Ancestors with flow would recompute this node's local transform.
            // The moved node's own flow only places its children from its size.
            let allowed=if index==0 {pose_subject(node)} else {ordinary(node)};
            if !allowed || !fixed {return Ok(false)}
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{component_updates::{State,resolve_full},font::Fonts,math::Transform};
    use std::collections::BTreeMap;
    use serde_json::json;
    fn fixture()->Document {
        serde_json::from_value(json!({"schemaVersion":21,"id":"pose","name":"pose validation",
            "pages":[{"id":"p","name":"page","children":["board","master","instance"],"background":"#ffffff"}],
            "nodes":{
                "board":{"id":"board","kind":"frame","width":600,"height":400,"children":["mask","paint"]},
                "mask":{"id":"mask","kind":"rectangle","width":40,"height":30,"mask":true,"maskType":"alpha","transform":[1,0,0,1,20,30],
                    "constraints":{"horizontal":"scale","vertical":"center","referenceWidth":600,"referenceHeight":400}},
                "paint":{"id":"paint","kind":"rectangle","width":100,"height":100},
                "master":{"id":"master","kind":"frame","width":80,"height":80,"children":["child"],"component":{}},
                "child":{"id":"child","kind":"rectangle","width":20,"height":20},
                "instance":{"id":"instance","kind":"frame","width":80,"height":80,"instance":{"componentId":"master","overrides":{},"propertyValues":{}}}
            }})).unwrap()
    }
    fn patch(node:Node)->DocumentPatch {DocumentPatch{nodes:BTreeMap::from([(node.id.clone(),Some(node))]),fields:BTreeMap::new()}}
    #[test]
    fn mask_pose_matches_full_resolve_bit_for_bit_with_cold_components_and_history_returns() {
        let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
        let base=state.document.as_ref().unwrap().clone();
        for i in 0..32 {
            let angle=(i as f64-16.)/19.;let(s,c)=angle.sin_cos();
            let mut next=base.nodes["mask"].clone();next.transform=Transform([c,s,-s,c,20.+i as f64,30.-i as f64/7.]);
            if i==31 {next=base.nodes["mask"].clone();}
            let mut oracle=state.document.as_ref().unwrap().clone();oracle.nodes.insert("mask".into(),next.clone());resolve_full(&mut oracle,&fonts).unwrap();
            let reply:serde_json::Value=serde_json::from_str(&state.patch_pose(&serde_json::to_string(&patch(next)).unwrap(),state.receipt,&fonts).unwrap()).unwrap();
            assert_eq!(reply["stats"]["pose"],true);assert_eq!(reply["stats"]["layoutRoots"],0);assert_eq!(reply["nodes"],json!({}));
            assert_eq!(serde_json::to_vec(state.document.as_ref().unwrap()).unwrap(),serde_json::to_vec(&oracle).unwrap());
            assert_eq!(state.ledger.as_ref().unwrap().bytes(),serde_json::to_vec(&oracle).unwrap().len());
        }
        assert_eq!(serde_json::to_vec(state.document.as_ref().unwrap()).unwrap(),serde_json::to_vec(&base).unwrap());
    }
    #[test]
    fn invalid_pose_and_stale_receipt_do_not_change_model_bytes_or_accounting() {
        let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
        let before=serde_json::to_vec(state.document.as_ref().unwrap()).unwrap();let receipt=state.receipt;let bytes=state.ledger.as_ref().unwrap().bytes();
        let mut n=state.document.as_ref().unwrap().nodes["mask"].clone();n.transform.0[4]=1e12;
        assert!(state.patch_pose(&serde_json::to_string(&patch(n)).unwrap(),receipt,&fonts).is_err());
        assert_eq!(serde_json::to_vec(state.document.as_ref().unwrap()).unwrap(),before);assert_eq!(state.receipt,receipt);assert_eq!(state.ledger.as_ref().unwrap().bytes(),bytes);
        assert_eq!(state.patch_pose("{}",receipt-1,&fonts).unwrap_err(),"DERIVED_STATE_STALE");
    }
    #[test]
    fn topology_other_fields_signed_zero_constraints_and_global_edges_decline_the_proof() {
        let base=fixture();
        for case in 0..10 {
            let mut doc=base.clone();let mut n=doc.nodes["mask"].clone();n.transform.0[4]+=5.;
            match case {
                0=>n.opacity=0.5,
                1=>n.path_offset=-0.,
                2=>n.corner_radius=-0.,
                3=>n.children.push("paint".into()),
                4=>n.constraints.as_mut().unwrap().reference_width=Some(300.),
                5=>doc.nodes.get_mut("board").unwrap().layout=Some(serde_json::from_value(json!({"mode":"horizontal"})).unwrap()),
                6=>doc.nodes.get_mut("board").unwrap().sizing=Some(serde_json::from_value(json!({"width":"hug"})).unwrap()),
                7=>doc.nodes.get_mut("board").unwrap().boolean_operation=Some(crate::boolean::Operation::Union),
                // An unrelated text path is not a dependency of this transform.
                8=>{
                    doc.nodes.get_mut("paint").unwrap().kind="text".into();
                    doc.nodes.get_mut("paint").unwrap().text_path=Some(serde_json::from_value(json!({"network":{"vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":40,"y":0}],"edges":[{"id":"e","from":"a","to":"b"}]},"offset":0})).unwrap());
                    assert!(eligible(&doc,&patch(n)).unwrap(),"unrelated text path");
                    continue
                }
                _=>doc.schema_version=22,
            }
            assert!(!eligible(&doc,&patch(n)).unwrap(),"case {case}");
        }
        let mut n=base.nodes["mask"].clone();n.transform.0[4]+=5.;let mut p=patch(n);p.fields.insert("name".into(),json!("changed"));
        assert!(!eligible(&base,&p).unwrap());
    }
    fn with_global_edges() -> Document {
        let mut doc = fixture();
        doc.nodes.get_mut("mask").unwrap().effects = serde_json::from_value(json!([{"kind":"shadow","radius":8,"x":2,"y":3,"spread":0,"color":"#204060","opacity":0.85}])).unwrap();
        let paint = doc.nodes.get_mut("paint").unwrap();
        paint.mask = true;
        paint.mask_type = Some("shape".into());
        doc.nodes.get_mut("child").unwrap().repeat = serde_json::from_value(json!({"count":3,"translation":{"x":12,"y":0},"pivot":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}})).unwrap();
        let wire: Node = serde_json::from_value(json!({"id":"wire","kind":"vector","width":40,"height":10,"connector":{"from":{"point":{"x":0,"y":0}},"to":{"point":{"x":40,"y":0}},"style":"straight"}})).unwrap();
        doc.pages[0].children.push(wire.id.clone());
        doc.nodes.insert(wire.id.clone(), wire);
        doc
    }
    fn prove_pose(doc: Document, id: &str) {
        let fonts = Fonts::new();
        let mut state = State::default();
        state.full(&serde_json::to_string(&doc).unwrap(), &fonts).unwrap();
        let mut next = state.document.as_ref().unwrap().nodes[id].clone();
        next.transform = Transform([0., 1., -1., 0., next.transform.0[4] + 15., next.transform.0[5] + 4.]);
        let mut oracle = state.document.as_ref().unwrap().clone();
        oracle.nodes.insert(id.into(), next.clone());
        resolve_full(&mut oracle, &fonts).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&state.patch_pose(&serde_json::to_string(&patch(next)).unwrap(), state.receipt, &fonts).unwrap()).unwrap();
        assert_eq!(reply["stats"]["pose"], true, "{id}");
        assert_eq!(reply["nodes"], json!({}));
        assert_eq!(serde_json::to_vec(state.document.as_ref().unwrap()).unwrap(), serde_json::to_vec(&oracle).unwrap(), "{id}");
    }
    #[test]
    fn parent_pose_and_unrelated_edges_match_full_resolve_but_attached_connectors_decline() {
        let doc = with_global_edges();
        prove_pose(doc.clone(), "mask");
        prove_pose(doc.clone(), "board");
        let mut flowed = doc.clone();
        flowed.nodes.get_mut("board").unwrap().layout = Some(serde_json::from_value(json!({"mode":"horizontal"})).unwrap());
        prove_pose(flowed, "board");
        let mut attached = doc;
        attached.nodes.get_mut("wire").unwrap().connector.as_mut().unwrap().from.node_id = Some("mask".into());
        attached.nodes.get_mut("wire").unwrap().connector.as_mut().unwrap().from.anchor = Some(crate::math::Point::new(0.5, 0.5));
        let mut moved = attached.nodes["mask"].clone();
        moved.transform.0[4] += 5.;
        assert!(!eligible(&attached, &patch(moved)).unwrap());
    }
    #[test]
    fn changed_font_inputs_and_declined_ledger_keep_authoritative_resolution() {
        let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
        let mut n=state.document.as_ref().unwrap().nodes["mask"].clone();n.transform.0[4]+=3.;
        let mut changed=fonts.clone();changed.set_glyph_origin_quantization(true);
        let reply:serde_json::Value=serde_json::from_str(&state.patch_pose(&serde_json::to_string(&patch(n)).unwrap(),state.receipt,&changed).unwrap()).unwrap();
        assert_ne!(reply["stats"]["pose"],true);
        assert!(state.font_stamp.is_none());
        state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();state.ledger=None;
        let mut n=state.document.as_ref().unwrap().nodes["mask"].clone();n.transform.0[4]+=3.;
        let reply:serde_json::Value=serde_json::from_str(&state.patch_pose(&serde_json::to_string(&patch(n)).unwrap(),state.receipt,&fonts).unwrap()).unwrap();
        assert_ne!(reply["stats"]["pose"],true);
    }
}
