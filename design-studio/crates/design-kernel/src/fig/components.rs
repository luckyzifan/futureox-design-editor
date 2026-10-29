//! Resolve native component GUIDs only after the complete template tree exists.
use super::{Error, FigImporter, bool_of, guid_string, str_of};
use crate::{components::{Component, Instance, Property, PropertyKind}, scene::Document};
use serde_json::Value;
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
pub(super) fn import(doc: &mut Document, records: &BTreeMap<String,Value>, importer: &FigImporter) -> Result<(),Error> {
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
                other=>return Err(Error::Unsupported(format!("component property type {other:?}"))),
            };
            let key=def.get("id").map(guid_string).ok_or_else(||Error::Malformed("component property id missing".into()))?;
            let field=match kind {PropertyKind::Boolean=>"VISIBLE",PropertyKind::Text=>"TEXT_DATA",PropertyKind::InstanceSwap=>"OVERRIDDEN_SYMBOL_ID"};
            let targets:Vec<_>=descendants.iter().filter(|target| records.get(*target).is_some_and(|r| {
                r.get("componentPropRefs").and_then(Value::as_array).into_iter().flatten().any(|reference| {
                    !bool_of(reference,"isDeleted").unwrap_or(false) && reference.get("defID").map(guid_string).as_ref()==Some(&key)
                        && str_of(reference,"componentPropNodeField")==Some(field)
                })
            })).collect();
            if targets.len()!=1 {return Err(Error::Unsupported(format!("component property {key} has {} targets; requires one explicit componentPropRef",targets.len())));}
            let target=&doc.nodes[targets[0]];
            let default_value=property_value(&kind,&def["initialValue"]).ok_or_else(||Error::Unsupported(format!("component property {key} has no literal default")))?;
            properties.insert(key.clone(),Property {name:str_of(def,"name").unwrap_or(&key).into(),kind,
                target_key:target.component_key.as_ref().unwrap_or(&target.id).clone(),default_value});
        }
        doc.nodes.get_mut(id).unwrap().component=Some(Component {properties,..Default::default()});
    }
    for (id,record) in records.iter().filter(|(_,r)|str_of(r,"type")==Some("INSTANCE")) {
        if !doc.nodes.contains_key(id) {continue;}
        let Some(sd)=record.get("symbolData") else {continue;};
        let component_id=sd.get("symbolID").map(guid_string).ok_or_else(||Error::Malformed("instance symbolID missing".into()))?;
        let component=doc.nodes.get(&component_id).and_then(|n|n.component.as_ref())
            .ok_or_else(||Error::Unsupported(format!("instance {id} has no embedded main component {component_id}")))?;
        let mut property_values=BTreeMap::new();
        for assignment in record.get("componentPropAssignments").or_else(||sd.get("componentPropAssignments")).and_then(Value::as_array).into_iter().flatten() {
            let key=assignment.get("defID").map(guid_string).ok_or_else(||Error::Malformed("property assignment defID missing".into()))?;
            let property=component.properties.get(&key).ok_or_else(||Error::Unsupported(format!("unknown component property assignment {key}")))?;
            let value=property_value(&property.kind,&assignment["value"]).ok_or_else(||Error::Unsupported(format!("component property assignment {key} requires a literal value")))?;
            property_values.insert(key,value);
        }
        let mut overrides=BTreeMap::new();
        for ov in sd.get("symbolOverrides").and_then(Value::as_array).into_iter().flatten() {
            let path=ov.get("guidPath").and_then(|v|v.get("guids")).and_then(Value::as_array)
                .map(|gs|gs.iter().map(guid_string).collect::<Vec<_>>().join("/"))
                .or_else(||ov.get("overrideKey").map(guid_string)).unwrap_or_else(||"$root".into());
            let mut fields=BTreeMap::new();
            for (key,value) in ov.as_object().into_iter().flatten() {
                match key.as_str() {
                    "guidPath"|"overrideKey"|"styleID"=>{},
                    "name"|"visible"|"opacity"|"fontSize"=>{fields.insert(key.clone(),value.clone());},
                    "textData"=>{fields.insert("text".into(),value.get("characters").cloned().unwrap_or(Value::String(String::new())));},
                    "fillPaints"=>{
                        let mut notes=Vec::new();
                        let fills:Vec<_>=value.as_array().into_iter().flatten().filter_map(|p|importer.paint(p,&mut notes)).collect();
                        fields.insert("fills".into(),serde_json::to_value(fills).unwrap());
                    },
                    "symbolID"=>{fields.insert("swapComponent".into(),Value::String(guid_string(value)));},
                    other=>return Err(Error::Unsupported(format!("component override {other}"))),
                }
            }
            overrides.insert(path,fields);
        }
        doc.nodes.get_mut(id).unwrap().instance=Some(Instance {component_id,overrides,property_values,slot_contents:Default::default()});
    }
    Ok(())
}
