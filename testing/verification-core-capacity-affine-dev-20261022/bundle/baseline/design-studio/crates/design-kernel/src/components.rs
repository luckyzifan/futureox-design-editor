//! Component definitions stay authored; instances are deterministically materialized.
//! Rendering, WASM editing and backend validation use the same rules.
use crate::{
    design_system::Modes,
    font::Fonts,
    layout,
    scene::{Document, Node},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub type Overrides = BTreeMap<String, BTreeMap<String, Value>>;
const DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
fn encoded_len(value: &impl Serialize, limit: usize) -> Result<usize, String> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self
                .bytes
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("component byte budget"))?;
            if self.bytes > self.limit {
                return Err(std::io::Error::other("component byte budget"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| "Expanded component document exceeds 32 MiB".to_owned())?;
    Ok(counter.bytes)
}
pub fn check_budget(doc: &Document) -> Result<(), String> {
    if has_components(doc) {
        encoded_len(doc, DOCUMENT_BYTES)?;
    }
    Ok(())
}
/// Borrow unchanged nodes while expanding into a separate result map. Keep
/// Document's own serializer authoritative for every other field, including
/// optional metadata; the budget remains the exact complete JSON byte count.
struct ResolvedDocument<'a, 'node> {
    document: &'a Document,
    nodes: &'a BTreeMap<String, Cow<'node, Node>>,
}
impl Serialize for ResolvedDocument<'_, '_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.document.serialize(NodeMapSerializer { serializer, nodes: self.nodes })
    }
}
struct NodeMapSerializer<'a, 'node, S> {
    serializer: S,
    nodes: &'a BTreeMap<String, Cow<'node, Node>>,
}
struct NodeMapStruct<'a, 'node, S> {
    serializer: S,
    nodes: &'a BTreeMap<String, Cow<'node, Node>>,
}
impl<S: serde::ser::SerializeStruct> serde::ser::SerializeStruct for NodeMapStruct<'_, '_, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), S::Error> {
        if key == "nodes" {
            self.serializer.serialize_field(key, self.nodes)
        } else {
            self.serializer.serialize_field(key, value)
        }
    }
    fn skip_field(&mut self, key: &'static str) -> Result<(), S::Error> {
        self.serializer.skip_field(key)
    }
    fn end(self) -> Result<S::Ok, S::Error> { self.serializer.end() }
}
macro_rules! delegate_scalar_serializers {
    ($($name:ident($value:ty)),* $(,)?) => {
        $(fn $name(self, value: $value) -> Result<Self::Ok, Self::Error> {
            self.serializer.$name(value)
        })*
    };
}
impl<'a, 'node, S: serde::Serializer> serde::Serializer for NodeMapSerializer<'a, 'node, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = S::SerializeSeq;
    type SerializeTuple = S::SerializeTuple;
    type SerializeTupleStruct = S::SerializeTupleStruct;
    type SerializeTupleVariant = S::SerializeTupleVariant;
    type SerializeMap = S::SerializeMap;
    type SerializeStruct = NodeMapStruct<'a, 'node, S::SerializeStruct>;
    type SerializeStructVariant = S::SerializeStructVariant;
    delegate_scalar_serializers!(
        serialize_bool(bool), serialize_i8(i8), serialize_i16(i16), serialize_i32(i32),
        serialize_i64(i64), serialize_i128(i128), serialize_u8(u8), serialize_u16(u16),
        serialize_u32(u32), serialize_u64(u64), serialize_u128(u128), serialize_f32(f32),
        serialize_f64(f64), serialize_char(char), serialize_str(&str), serialize_bytes(&[u8]),
    );
    fn serialize_none(self) -> Result<S::Ok, S::Error> { self.serializer.serialize_none() }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<S::Ok, S::Error> { self.serializer.serialize_some(value) }
    fn serialize_unit(self) -> Result<S::Ok, S::Error> { self.serializer.serialize_unit() }
    fn serialize_unit_struct(self, name: &'static str) -> Result<S::Ok, S::Error> { self.serializer.serialize_unit_struct(name) }
    fn serialize_unit_variant(self, name: &'static str, index: u32, variant: &'static str) -> Result<S::Ok, S::Error> {
        self.serializer.serialize_unit_variant(name, index, variant)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, name: &'static str, value: &T) -> Result<S::Ok, S::Error> {
        self.serializer.serialize_newtype_struct(name, value)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(self, name: &'static str, index: u32, variant: &'static str, value: &T) -> Result<S::Ok, S::Error> {
        self.serializer.serialize_newtype_variant(name, index, variant, value)
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<S::SerializeSeq, S::Error> { self.serializer.serialize_seq(len) }
    fn serialize_tuple(self, len: usize) -> Result<S::SerializeTuple, S::Error> { self.serializer.serialize_tuple(len) }
    fn serialize_tuple_struct(self, name: &'static str, len: usize) -> Result<S::SerializeTupleStruct, S::Error> {
        self.serializer.serialize_tuple_struct(name, len)
    }
    fn serialize_tuple_variant(self, name: &'static str, index: u32, variant: &'static str, len: usize) -> Result<S::SerializeTupleVariant, S::Error> {
        self.serializer.serialize_tuple_variant(name, index, variant, len)
    }
    fn serialize_map(self, len: Option<usize>) -> Result<S::SerializeMap, S::Error> { self.serializer.serialize_map(len) }
    fn serialize_struct(self, name: &'static str, len: usize) -> Result<Self::SerializeStruct, S::Error> {
        Ok(NodeMapStruct { serializer: self.serializer.serialize_struct(name, len)?, nodes: self.nodes })
    }
    fn serialize_struct_variant(self, name: &'static str, index: u32, variant: &'static str, len: usize) -> Result<S::SerializeStructVariant, S::Error> {
        self.serializer.serialize_struct_variant(name, index, variant, len)
    }
    fn is_human_readable(&self) -> bool { self.serializer.is_human_readable() }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PropertyKind {
    Text,
    Boolean,
    InstanceSwap,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Property {
    pub name: String,
    pub kind: PropertyKind,
    pub target_key: String,
    pub default_value: Value,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Slot {
    pub name: String,
    pub target_key: String,
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Component {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub slots: BTreeMap<String, Slot>,
    pub variants: BTreeMap<String, String>,
    pub properties: BTreeMap<String, Property>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slot_contents: BTreeMap<String, Vec<String>>,
    pub component_id: String,
    #[serde(default)]
    pub overrides: Overrides,
    #[serde(default)]
    pub property_values: BTreeMap<String, Value>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub owner: String,
    pub key: String,
    pub source: String,
}
pub fn is_false(v: &bool) -> bool {
    !*v
}
pub fn has_components(d: &Document) -> bool {
    d.nodes.values().any(|n| {
        n.component.is_some()
            || n.instance.is_some()
            || n.instance_origin.is_some()
            || n.component_set
    })
}
pub const FIELDS: &[&str] = &[
    "variableModes",
    "bindings",
    "styleRefs",
    "booleanOperation",
    "maskType",
    "name",
    "text",
    "fontSize",
    "textStyle",
    "textRuns",
    "visible",
    "locked",
    "opacity",
    "fills",
    "strokes",
    "effects",
    "radii",
    "smoothing",
    "arc",
    "cornerRadius",
    "constrainProportions",
    "exportSettings",
    "width",
    "height",
    "transform",
    "layout",
    "sizing",
    "constraints",
    "network",
    "points",
    "innerRadius",
    "clip",
    "mask",
];
fn valid_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 4096
        && !matches!(s, "__proto__" | "constructor" | "prototype")
        && !s.chars().any(char::is_control)
}
fn key(n: &Node) -> &str {
    n.component_key.as_deref().unwrap_or(&n.id)
}
fn qualify(prefix: &str, local: &str) -> String {
    if local == "$root" {
        if prefix.is_empty() {
            "$root".into()
        } else {
            prefix.into()
        }
    } else if prefix.is_empty() {
        local.into()
    } else {
        format!("{prefix}/{local}")
    }
}
fn template_nodes(d: &Document, root: &str) -> Result<BTreeMap<String, String>, String> {
    fn walk(
        d: &Document,
        id: &str,
        is_root: bool,
        keys: &mut BTreeMap<String, String>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("Component template depth exceeded".into());
        }
        let n = d.nodes.get(id).ok_or("Missing component node")?;
        if !is_root && (n.component.is_some() || n.component_set) {
            return Err("Use an instance when nesting components".into());
        }
        let k = if is_root { "$root" } else { key(n) };
        if !valid_key(k) || (!is_root && k == "$root") || keys.insert(k.into(), id.into()).is_some()
        {
            return Err("Duplicate or invalid component layer key".into());
        }
        if n.instance.is_none() {
            for c in &n.children {
                walk(d, c, false, keys, depth + 1)?
            }
        }
        Ok(())
    }
    let mut keys = BTreeMap::new();
    walk(d, root, true, &mut keys, 0)?;
    Ok(keys)
}
fn property_value(d: &Document, p: &Property, v: &Value) -> bool {
    match p.kind {
        PropertyKind::Text => v.as_str().is_some_and(|s| s.len() <= 400000),
        PropertyKind::Boolean => v.is_boolean(),
        PropertyKind::InstanceSwap => v
            .as_str()
            .is_some_and(|id| d.nodes.get(id).is_some_and(|n| n.component.is_some())),
    }
}
fn validate_instance(d: &Document, i: &Instance) -> Result<(), String> {
    if d.nodes
        .get(&i.component_id)
        .is_none_or(|n| n.component.is_none())
    {
        return Err(
            "Missing main component; detach instances before removing its definition".into(),
        );
    }
    if i.overrides.len() > 2048 || i.property_values.len() > 256 {
        return Err("Instance override budget exceeded".into());
    }
    for (k, fields) in &i.overrides {
        if !valid_key(k) || fields.len() > 32 {
            return Err("Invalid instance override path".into());
        }
        for (field, value) in fields {
            if !FIELDS.contains(&field.as_str())
                && !matches!(field.as_str(), "swapComponent" | "propertyValues")
            {
                return Err("Instance structural overrides are not allowed".into());
            }
            if field == "swapComponent"
                && value
                    .as_str()
                    .is_none_or(|id| d.nodes.get(id).is_none_or(|n| n.component.is_none()))
            {
                return Err("Invalid nested component reference".into());
            }
            if field == "propertyValues" && value.as_object().is_none_or(|m| m.len() > 256) {
                return Err("Invalid nested property values".into());
            }
        }
    }
    let props = &d.nodes[&i.component_id]
        .component
        .as_ref()
        .unwrap()
        .properties;
    for (k, v) in &i.property_values {
        if !valid_key(k) || props.get(k).is_some_and(|p| !property_value(d, p, v)) {
            return Err("Invalid instance property value".into());
        }
    }
    Ok(())
}
/// Slot content remains an authored, uniquely owned part of the visible layer tree.
fn slot_owned_nodes(d: &Document) -> Result<BTreeSet<String>, String> {
    let parents: BTreeMap<_, _> = d.nodes.values().flat_map(|n| n.children.iter().map(move |id| (id.as_str(), n.id.as_str()))).collect();
    let mut owned = BTreeSet::new();
    fn walk(d: &Document, id: &str, owned: &mut BTreeSet<String>, depth: usize) -> Result<(), String> {
        if depth > 64 || !owned.insert(id.into()) { return Err("Cyclic, overlapping, or oversized slot content".into()); }
        let n = d.nodes.get(id).ok_or("Missing slot content node")?;
        if n.component.is_some() || n.component_set { return Err("Slot content cannot own main components".into()); }
        for child in &n.children { walk(d, child, owned, depth + 1)?; }
        Ok(())
    }
    for n in d.nodes.values().filter(|n| n.instance.as_ref().is_some_and(|i| !i.slot_contents.is_empty())) {
        let spec = n.instance.as_ref().unwrap();
        if n.instance_origin.is_some() || spec.slot_contents.len() > 128 { return Err("Invalid slot content owner".into()); }
        let mut ancestor = parents.get(n.id.as_str()).copied();
        let mut ancestry = BTreeSet::new();
        while let Some(id) = ancestor {
            if ancestry.len() >= 64 || !ancestry.insert(id) { return Err("Cyclic slot ancestry".into()); }
            if d.nodes[id].component.is_some() { return Err("Authored slot assignments inside definitions are unsupported".into()); }
            ancestor = parents.get(id).copied();
        }
        let c = d.nodes.get(&spec.component_id).and_then(|n| n.component.as_ref()).ok_or("Missing slot component")?;
        for (slot_id, roots) in &spec.slot_contents {
            let slot = c.slots.get(slot_id).ok_or("Assigned slot was removed; reset or detach before removing it")?;
            for id in roots {
                let content = d.nodes.get(id).ok_or("Missing slot content node")?;
                let host = parents.get(id.as_str()).and_then(|p| d.nodes.get(*p)).and_then(|p| p.instance_origin.as_ref());
                if content.instance_origin.is_some() || host.is_none_or(|o| o.owner != n.id || o.key != slot.target_key) { return Err("Slot content escaped its owning instance".into()); }
                walk(d, id, &mut owned, 0)?;
            }
        }
    }
    Ok(owned)
}
pub fn validate(d: &Document) -> Result<(), String> {
    if !has_components(d) {
        return Ok(());
    }
    let _owned = slot_owned_nodes(d)?;
    let parents: BTreeMap<_, _> = d
        .nodes
        .values()
        .flat_map(|n| {
            n.children
                .iter()
                .map(move |id| (id.as_str(), n.id.as_str()))
        })
        .collect();
    for n in d.nodes.values() {
        if n.component.is_some() || n.component_set {
            if !matches!(n.kind.as_str(), "frame" | "group" | "section")
                || n.instance.is_some()
                || n.instance_origin.is_some()
                || (n.component_set && n.component.is_some())
            {
                return Err("Invalid component container".into());
            }
            let mut p = parents.get(n.id.as_str()).copied();
            while let Some(id) = p {
                let parent = &d.nodes[id];
                if parent.instance.is_some() || parent.component.is_some() {
                    return Err("Main components cannot be nested; insert an instance".into());
                }
                p = parents.get(id).copied();
            }
        }
        if let Some(c) = &n.component {
            if c.variants.len() > 16
                || c.properties.len() > 128
                || c.variants.iter().any(|(k, v)| {
                    !valid_key(k)
                        || k.trim().is_empty()
                        || k.len() > 128
                        || v.trim().is_empty()
                        || v.len() > 128
                })
            {
                return Err("Invalid component properties".into());
            }
            let keys = template_nodes(d, &n.id)?;
            if c.slots.len() > 128 { return Err("Slot declaration budget exceeded".into()); }
            let mut slot_names = BTreeSet::new();
            let mut slot_targets = BTreeSet::new();
            for (id, slot) in &c.slots {
                let target = keys.get(&slot.target_key).and_then(|id| d.nodes.get(id)).ok_or("Missing slot target")?;
                if !valid_key(id) || id.len() > 128 || !valid_key(&slot.name) || slot.name.trim().is_empty() || slot.name.len() > 128 || slot.target_key == "$root" || !slot_names.insert(&slot.name) || !slot_targets.insert(&slot.target_key) || !matches!(target.kind.as_str(), "frame" | "group" | "section") || target.instance.is_some() { return Err("Invalid content slot declaration".into()); }
            }
            for target in &slot_targets {
                let mut parent = parents.get(keys[*target].as_str()).copied();
                while let Some(id) = parent {
                    if slot_targets.contains(&key(&d.nodes[id]).to_string()) { return Err("Nested slot declarations are not supported".into()); }
                    parent = parents.get(id).copied();
                }
            }
            let mut names = BTreeSet::new();
            let mut bindings = BTreeSet::new();
            for (id, p) in &c.properties {
                let target = keys
                    .get(&p.target_key)
                    .and_then(|id| d.nodes.get(id))
                    .ok_or("Property target is missing from component")?;
                if !valid_key(id)
                    || p.name.trim().is_empty()
                    || p.name.len() > 128
                    || !names.insert(&p.name)
                    || !bindings.insert((&p.target_key, format!("{:?}", p.kind)))
                    || !property_value(d, p, &p.default_value)
                    || p.target_key == "$root"
                {
                    return Err("Invalid component property binding".into());
                }
                if (p.kind == PropertyKind::Text && target.kind != "text")
                    || (p.kind == PropertyKind::InstanceSwap && target.instance.is_none())
                {
                    return Err("Component property type does not match its layer".into());
                }
            }
        }
        if n.component_set {
            let mut combinations = BTreeSet::new();
            let mut axes: Option<Vec<String>> = None;
            for id in &n.children {
                let c = d.nodes[id]
                    .component
                    .as_ref()
                    .ok_or("Component sets may contain only main components")?;
                let keys: Vec<_> = c.variants.keys().cloned().collect();
                if keys.is_empty()
                    || axes.as_ref().is_some_and(|a| a != &keys)
                    || !combinations.insert(serde_json::to_string(&c.variants).unwrap())
                {
                    return Err("Variant combinations must be unique and use the same axes".into());
                }
                axes = Some(keys)
            }
        }
        if let Some(i) = &n.instance {
            validate_instance(d, i)?
        }
        if let Some(o) = &n.instance_origin {
            if !valid_key(&o.key)
                || !d
                    .nodes
                    .get(&o.owner)
                    .is_some_and(|n| n.instance.is_some() && n.instance_origin.is_none())
            {
                return Err("Invalid instance layer owner".into());
            }
            let mut p = parents.get(n.id.as_str()).copied();
            let mut found = false;
            while let Some(id) = p {
                if id == o.owner {
                    found = true;
                    break;
                }
                p = parents.get(id).copied();
            }
            if !found {
                return Err("Instance layer escaped its owning instance".into());
            }
        }
    }
    // References are a second graph, separate from the acyclic layer tree.
    fn visit(
        d: &Document,
        id: &str,
        visiting: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if visiting.len() >= 32 || !visiting.insert(id.into()) {
            return Err("Cyclic component dependency".into());
        }
        let keys = template_nodes(d, id)?;
        for node in keys.values() {
            if let Some(i) = &d.nodes[node].instance {
                visit(d, &i.component_id, visiting, done)?
            }
        }
        for p in d.nodes[id].component.as_ref().unwrap().properties.values() {
            if p.kind == PropertyKind::InstanceSwap {
                visit(d, p.default_value.as_str().unwrap(), visiting, done)?
            }
        }
        visiting.remove(id);
        done.insert(id.into());
        Ok(())
    }
    let mut done = BTreeSet::new();
    for n in d.nodes.values().filter(|n| n.component.is_some()) {
        visit(d, &n.id, &mut BTreeSet::new(), &mut done)?
    }
    Ok(())
}
fn generated_id(owner: &str, path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"forma.instance.v1\0");
    hash.update(owner.as_bytes());
    hash.update([0]);
    hash.update(path.as_bytes());
    let mut bytes = hash.finalize();
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    let h: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
fn apply_fields(n: &mut Node, fields: Option<&BTreeMap<String, Value>>) -> Result<(), String> {
    if let Some(fields) = fields {
        let mut value = serde_json::to_value(&*n).map_err(|e| e.to_string())?;
        let object = value.as_object_mut().unwrap();
        for (k, v) in fields {
            if FIELDS.contains(&k.as_str()) {
                object.insert(k.clone(), v.clone());
            }
        }
        let mut next =
            serde_json::from_value(value).map_err(|e| format!("Invalid instance override: {e}"))?;
        crate::mutation::reconcile(
            n,
            &mut next,
            fields.contains_key("network"),
            fields.contains_key("textRuns"),
        );
        *n = next;
    }
    Ok(())
}
fn merge(into: &mut Overrides, from: &Overrides) {
    for (k, v) in from {
        into.entry(k.clone()).or_default().extend(v.clone());
    }
}
fn bound_overrides(
    d: &Document,
    component: &Component,
    values: &BTreeMap<String, Value>,
    prefix: &str,
) -> Result<Overrides, String> {
    let mut result = Overrides::new();
    for (id, p) in &component.properties {
        let v = values.get(id).unwrap_or(&p.default_value);
        if !property_value(d, p, v) {
            return Err("Invalid component property value".into());
        }
        let field = match p.kind {
            PropertyKind::Text => "text",
            PropertyKind::Boolean => "visible",
            PropertyKind::InstanceSwap => "swapComponent",
        };
        result
            .entry(qualify(prefix, &p.target_key))
            .or_default()
            .insert(field.into(), v.clone());
    }
    Ok(result)
}
struct LayerContext<'a> {
    depth: usize,
    modes: &'a Modes,
}
struct Builder<'a> {
    source: &'a Document,
    output: BTreeMap<String, Node>,
    owner: String,
    stack: Vec<String>,
    budget: usize,
    remaining_bytes: usize,
    slots: BTreeMap<String, Vec<String>>,
}
impl Builder<'_> {
    fn authored(&mut self, id: &str, depth: usize, modes: &Modes) -> Result<String, String> {
        if depth > 64 { return Err("Slot content depth exceeded".into()); }
        let mut n = self.source.nodes.get(id).ok_or("Missing slot content")?.clone();
        if let Some(spec) = n.instance.clone() {
            let previous_owner = std::mem::replace(&mut self.owner, id.into());
            let result = self.instance(&n, &spec, "", &Overrides::new(), (id.into(), None), LayerContext {depth, modes});
            self.owner = previous_owner;
            return result;
        }
        let effective = self.apply_overrides(&mut n, None, modes)?;
        n.children.clear();
        for child in &self.source.nodes[id].children { n.children.push(self.authored(child, depth + 1, &effective)?); }
        self.insert(n)
    }
    fn apply_overrides(
        &self,
        n: &mut Node,
        fields: Option<&BTreeMap<String, Value>>,
        inherited_modes: &Modes,
    ) -> Result<Modes, String> {
        apply_fields(n, fields)?;
        let modes = inherited_modes.with(&n.variable_modes);
        // Every materialization must resolve in its own effective ancestry,
        // even when its references did not change. Explicit fields/component
        // property values still win over bindings and shared styles.
        crate::design_system::resolve_node(
            self.source.design_system.as_ref(),
            n,
            &modes,
            |field| fields.is_some_and(|fields| fields.contains_key(field)),
        )?;
        Ok(modes)
    }
    fn insert(&mut self, n: Node) -> Result<String, String> {
        let bytes = encoded_len(&n, self.remaining_bytes)?.saturating_add(n.id.len() + 4);
        self.remaining_bytes = self
            .remaining_bytes
            .checked_sub(bytes)
            .ok_or("Expanded component document exceeds 32 MiB")?;
        if self.output.len() >= self.budget || self.output.insert(n.id.clone(), n.clone()).is_some()
        {
            return Err("Instance expansion exceeds budget or has duplicate layer keys".into());
        }
        Ok(n.id)
    }
    fn instance(
        &mut self,
        placement: &Node,
        spec: &Instance,
        prefix: &str,
        outer: &Overrides,
        target: (String, Option<Origin>),
        context: LayerContext<'_>,
    ) -> Result<String, String> {
        let LayerContext {
            depth,
            modes: inherited_modes,
        } = context;
        if depth > 64 || self.stack.len() >= 32 || self.stack.contains(&spec.component_id) {
            return Err("Cyclic or oversized instance expansion".into());
        }
        let (root_id, origin) = target;
        let template = self
            .source
            .nodes
            .get(&spec.component_id)
            .ok_or("Missing main component")?;
        let component = template
            .component
            .as_ref()
            .ok_or("Instance target is not a component")?;
        let mut actual = spec.clone();
        if let Some(values) = outer
            .get(&qualify(prefix, "$root"))
            .and_then(|f| f.get("propertyValues"))
        {
            actual.property_values.extend(
                serde_json::from_value::<BTreeMap<String, Value>>(values.clone())
                    .map_err(|e| e.to_string())?,
            )
        }
        let mut overrides =
            bound_overrides(self.source, component, &actual.property_values, prefix)?;
        let local: Overrides = actual
            .overrides
            .iter()
            .map(|(k, v)| (qualify(prefix, k), v.clone()))
            .collect();
        merge(&mut overrides, &local);
        merge(&mut overrides, outer);
        for (id, roots) in &actual.slot_contents {
            let slot = component.slots.get(id).ok_or("Unknown content slot")?;
            self.slots.insert(qualify(prefix, &slot.target_key), roots.clone());
        }
        let mut n = template.clone();
        n.variable_modes.extend(placement.variable_modes.clone());
        let modes = self.apply_overrides(
            &mut n,
            overrides.get(&qualify(prefix, "$root")),
            inherited_modes,
        )?;
        // A materialized outer root doubles as the authored placement on the
        // next edit/reload. Never bake template defaults or root overrides into
        // its local mode map: clearing an override must restore inheritance.
        if origin.is_none() {
            n.variable_modes = placement.variable_modes.clone();
        }
        n.id = root_id;
        n.name = overrides
            .get(&qualify(prefix, "$root"))
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&template.name)
            .into();
        n.transform = placement.transform;
        let mut visible_placement = placement.clone();
        crate::design_system::resolve_node(
            self.source.design_system.as_ref(),
            &mut visible_placement,
            &modes,
            |field| {
                field != "visible"
                    || overrides
                        .get(&qualify(prefix, "$root"))
                        .is_some_and(|f| f.contains_key("visible"))
            },
        )?;
        n.visible = visible_placement.visible;
        // Visibility belongs to the placement, unlike the template's geometry
        // and paint. Retain its authored binding so a later mode edit/reload can
        // reevaluate it, rather than persisting the previous resolved boolean.
        n.bindings.remove("visible");
        if let Some(binding) = placement.bindings.get("visible") {
            n.bindings.insert("visible".into(), binding.clone());
        }
        n.locked = placement.locked;
        n.constraints = placement.constraints.clone();
        n.component = None;
        n.component_set = false;
        n.component_key = if origin.is_none() {
            placement.component_key.clone()
        } else {
            None
        };
        n.instance = Some(actual);
        n.instance_origin = origin;
        n.children.clear();
        self.stack.push(spec.component_id.clone());
        for id in &template.children {
            n.children
                .push(self.layer(id, prefix, &overrides, depth + 1, &modes)?)
        }
        self.stack.pop();
        self.insert(n)
    }
    fn layer(
        &mut self,
        id: &str,
        prefix: &str,
        overrides: &Overrides,
        depth: usize,
        inherited_modes: &Modes,
    ) -> Result<String, String> {
        if depth > 64 {
            return Err("Instance layer depth exceeded".into());
        }
        let template = &self.source.nodes[id];
        let path = qualify(prefix, key(template));
        let new_id = generated_id(&self.owner, &path);
        let origin = Origin {
            owner: self.owner.clone(),
            key: path.clone(),
            source: id.into(),
        };
        let mut n = template.clone();
        if let Some(mut spec) = template.instance.clone() {
            // A nested placement is not its effective component root. Resolve
            // references in instance() against the selected main component.
            apply_fields(&mut n, overrides.get(&path))?;
            if let Some(target) = overrides
                .get(&path)
                .and_then(|o| o.get("swapComponent"))
                .and_then(Value::as_str)
            {
                spec.component_id = target.into();
            }
            return self.instance(
                &n,
                &spec,
                &path,
                overrides,
                (new_id, Some(origin)),
                LayerContext {
                    depth,
                    modes: inherited_modes,
                },
            );
        }
        let modes = self.apply_overrides(&mut n, overrides.get(&path), inherited_modes)?;
        n.id = new_id;
        n.component = None;
        n.component_set = false;
        n.component_key = None;
        n.instance_origin = Some(origin);
        n.children.clear();
        if let Some(roots) = self.slots.get(&path).cloned() {
            for child in roots { n.children.push(self.authored(&child, depth + 1, &modes)?); }
        } else {
            for child in &template.children {
                n.children.push(self.layer(child, prefix, overrides, depth + 1, &modes)?)
            }
        }
        if n.boolean_operation.is_some() {
            crate::mutation::resize_boolean_children(
                &mut self.output,
                &n.children,
                n.width / template.width,
                n.height / template.height,
            );
        }
        self.insert(n)
    }
}
pub fn resolve(doc: &mut Document) -> Result<(), String> {
    if !has_components(doc) {
        return Ok(());
    }
    validate(doc)?;
    let mut source = Cow::Borrowed(&*doc);
    // Definition defaults modify authored targets. Nested properties stay on their
    // nested component; a containing definition exposes a swap on the nested root.
    let definitions: Vec<_> = source
        .nodes
        .values()
        .filter(|n| n.component.as_ref().is_some_and(|c| !c.properties.is_empty()))
        .map(|n| n.id.clone())
        .collect();
    for id in definitions {
        let keys = template_nodes(&source, &id)?;
        let properties = source.nodes[&id]
            .component
            .as_ref()
            .unwrap()
            .properties
            .clone();
        for p in properties.values() {
            let n = source.to_mut().nodes.get_mut(&keys[&p.target_key]).unwrap();
            match p.kind {
                PropertyKind::Text => {
                    crate::mutation::replace_text(n, p.default_value.as_str().unwrap().into())
                }
                PropertyKind::Boolean => n.visible = p.default_value.as_bool().unwrap(),
                PropertyKind::InstanceSwap => {
                    n.instance.as_mut().unwrap().component_id =
                        p.default_value.as_str().unwrap().into()
                }
            }
        }
    }
    if matches!(source, Cow::Owned(_)) { validate(&source)?; }
    let owned = slot_owned_nodes(&source)?;
    let roots: Vec<_> = source
        .nodes
        .values()
        .filter(|n| n.instance.is_some() && n.instance_origin.is_none() && !owned.contains(&n.id))
        .map(|n| n.id.clone())
        .collect();
    let inherited_modes = crate::design_system::node_mode_contexts(&source)?;
    let mut bytes = encoded_len(source.as_ref(), DOCUMENT_BYTES)?;
    // Builders always read the immutable source. The result owns only rebuilt
    // nodes, so unrelated images, paths, text and metadata are never deep-cloned.
    // Do not publish either removals or replacements until every check succeeds.
    let mut result: BTreeMap<_, _> = source.nodes.iter()
        .map(|(id, node)| (id.clone(), Cow::Borrowed(node))).collect();
    for id in roots {
        let mut removed = Vec::new();
        fn descendants(nodes: &BTreeMap<String, Cow<'_, Node>>, id: &str, out: &mut Vec<String>) {
            for child in &nodes[id].children {
                descendants(nodes, child, out);
                out.push(child.clone());
            }
        }
        descendants(&result, &id, &mut removed);
        for child in removed {
            if let Some(n) = result.remove(&child) {
                bytes = bytes.saturating_sub(encoded_len(&n, DOCUMENT_BYTES)? + child.len() + 4);
            }
        }
        let placement = &source.nodes[&id];
        bytes =
            bytes.saturating_sub(encoded_len(&result[&id], DOCUMENT_BYTES)? + id.len() + 4);
        let mut builder = Builder {
            source: &source,
            output: BTreeMap::new(),
            owner: id.clone(),
            stack: Vec::new(),
            budget: 20001usize.saturating_sub(result.len()),
            remaining_bytes: DOCUMENT_BYTES.saturating_sub(bytes),
            slots: BTreeMap::new(),
        };
        builder.instance(
            placement,
            placement.instance.as_ref().unwrap(),
            "",
            &Overrides::new(),
            (id.clone(), None),
            LayerContext {
                depth: 0,
                modes: &inherited_modes[&id].inherited,
            },
        )?;
        bytes = DOCUMENT_BYTES - builder.remaining_bytes;
        for (key, n) in builder.output {
            if key != id && result.contains_key(&key) {
                return Err("Generated instance layer collides with an authored layer".into());
            }
            result.insert(key, Cow::Owned(n));
        }
    }
    encoded_len(&ResolvedDocument { document: &source, nodes: &result }, DOCUMENT_BYTES)?;
    let removed: Vec<_> = source.nodes.keys().filter(|id| !result.contains_key(*id)).cloned().collect();
    let replacements: Vec<_> = result.into_iter().filter_map(|(id, node)| match node {
        Cow::Owned(node) => Some((id, node)),
        Cow::Borrowed(_) => None,
    }).collect();
    // Definition defaults can own a modified source; ordinary documents keep
    // their original allocation. All remaining operations are infallible map
    // publication, after the source/result read borrows have ended.
    if let Cow::Owned(source) = source { *doc = source; }
    for id in removed { doc.nodes.remove(&id); }
    doc.nodes.extend(replacements);
    Ok(())
}
#[derive(Serialize)]
pub struct Changes {
    nodes: BTreeMap<String, Node>,
    removed: Vec<String>,
}
pub fn changes(json: &str, fonts: &Fonts) -> Result<String, String> {
    if json.len() > 32 * 1024 * 1024 {
        return Err("Document exceeds 32 MB".into());
    }
    let mut doc: Document = serde_json::from_str(json).map_err(|e| e.to_string())?;
    doc.validate()?;
    let before = doc.clone();
    crate::design_system::resolve_authored(&mut doc)?;
    resolve(&mut doc)?;
    let fonts = fonts.with_resources(&doc.fonts)?;
    layout::resolve(&mut doc, &fonts)?;
    crate::curve_boolean::resolve(&mut doc)?;
    check_budget(&doc)?;
    doc.validate()?;
    let changes = Changes {
        nodes: doc
            .nodes
            .iter()
            .filter(|(id, n)| before.nodes.get(*id) != Some(n))
            .map(|(id, n)| (id.clone(), n.clone()))
            .collect(),
        removed: before
            .nodes
            .keys()
            .filter(|id| !doc.nodes.contains_key(*id))
            .cloned()
            .collect(),
    };
    serde_json::to_string(&changes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod resolved_document_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn borrowed_result_view_serializes_exact_document_bytes_and_budget_boundaries() {
        let source: Document = serde_json::from_value(json!({
            "schemaVersion":15, "id":"d", "name":"metadata \\ \" 😀",
            "fdCompatibility":{"contractVersion":1,"requiredCapabilities":[],"extensions":{
                "test.snapshot":{"nodes":{"keep":"metadata, not the scene node map"},"value":-0.0}
            }},
            "designSystem":{},
            "pages":[{"id":"p","name":"Page","background":"#ffffff","children":["stay","old","replace"]}],
            "nodes":{
                "stay":{"id":"stay","kind":"rectangle","width":10,"height":20,"text":"unchanged"},
                "old":{"id":"old","kind":"rectangle","width":10,"height":20},
                "replace":{"id":"replace","kind":"text","width":10,"height":20,"text":"old text"}
            }
        })).unwrap();
        let before = source.clone();
        let mut nodes: BTreeMap<_, _> = source.nodes.iter()
            .map(|(id, node)| (id.clone(), Cow::Borrowed(node))).collect();
        nodes.remove("old");
        let mut changed = source.nodes["replace"].clone();
        changed.text = "new text, with \\ \" and 中文".into();
        nodes.insert(changed.id.clone(), Cow::Owned(changed));
        let mut added = source.nodes["old"].clone();
        added.id = "new\\\"😀".into();
        nodes.insert(added.id.clone(), Cow::Owned(added));
        for empty in [false, true] {
            if empty { nodes.clear(); }
            let view = ResolvedDocument { document: &source, nodes: &nodes };
            let mut materialized = source.clone();
            materialized.nodes = nodes.iter().map(|(id, node)| (id.clone(), node.as_ref().clone())).collect();
            let expected = serde_json::to_vec(&materialized).unwrap();
            assert_eq!(serde_json::to_vec(&view).unwrap(), expected);
            assert_eq!(encoded_len(&view, expected.len()).unwrap(), expected.len());
            assert!(encoded_len(&view, expected.len() - 1).is_err());
        }
        assert_eq!(source, before, "serializing staged replacements never modifies the read source");
    }
}
