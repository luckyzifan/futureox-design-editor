//! Resolve native component GUIDs only after the complete template tree exists.
use super::{Error, FigImporter, bool_of, guid_string, str_of};
use crate::{components::{Component, Instance, Property, PropertyKind}, scene::Document};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn property_value(kind: &PropertyKind, value: &Value) -> Option<Value> {
    match kind {
        PropertyKind::Boolean => value.get("boolValue").filter(|v|v.is_boolean()).cloned(),
        PropertyKind::Text => value.pointer("/textValue/characters").filter(|v|v.is_string()).cloned(),
        PropertyKind::InstanceSwap => value.get("guidValue").map(|v|Value::String(guid_string(v))),
    }
}
fn descendants(doc: &Document, root: &str) -> Result<Vec<String>, Error> {
    let mut pending=doc.nodes[root].children.clone();let mut seen=BTreeSet::new();let mut out=Vec::new();
    while let Some(id)=pending.pop() {
        if !seen.insert(id.clone()) {return Err(Error::Malformed("cyclic component template".into()));}
        if let Some(n)=doc.nodes.get(&id) {
            if n.instance.is_none() {pending.extend(n.children.clone());}
            out.push(id);
        }
    }
    Ok(out)
}
pub(super) fn import(doc: &mut Document, records: &BTreeMap<String,Value>, importer: &FigImporter, notes: &mut Vec<String>) -> Result<(),Error> {
    // Keys are definition GUIDs throughout. Human-facing names are labels only.
    for (id, record) in records.iter().filter(|(_,r)|str_of(r,"type")==Some("SYMBOL")) {
        if !doc.nodes.contains_key(id) {continue;}
        let descendants=descendants(doc,id)?;
        let mut properties=BTreeMap::new();
        for def in record.get("componentPropDefs").and_then(Value::as_array).into_iter().flatten() {
            if bool_of(def,"isDeleted").unwrap_or(false) {continue;}
            let kind=match str_of(def,"type") {
                Some("BOOL")=>PropertyKind::Boolean,Some("TEXT")=>PropertyKind::Text,
                Some("INSTANCE_SWAP")=>PropertyKind::InstanceSwap,
                // Variant axes belong to the component set, not a layer binding.
                Some("VARIANT")=>continue,
                other=>return Err(Error::Unsupported(format!("component property type {other:?}"))),
            };
            let key=def.get("id").map(guid_string).ok_or_else(||Error::Malformed("component property id missing".into()))?;
            let field=match kind {PropertyKind::Boolean=>"VISIBLE",PropertyKind::Text=>"TEXT_DATA",PropertyKind::InstanceSwap=>"OVERRIDDEN_SYMBOL_ID"};
            let mut targets:Vec<_>=descendants.iter().filter(|target| records.get(*target).is_some_and(|r| {
                r.get("componentPropRefs").and_then(Value::as_array).into_iter().flatten().any(|reference| {
                    !bool_of(reference,"isDeleted").unwrap_or(false) && reference.get("defID").map(guid_string).as_ref()==Some(&key)
                        && str_of(reference,"componentPropNodeField")==Some(field)
                })
            })).cloned().collect();
            let default_value=property_value(&kind,&def["initialValue"]).ok_or_else(||Error::Unsupported(format!("component property {key} has no literal default")))?;
            if targets.is_empty() {
                properties.insert(key.clone(),Property {name:str_of(def,"name").unwrap_or(&key).into(),kind,
                    target_key:String::new(),also_targets:Vec::new(),unbound:true,default_value});
                continue;
            }
            let mut parent_of=BTreeMap::<&str,&str>::new();
            for node in doc.nodes.values() {
                for child in &node.children { parent_of.insert(child.as_str(), node.id.as_str()); }
            }
            let depth=|id:&str| { let mut at=id; let mut n=0usize; while let Some(parent)=parent_of.get(at){ at=parent; n+=1; if n>64{break;} } n };
            targets.sort_by_key(|id| depth(id.as_str()));
            let primary=&doc.nodes[&targets[0]];
            let primary_key=primary.component_key.as_ref().unwrap_or(&primary.id).clone();
            let also_targets=targets[1..].iter().map(|id| {
                let node=&doc.nodes[id];
                node.component_key.as_ref().unwrap_or(&node.id).clone()
            }).collect();
            properties.insert(key.clone(),Property {name:str_of(def,"name").unwrap_or(&key).into(),kind,
                target_key:primary_key,also_targets,unbound:false,default_value});
        }
        doc.nodes.get_mut(id).unwrap().component=Some((Component {properties,..Default::default()}).into());
    }
    let mut unsupported_overrides=BTreeSet::new();
    let mut override_variables=Vec::new();
    for (id,record) in records.iter().filter(|(_,r)|str_of(r,"type")==Some("INSTANCE")) {
        if !doc.nodes.contains_key(id) {continue;}
        let Some(sd)=record.get("symbolData") else {continue;};
        let component_id=sd.get("symbolID").map(guid_string).ok_or_else(||Error::Malformed("instance symbolID missing".into()))?;
        let component=doc.nodes.get(&component_id).and_then(|n|n.component.as_ref())
            .ok_or_else(||Error::Unsupported(format!("instance {id} has no embedded main component {component_id}")))?;
        let mut property_values=BTreeMap::new();
        for assignment in record.get("componentPropAssignments").or_else(||sd.get("componentPropAssignments")).and_then(Value::as_array).into_iter().flatten() {
            let Some(key)=assignment.get("defID").map(guid_string) else {return Err(Error::Malformed("property assignment defID missing".into()));};
            let Some(property)=component.properties.get(&key) else {unsupported_overrides.insert(format!("property assignment {key}"));continue;};
            let Some(value)=property_value(&property.kind,&assignment["value"]) else {unsupported_overrides.insert(format!("property assignment {key}"));continue;};
            property_values.insert(key,value);
        }
        let mut overrides=BTreeMap::new();
        for ov in sd.get("symbolOverrides").and_then(Value::as_array).into_iter().flatten() {
            let path=ov.get("guidPath").and_then(|v|v.get("guids")).and_then(Value::as_array)
                .map(|gs|gs.iter().map(guid_string).collect::<Vec<_>>().join("/"))
                .or_else(||ov.get("overrideKey").map(guid_string)).unwrap_or_else(||"$root".into());
            let mut fields=BTreeMap::new();
            let stroke_inputs=["strokeWeight","strokeAlign","strokeCap","strokeJoin","dashPattern","borderStrokeWeightsIndependent","borderTopWeight","borderRightWeight","borderBottomWeight","borderLeftWeight"];
            for (key,value) in ov.as_object().into_iter().flatten() {
                if ov.get("strokePaints").and_then(Value::as_array).is_some() && stroke_inputs.contains(&key.as_str()) { continue; }
                match key.as_str() {
                    "guidPath"|"overrideKey"|"styleID"=>{},
                    "name"|"visible"|"opacity"|"fontSize"=>{fields.insert(key.clone(),value.clone());},
                    "textData"=>{fields.insert("text".into(),value.get("characters").cloned().unwrap_or(Value::String(String::new())));},
                    "fillPaints"=>{
                        let mut notes=Vec::new();
                        let fills:Vec<_>=value.as_array().into_iter().flatten().filter_map(|p|importer.paint(p,&mut notes)).collect();
                        fields.insert("fills".into(),serde_json::to_value(fills).unwrap());
                    },
                    "strokePaints"=>{
                        let weight=ov.get("strokeWeight").and_then(Value::as_f64).unwrap_or(1.);
                        let cap=match str_of(ov,"strokeCap") { Some("ROUND")=>"round", Some("SQUARE")=>"square", _=>"butt" };
                        let join=match str_of(ov,"strokeJoin") { Some("ROUND")=>"round", Some("BEVEL")=>"bevel", _=>"miter" };
                        let align=match str_of(ov,"strokeAlign") { Some("INSIDE")=>"inside", Some("OUTSIDE")=>"outside", _=>"center" };
                        let mut notes=Vec::new();
                        let strokes:Vec<_>=value.as_array().into_iter().flatten().filter_map(|paint| importer.paint(paint,&mut notes)).map(|paint| json!({
                            "paint":paint,"width":weight,"cap":cap,"join":join,"align":align,"dash":"","visible":true
                        })).collect();
                        fields.insert("strokes".into(),Value::Array(strokes));
                    },
                    "styleIdForFill"|"styleIdForStrokeFill"=>{
                        if key=="styleIdForFill" {
                            let id=guid_string(value.get("guid").unwrap_or(value));
                            if id!="4294967295:4294967295" && id!="0:0" && doc.design_system.as_ref().is_some_and(|system| system.styles.contains_key(&id)) {
                                let mut refs=fields.get("styleRefs").cloned().unwrap_or_else(|| json!({}));
                                if let Some(object)=refs.as_object_mut() { object.insert("fills".into(), Value::String(id)); }
                                fields.insert("styleRefs".into(), refs);
                            }
                        }
                    },
                    "symbolID"=>{fields.insert("swapComponent".into(),Value::String(guid_string(value)));},
                    "cornerRadius"=>{
                        if let Some(radius)=value.as_f64().filter(|v|v.is_finite()&&*v>=0.&&*v<=1e7) {fields.insert("cornerRadius".into(),json!(radius));}
                        else {unsupported_overrides.insert("cornerRadius".into());}
                    },
                    "size"=>{
                        let axis=|key:&str| value.get(key).and_then(Value::as_f64).filter(|v|v.is_finite()&&*v>0.&&*v<=1e7);
                        if let Some(width)=axis("x") {fields.insert("width".into(),json!(width));}
                        else if value.get("x").is_some() {unsupported_overrides.insert("size.x".into());}
                        if let Some(height)=axis("y") {fields.insert("height".into(),json!(height));}
                        else if value.get("y").is_some() {unsupported_overrides.insert("size.y".into());}
                    },
                    "rectangleTopLeftCornerRadius"|"rectangleTopRightCornerRadius"|"rectangleBottomRightCornerRadius"|"rectangleBottomLeftCornerRadius"=>{},
                    "variableConsumptionMap"=>{override_variables.push((id.clone(),path.clone(),value.clone()));},
                    other=>{unsupported_overrides.insert(other.to_string());},
                }
            }
            let corner=|key:&str| ov.get(key).and_then(Value::as_f64).filter(|v|v.is_finite()&&*v>=0.&&*v<=1e7);
            let corners=[corner("rectangleTopLeftCornerRadius"),corner("rectangleTopRightCornerRadius"),corner("rectangleBottomRightCornerRadius"),corner("rectangleBottomLeftCornerRadius")];
            if corners.iter().all(Option::is_some) {fields.insert("radii".into(),json!(corners.map(|value|value.unwrap_or(0.))));}
            else if corners.iter().any(Option::is_some) {unsupported_overrides.insert("rectangleCornerRadii".into());}
            overrides.insert(path,fields);
        }
        doc.nodes.get_mut(id).unwrap().instance=Some((Instance {component_id,overrides,property_values,slot_contents:Default::default()}).into());
        if !override_variables.is_empty() {
            let system=doc.design_system.get_or_insert_with(Default::default);
            let metadata=system.sketch_containers.entry("nodeMetadata".into()).or_insert_with(||json!({}));
            if let Some(object)=metadata.as_object_mut() {
                for (instance_id,override_path,map) in override_variables.drain(..) {
                    let entry=object.entry(instance_id).or_insert_with(||json!({"format":"fig","bindings":{}}));
                    let Some(entry)=entry.as_object_mut() else {continue;};
                    let list=entry.entry("overrideVariableConsumption").or_insert_with(||json!([]));
                    if let Some(list)=list.as_array_mut() {list.push(json!({"path":override_path,"map":map}));}
                }
            }
        }
    }
    if !unsupported_overrides.is_empty() {
        let mut names:Vec<_>=unsupported_overrides.into_iter().collect();
        names.sort();
        let extra=names.len().saturating_sub(24);
        let shown=names.into_iter().take(24).collect::<Vec<_>>().join(", ");
        let suffix=if extra>0 {format!(" and {extra} more")} else {String::new()};
        notes.push(format!("FIG component overrides without an executable field were left unchanged: {shown}{suffix}"));
    }
    Ok(())
}
