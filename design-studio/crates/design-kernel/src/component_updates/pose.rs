//! A document-pose proof over the derivation owner's already validated model.
//! This does not authorize pixel/geometry cache reuse. Render invalidation and
//! fresh affine rasterization still consume the ordinary changed document.
use crate::{editing::DocumentPatch, layout::{self,Flow,SizeMode}, scene::{Document,Node}};

fn ordinary(n:&Node)->bool {
    n.component.is_none() && !n.component_set && n.component_key.is_none() && n.instance.is_none() &&
        n.instance_origin.is_none() && n.boolean_operation.is_none() && n.bindings.is_empty() &&
        n.style_refs.is_empty() && n.variable_modes.is_empty() && n.repeat.is_none() &&
        n.text_path.is_none() && n.connector.is_none() && n.board.is_none() &&
        n.vector_brush.is_none() && n.path_offset==0. &&
        n.layout.as_ref().is_none_or(|l|l.mode==Flow::None) &&
        n.sizing.as_ref().is_none_or(|s|s.width==SizeMode::Fixed&&s.height==SizeMode::Fixed)
}
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
    // New schemas must explicitly extend this proof. Unknown/global edges and
    // changing dimensions/topology retain the existing authoritative resolver.
    if doc.schema_version>21 || !patch.fields.is_empty() || patch.nodes.is_empty() || patch.nodes.len()>16 ||
        !doc.animations.is_empty() || doc.prototype.is_some() {return Ok(false)}
    for(id,next)in &patch.nodes {
        let (Some(old),Some(next))=(doc.nodes.get(id),next)else{return Ok(false)};
        if !old.children.is_empty() || old.kind=="text" || !ordinary(next) || !transform_only(old,next)? {return Ok(false)}
    }
    if doc.nodes.values().any(|n|n.connector.is_some() || n.text_path.is_some() || n.repeat.is_some() ||
        n.board.is_some() || n.mask_chain.is_some() || n.mask&&n.mask_type.as_deref()==Some("shape") ||
        n.instance.as_ref().is_some_and(|i|!i.slot_contents.is_empty())) {return Ok(false)}
    let parents=super::parents(doc);
    let candidate=|id:&str|patch.nodes.get(id).and_then(Option::as_ref).unwrap_or(&doc.nodes[id]);
    for id in patch.nodes.keys() {
        for id in super::ancestors(id,&parents) {
            let node=candidate(&id);let parent=parents.get(&id).map(|p|candidate(p));
            if !ordinary(node) || !layout::pose_constraint_fixed(node,parent,parent.is_none()) {return Ok(false)}
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
                8=>doc.nodes.get_mut("paint").unwrap().text_path=Some(serde_json::from_value(json!({"network":{"vertices":[],"edges":[],"fillRule":"nonzero"},"offset":0})).unwrap()),
                _=>doc.schema_version=22,
            }
            assert!(!eligible(&doc,&patch(n)).unwrap(),"case {case}");
        }
        let mut n=base.nodes["mask"].clone();n.transform.0[4]+=5.;let mut p=patch(n);p.fields.insert("name".into(),json!("changed"));
        assert!(!eligible(&base,&p).unwrap());
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
